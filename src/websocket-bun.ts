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
import type { Params } from './types';

import {
  createWsCtx,
  matchWebSocket,
  type WebSocketHandler,
  type WsCloseCb,
  type WsData,
  type WsErrorCb,
  type WsMessageCb,
  type WsSocket,
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
};

/** The `websocket` option Bun.serve accepts, narrowed to the members used. */
export type BunWsHandlers = {
  open?: (ws: BunWs) => void;
  message?: (ws: BunWs, data: string | Uint8Array) => void;
  close?: (ws: BunWs, code: number, reason: string) => void;
  pong?: (ws: BunWs) => void;
};

/**
 * The two halves `s200/bun`'s `serve` consumes: `upgrade` decides (inside
 * the fetch handler) whether the request becomes a WebSocket, and
 * `websocket` carries the per-connection callbacks for Bun.serve.
 */
export type BunWebSocketBridge = {
  readonly upgrade: (req: Request, server: BunUpgrader) => boolean;
  readonly websocket: BunWsHandlers;
};

/** One live connection: the listener lists the {@link WsSocket} API writes. */
type BunSession = {
  readonly onMessage: WsMessageCb[];
  readonly onClose: WsCloseCb[];
  readonly onError: WsErrorCb[];
  readonly onPong: (() => void)[];
};

/** The per-upgrade record carried through Bun's ws.data to `open`. */
type UpgradePayload = {
  readonly route: { readonly handler: WebSocketHandler };
  readonly params: Params;
  readonly url: URL;
  readonly req: Request;
  readonly protocol?: string;
};

/**
 * Builds the bridge for `s200/bun`'s `serve({ websocket })`. Requests that
 * match a registered WebSocket route upgrade; everything else falls
 * through to the HTTP handler. The matched handler runs when the
 * connection opens; its listeners receive Bun's message/close events.
 */
export function createBunWebSocketBridge(app: App): BunWebSocketBridge {
  const sessions = new Map<BunWs, BunSession>();

  const upgrade = (req: Request, server: BunUpgrader): boolean => {
    const url = new URL(req.url);
    const matched = matchWebSocket(app, url.pathname);
    if (matched === undefined) {
      return false;
    }
    // Subprotocol negotiation (server preference order), mirrored from the
    // node adapter so both runtimes pick identically.
    const offered = req.headers.get('sec-websocket-protocol');
    const clientProtocols =
      offered === null
        ? []
        : offered.split(',').map((item) => item.trim()).filter((item) => item !== '');
    let protocol: string | undefined;
    for (const candidate of matched.route.protocols ?? []) {
      if (clientProtocols.includes(candidate)) {
        protocol = candidate;
        break;
      }
    }
    // The data record reaches `open` via Bun's ws.data.
    return server.upgrade(req, {
      data: { route: matched.route, params: matched.params, url, req, protocol },
      headers: protocol === undefined ? undefined : { 'sec-websocket-protocol': protocol },
    });
  };

  const websocket: BunWsHandlers = {
    open(ws) {
      const payload = (ws as BunWs & { data?: unknown }).data as
        | UpgradePayload
        | undefined;
      if (payload === undefined) return;
      const session: BunSession = { onMessage: [], onClose: [], onError: [], onPong: [] };
      sessions.set(ws, session);
      const socket: WsSocket = {
        send(data: WsData) {
          // Bun's send accepts string|Uint8Array; ArrayBuffer needs the view.
          ws.send(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
        },
        close(code, reason) {
          ws.close(code ?? 1000, reason ?? '');
        },
        protocol: payload.protocol,
        ping(payloadData) {
          ws.ping(payloadData);
        },
        onMessage(cb) {
          session.onMessage.push(cb);
        },
        onClose(cb) {
          session.onClose.push(cb);
        },
        onError(cb) {
          session.onError.push(cb);
        },
        onPong(cb) {
          session.onPong.push(cb);
        },
      };
      const ctx = createWsCtx(payload.req, payload.url, payload.params);
      void Promise.resolve()
        .then(() => payload.route.handler(socket, ctx))
        .catch((error: unknown) => {
          for (const cb of session.onError) {
            cb(error instanceof Error ? error : new Error(String(error)));
          }
          ws.close(1011, 'handler error');
        });
    },
    message(ws, data) {
      const session = sessions.get(ws);
      if (session === undefined) return;
      for (const cb of session.onMessage) cb(data);
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
