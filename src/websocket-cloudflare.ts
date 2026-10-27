/**
 * Cloudflare Workers adapter for `s200/websocket`: composes with
 * `s200/cloudflare`'s `createHandler` — the bridge answers WebSocket
 * handshake requests, everything else falls through to the HTTP fetch:
 *
 * ```ts
 * import { createHandler } from 's200/cloudflare';
 * import { upgradeWebSocket } from 's200/websocket';
 * import { createCloudflareWebSocketBridge } from 's200/websocket/cloudflare';
 *
 * const app = createApp();
 * upgradeWebSocket(app, '/chat/:room', (socket, ctx) => { … });
 * const ws = createCloudflareWebSocketBridge(app);
 * const worker = createHandler(app);
 *
 * export default {
 *   fetch: (request, env, ctx) =>
 *     ws.upgrade(request).then((res) => res ?? worker.fetch(request, env, ctx)),
 * };
 * ```
 *
 * Workerd implements the protocol; this module only routes upgrades (the
 * `new WebSocketPair()` + status 101 + `init.webSocket` idiom) and maps the
 * server half onto the {@link WsSocket} surface. There is no `serve` to
 * hand a bridge to on Workers — the `??` composition IS the integration,
 * mirroring what `s200/websocket/node` gets from `serve`'s `upgrade`
 * option and `s200/websocket/bun` from `serve`'s `websocket` option.
 *
 * @module
 */

import type { App } from './app';
import type { Ctx } from './types';

import {
  createWsSession,
  createWsSocket,
  matchWebSocket,
  negotiateProtocol,
  resolveUpgrade,
  runWsHandler,
  type WebSocketHandler,
  type WsData,
} from './websocket';

/** One half of a Workers `WebSocketPair`, narrowed to the members the
 * bridge uses (the server half adds `accept` — both halves share the
 * runtime type, so one shape covers the pair). */
export type CloudflareWebSocket = {
  /** Starts handling the connection — workerd dispatches events only
   * after this. The runtime auto-replies to close frames (2026-04-07+
   * compatibility dates), so no manual reciprocal close is needed. */
  accept(): void;
  send(data: WsData): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'message', listener: (event: { data: WsData }) => void): void;
  addEventListener(
    type: 'close',
    listener: (event: { code: number; reason: string }) => void
  ): void;
  // 'error' (and 'pong', when a runtime exposes it) ride the generic
  // signature — their event payloads have no guaranteed shape.
  addEventListener(type: string, listener: (event: unknown) => void): void;
  /** Bytes queued for the peer but unsent — workerd does not expose a
   * counter today; the bridge reports `0` unless the runtime grows one. */
  readonly bufferedAmount?: number;
  /** Workerd manages keep-alive itself; no ping API is exposed today —
   * the bridge forwards to it if the runtime grows one, else no-ops. */
  ping?(data?: string | Uint8Array): void;
};

/** The `new WebSocketPair()` value: the client half at `0` (the one the
 * 101 response hands back to the runtime), the server half at `1`. */
export type CloudflareWebSocketPair = {
  readonly 0: CloudflareWebSocket;
  readonly 1: CloudflareWebSocket;
};

// The Workers global, present only inside workerd runtimes. Declared, not
// imported, so the module loads anywhere (and resolves the global lazily
// inside `upgrade` — a non-Workers host gets a clean 501, not a crash).
declare const WebSocketPair: new () => CloudflareWebSocketPair;

/** The Workers half of the `??` composition: `upgrade(request)` answers a
 * WebSocket handshake — `undefined` means "not for this bridge" and the
 * request falls through to `createHandler(app)`'s HTTP fetch.
 */
export type CloudflareWebSocketBridge = {
  readonly upgrade: (request: Request) => Promise<Response | undefined>;
};

/**
 * Builds the bridge for a module worker's `fetch`. A request upgrades when
 * it carries `Upgrade: websocket` AND matches a registered WebSocket route
 * AND the app + route middleware chain approves (a rejecting middleware's
 * `Response` is answered as plain HTTP instead of `101`); everything else
 * falls through to the HTTP handler. The matched handler runs once the
 * response is returned; its listeners receive the socket's events.
 *
 * Subprotocol negotiation mirrors the node and bun adapters (server
 * preference order), and the negotiated protocol rides the 101 response's
 * `sec-websocket-protocol` header so the runtime completes the handshake.
 */
