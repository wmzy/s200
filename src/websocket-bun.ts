/**
 * Bun adapter for `s200/websocket`: turns the app's WebSocket registry
 * into Bun.serve's `websocket` option plus an upgrade decision, passed
 * through `s200/bun`'s `serve`:
 *
 * ```ts
 * import { serve } from 's200/bun';
 * import { upgradeWebSocket } from 's200/websocket';
 * import { createBunWebSocketBridge } from 's200/websocket/bun';
 *
 * const app = createApp();
 * upgradeWebSocket(app, '/chat', (socket, ctx) => { … });
 * const server = serve(app, { port: 3000, websocket: createBunWebSocketBridge(app) });
 * ```
 *
 * Bun implements the protocol; this module only routes upgrades and maps
 * Bun's per-connection callbacks onto the {@link WsSocket} surface.
 *
 * @module
 */

import type { App } from './app';
import type { Ctx } from './types';

import {
  createWsSession,
  createWsSocket,
  decideUpgrade,
  reportHandlerError,
  runWsHandler,
  type WebSocketHandler,
  type WsSession,
} from './websocket';

/** The `server` Bun hands its `fetch` handler — the upgrade authority. */
export type BunUpgrader = {
  upgrade(
    request: Request,
    options?: { data?: unknown; headers?: Record<string, string> }
  ): boolean;
};

/** Bun's per-connection socket, narrowed to the members used. */
export type BunWs = {
  send(data: string | Uint8Array): void;
  close(code: number, reason: string): void;
  ping(data?: string | Uint8Array): void;
  /** Bytes queued for the peer but not yet on the wire — Bun's live
   * per-connection backlog counter. */
  getBufferedAmount(): number;
};

/**
 * Bun's per-connection callbacks — the `websocket` option Bun.serve
 * accepts, narrowed to the members s200 uses. This is the canonical
 * declaration: `s200/bun`'s ambient Bun surface types against it (a
 * type-only import, so no @types/bun dependency sneaks in there either).
 */
export type BunWsHandlers = {
  open?: (ws: BunWs) => void;
  message?: (ws: BunWs, data: string | Uint8Array) => void;
  close?: (ws: BunWs, code: number, reason: string) => void;
  /** Bun's send-queue-drained signal (backpressure relief). The bridge
   * itself registers none; the slot exists because Bun.serve accepts it
   * and the canonical shape must cover what any consumer can pass. */
  drain?: (ws: BunWs) => void;
  pong?: (ws: BunWs) => void;
};

/**
 * The two halves `s200/bun`'s `serve` consumes: `upgrade` decides (inside
 * the fetch handler) whether the request becomes a WebSocket — `true`
 * means upgraded, a `Response` is a middleware rejection answered as
 * plain HTTP, `false` falls through to the HTTP handler — and `websocket`
 * carries the per-connection callbacks for Bun.serve.
 */
export type BunWebSocketBridge = {
  readonly upgrade: (
    req: Request,
    server: BunUpgrader
  ) => Promise<boolean | Response>;
  readonly websocket: BunWsHandlers;
};

/** The per-upgrade record carried through Bun's ws.data to `open`. */
type UpgradePayload = {
  readonly route: { readonly handler: WebSocketHandler };
  /** The ctx the middleware decision built — `state` mutations from the
   * chain ride into the handler through it. */
  readonly ctx: Ctx;
  readonly protocol?: string;
};

/**
 * Builds the bridge for `s200/bun`'s `serve({ websocket })`. Requests that
 * match a registered WebSocket route upgrade after the app + route
 * middleware chain approves (a rejecting middleware's Response is
 * returned as plain HTTP instead); everything else falls through to the
 * HTTP handler. The matched handler runs when the connection opens; its
 * listeners receive Bun's message/close events.
 */
export function createBunWebSocketBridge(app: App): BunWebSocketBridge {
  const sessions = new Map<BunWs, WsSession>();

  const upgrade = async (
    req: Request,
    server: BunUpgrader
  ): Promise<boolean | Response> => {
    // The shared decision chain (websocket.ts's decideUpgrade): route
    // match, middleware verdict, subprotocol negotiation. undefined = no
    // ws route → the fetch handler's HTTP path; a rejection Response is
    // answered as plain HTTP.
    const decision = await decideUpgrade(app, req);
    if (decision === undefined) {
      return false;
    }
    if (!decision.ok) {
      return decision.response;
    }
    // The data record reaches `open` via Bun's ws.data.
    return server.upgrade(req, {
      data: { route: decision.route, ctx: decision.ctx, protocol: decision.protocol },
      headers:
        decision.protocol === undefined
          ? undefined
          : { 'sec-websocket-protocol': decision.protocol },
    });
  };

  const websocket: BunWsHandlers = {
    open(ws) {
      const payload = (ws as BunWs & { data?: unknown }).data as
        | UpgradePayload
        | undefined;
      if (payload === undefined) return;
      const session = createWsSession();
      sessions.set(ws, session);
      const close = (code: number, reason: string): void => ws.close(code, reason);
      // The transport closures carry Bun's specifics: send takes
      // string|Uint8Array (an ArrayBuffer needs the view), ping passes
      // through, and the live backlog counter is a getter call; the rest
      // of the socket API is the shared factory's.
      const socket = createWsSocket(session, payload.protocol, {
        send: (data) =>
          ws.send(data instanceof ArrayBuffer ? new Uint8Array(data) : data),
        close,
        ping: (pingData) => ws.ping(pingData),
        bufferedAmount: () => ws.getBufferedAmount(),
      });
      runWsHandler(payload.route.handler, socket, payload.ctx, session, close);
    },
    message(ws, data) {
      const session = sessions.get(ws);
      if (session === undefined) return;
      // A callback that throws fans out through the shared contract —
      // onError + close 1011 — instead of escaping into Bun's event
      // delivery (the same containment the node adapter applies).
      for (const cb of session.onMessage) {
        try {
          cb(data);
        } catch (error) {
          reportHandlerError(error, session, (code, reason) =>
            ws.close(code, reason)
          );
          return;
        }
      }
    },
    close(ws, code, reason) {
      const session = sessions.get(ws);
      sessions.delete(ws);
      if (session === undefined) return;
      for (const cb of session.onClose) cb(code, reason);
    },
    pong(ws) {
      const session = sessions.get(ws);
      if (session === undefined) return;
      for (const cb of session.onPong) cb();
    },
  };

  return { upgrade, websocket };
}
