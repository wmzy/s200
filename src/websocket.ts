/**
 * WebSocket support in the `data + functions` shape: `upgradeWebSocket`
 * records `pattern → handler` routes on the app (pure data), and the
 * runtime adapters consult the registry when a connection upgrades:
 *
 * - node: `serve(app, { upgrade: createUpgradeHandler(app) })` from
 *   `s200/websocket/node` — a zero-dependency RFC 6455 server.
 * - bun: `serve(app, { websocket: createBunWebSocketBridge(app) })` from
 *   `s200/websocket/bun`.
 *
 * Patterns use the router's segment syntax (`:param`, terminal `*rest`);
 * matching is strict and first registration wins, exactly like HTTP
 * routes.
 *
 * @module
 */

import type { App } from './app';
import type { Ctx, Params, Segment } from './types';

import { createSegments, matchSegments } from './router';
import { neverSignal, requestSignal } from './signal';

/** Data a message handler receives / a socket sends: text or raw bytes. */
export type WsData = string | ArrayBuffer | Uint8Array;

/** Callback shapes for {@link WsSocket} events. */
export type WsMessageCb = (data: WsData) => void;
export type WsCloseCb = (code: number, reason: string) => void;
export type WsErrorCb = (error: Error) => void;

/**
 * The server side of one connection, as handed to a handler. Plain
 * function properties — no event-emitter object, no classes.
 */
export type WsSocket = {
  /** Sends a text or binary message. Best-effort backpressure: the
   * runtime queues internally; a writer faster than the network can grow
   * memory (same contract as the minimal servers this replaces). */
  readonly send: (data: WsData) => void;
  /** Starts the close handshake: a close frame is sent and the
   * connection ends once the peer answers (or the runtime gives up). */
  readonly close: (code?: number, reason?: string) => void;
  /** The negotiated subprotocol (`Sec-WebSocket-Protocol`), when the
   * route declared protocols and the client offered one — `undefined`
   * otherwise. */
  readonly protocol: string | undefined;
  /** Sends a ping frame — the keep-alive primitive. The peer's automatic
   * pong surfaces through {@link onPong}; pair them to detect dead peers. */
  readonly ping: (payload?: string | Uint8Array) => void;
  readonly onMessage: (cb: WsMessageCb) => void;
  /** Fires once, with the negotiated close code (1006 when the
   * connection dropped without a close frame). */
  readonly onClose: (cb: WsCloseCb) => void;
  /** Transport/processing errors on this connection. */
  readonly onError: (cb: WsErrorCb) => void;
  /** Pong frames received — replies to {@link ping} (RFC 6455 §5.5.3). */
  readonly onPong: (cb: () => void) => void;
};

/** A WebSocket route handler: receives the socket plus a request-shaped
 * context (`params`, `query`, `url`, `req` from the upgrade request). */
export type WebSocketHandler = (socket: WsSocket, ctx: Ctx) => void | Promise<void>;

export type WebSocketRouteOptions = {
  /** Subprotocols the route speaks, in server preference order — the
   * first one the client also offered wins the negotiation. */
  readonly protocols?: readonly string[];
  /**
   * Enable permessage-deflate (RFC 7692). Negotiated as no-context-
   * takeover both ways, so each message compresses/inflates statelessly.
   * Implemented by the node adapter (`s200/websocket/node`); the bun
   * bridge leaves compression to Bun's native negotiation.
   */
  readonly perMessageDeflate?: boolean;
};

/** One registered WebSocket route: pattern, parsed segments, handler. */
export type WebSocketRoute = {
  readonly pattern: string;
  readonly segments: readonly Segment[];
  readonly handler: WebSocketHandler;
  readonly protocols?: readonly string[];
  readonly perMessageDeflate?: boolean;
};

/** A matched WebSocket route plus the captured path params. */
export type WebSocketMatch = {
  readonly route: WebSocketRoute;
  readonly params: Params;
};

// The registry lives beside the app instead of on it: the core `App` shape
// stays HTTP-only, so importing `s200/websocket` is the only way ws state
// exists (tree-shaking keeps it out of every non-ws consumer).
const registry = new WeakMap<App, WebSocketRoute[]>();

/**
 * Registers a WebSocket handler for `pattern` (`:param` / terminal `*rest`
 * segments; first registration wins, like HTTP routes). Options declare
 * the route's subprotocols (server preference order) and whether the node
 * adapter may negotiate permessage-deflate. Returns the app.
 */
export function upgradeWebSocket(
  app: App,
  pattern: string,
  handler: WebSocketHandler,
  options: WebSocketRouteOptions = {}
): App {
  const list = registry.get(app);
  const route: WebSocketRoute = {
    pattern,
    segments: createSegments(pattern),
    handler,
    ...(options.protocols !== undefined && options.protocols.length > 0
      ? { protocols: options.protocols }
      : {}),
    ...(options.perMessageDeflate === true ? { perMessageDeflate: true } : {}),
  };
  if (list === undefined) {
    registry.set(app, [route]);
  } else {
    list.push(route);
  }
  return app;
}

/**
 * First WebSocket route matching `pathname` (strict, like HTTP dispatch),
 * with captured params. Adapters call this on the upgrade event.
 */
export function matchWebSocket(
  app: App,
  pathname: string
): WebSocketMatch | undefined {
  const list = registry.get(app);
  if (list === undefined) {
    return undefined;
  }
  for (const route of list) {
    const params = matchSegments(route.segments, pathname);
    if (params !== undefined) {
      return { route, params };
    }
  }
  return undefined;
}

/**
 * Builds the request-shaped context adapters hand to handlers: the same
 * `params`/`query`/`url`/`state` surface as HTTP handlers, minus a
 * response (`res` stays `undefined` — a socket answers, not a Response).
 */
export function createWsCtx(req: Request, url: URL, params: Params): Ctx {
  return {
    req,
    url,
    params,
    query: url.searchParams,
    state: {},
    // The upgrade request's signal when the runtime provides one — on a
    // live socket that is the disconnect signal; otherwise the shared
    // never-aborted default.
    signal: requestSignal(req) ?? neverSignal(),
    res: undefined,
  };
}