export function createCloudflareWebSocketBridge(app: App): CloudflareWebSocketBridge {
  const upgrade = async (request: Request): Promise<Response | undefined> => {
    // Only genuine handshake requests are ours: a plain GET to the same
    // path answers through the HTTP chain, like node's `'upgrade'` event
    // and Bun's `server.upgrade()` authority gate it upstream.
    const wanted = request.headers.get('upgrade');
    if (wanted === null || wanted.toLowerCase() !== 'websocket') {
      return undefined;
    }
    const url = new URL(request.url);
    const matched = matchWebSocket(app, url.pathname);
    if (matched === undefined) {
      return undefined;
    }
    // The chain decides first: a rejection Response is answered as plain
    // HTTP by the fetch handler; approval carries the chain-stamped ctx.
    const decision = await resolveUpgrade(app, matched.route, request, url, matched.params);
    if (!decision.ok) {
      return decision.response;
    }
    // Subprotocol negotiation (server preference order), shared with the
    // node and bun adapters through negotiateProtocol so every runtime
    // picks identically.
    const protocol = negotiateProtocol(
      request.headers.get('sec-websocket-protocol'),
      matched.route.protocols
    );
    let pair: CloudflareWebSocketPair;
    try {
      pair = new WebSocketPair();
    } catch {
      // The global is missing — this code path runs outside workerd. A
      // clean 501 beats a ReferenceError through the user's fetch handler.
      return new Response(
        'WebSocketPair is unavailable — WebSocket upgrades need the Cloudflare Workers runtime',
        { status: 501 },
      );
    }
    const client = pair[0];
    const server = pair[1];
    // Accept before wiring listeners: workerd dispatches socket events
    // only after accept.
    server.accept();
    runConnection(server, matched.route.handler, decision.ctx, protocol);
    const headers = new Headers();
    if (protocol !== undefined) {
      headers.set('sec-websocket-protocol', protocol);
    }
    return switchProtocols(client, headers);
  };
  return { upgrade };
}

/** Wires the server half onto the {@link WsSocket} surface and runs the
 * route handler (outside the middleware chain — its errors surface through
 * `onError` + close 1011, the shared bridge contract). */
function runConnection(
  server: CloudflareWebSocket,
  handler: WebSocketHandler,
  ctx: Ctx,
  protocol: string | undefined
): void {
  const session = createWsSession();
  const close = (code: number, reason: string): void => server.close(code, reason);
  // 'pong' is not a Workers event today (the runtime handles keep-alive) —
  // wire the listener lazily on first onPong registration so a runtime
  // that grows the event starts feeding callbacks without a bridge change.
  let pongWired = false;
  const subscribePong = (): void => {
    if (pongWired) {
      return;
    }
    pongWired = true;
    try {
      server.addEventListener('pong', () => {
        for (const cb of session.onPong) cb();
      });
    } catch {
      // A runtime rejecting the event type just never fires the callbacks.
    }
  };
  // The transport closures carry the workerd specifics: an optional ping
  // API, a bufferedAmount the runtime may not expose, and the lazy pong
  // subscription; the rest of the socket API is the shared factory's.
  const socket = createWsSocket(session, protocol, {
    send: (data) => server.send(data),
    close,
    ping: (payload) => {
      if (typeof server.ping === 'function') {
        server.ping(payload);
      }
    },
    bufferedAmount: () =>
      typeof server.bufferedAmount === 'number' ? server.bufferedAmount : 0,
    subscribePong,
  });
  server.addEventListener('message', (event) => {
    for (const cb of session.onMessage) cb(event.data);
  });
  server.addEventListener('close', (event) => {
    for (const cb of session.onClose) cb(event.code, event.reason);
  });
  server.addEventListener('error', (event) => {
    const error = event instanceof Error ? event : new Error('WebSocket error');
    for (const cb of session.onError) cb(error);
  });
  runWsHandler(handler, socket, ctx, session, close);
}

/** The 101 handshake response: workerd reads the client socket from the
 * non-standard `init.webSocket` extension. Spec-strict runtimes (undici's
 * node `Response`) reject `status: 101` outright — there the fallback
 * shadows `status` and `webSocket` onto a stand-in so CF-shaped hosts and
 * unit tests outside workerd still observe the exact decision. */
function switchProtocols(client: CloudflareWebSocket, headers: Headers): Response {
  try {
    return new Response(null, {
      status: 101,
      headers,
      webSocket: client,
    } as ResponseInit & { webSocket: CloudflareWebSocket });
  } catch {
    const standIn = new Response(null, { headers });
    Object.defineProperty(standIn, 'status', { value: 101 });
    Object.defineProperty(standIn, 'webSocket', { value: client });
    return standIn;
  }
}
