/**
 * WebSocket support in the `data + functions` shape: `upgradeWebSocket`
 * records `pattern → handler` routes on the app (pure data), and the
 * runtime adapters consult the registry when a connection upgrades:
 *
 * - node: `serve(app, { upgrade: createUpgradeHandler(app) })` from
 *   `s200/websocket/node` — a zero-dependency RFC 6455 server.
 * - bun: `serve(app, { websocket: createBunWebSocketBridge(app) })` from
 *   `s200/websocket/bun`.
 * - cloudflare: `ws.upgrade(request) ?? worker.fetch(…)` with
 *   `createCloudflareWebSocketBridge(app)` from `s200/websocket/cloudflare`
 *   composed with `s200/cloudflare`'s `createHandler`.
 *
 * Patterns use the router's segment syntax (`:param`, terminal `*rest`);
 * matching is strict and first registration wins, exactly like HTTP
 * routes. The app's own middleware chain and the route's middlewares run
 * before the handshake completes — see {@link resolveUpgrade}.
 *
 * @module
 */

import type { App } from './app';
import type { Ctx, Middleware, Params, Segment, State } from './types';

import { mapError } from './error-map';
import { compose } from './compose';
import { toErrorResponse } from './errors';
import { drainPendingHeaders } from './respond';
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
  /** Bytes the transport has queued that are not yet on the wire —
   * send-side backpressure visibility: it grows while `send` outruns the
   * network and drains back to 0 as the socket flushes. */
  readonly bufferedAmount: number;
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

/** One registered WebSocket route: pattern, parsed segments, middlewares,
 * handler. */
export type WebSocketRoute = {
  readonly pattern: string;
  readonly segments: readonly Segment[];
  /** Route-scoped middlewares — they run (after the app chain) before the
   * handshake completes; see {@link resolveUpgrade}. */
  readonly middlewares: readonly Middleware[];
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
 * segments; first registration wins, like HTTP routes), optionally with
 * route-scoped middlewares ahead of the handler — the same
 * `...middlewares, handler` shape as the HTTP registrars. Options declare
 * the route's subprotocols (server preference order) and whether the node
 * adapter may negotiate permessage-deflate. Returns the app.
 */
export function upgradeWebSocket<
  S extends State = State,
  Ms extends Middleware<S>[] = Middleware<S>[]
>(
  app: App<S>,
  pattern: string,
  ...chain: [...middlewares: Ms, handler: WebSocketHandler]
): App<S>;
export function upgradeWebSocket<
  S extends State = State,
  Ms extends Middleware<S>[] = Middleware<S>[]
>(
  app: App<S>,
  pattern: string,
  ...chain: [...middlewares: Ms, handler: WebSocketHandler, options: WebSocketRouteOptions]
): App<S>;
export function upgradeWebSocket<
  S extends State = State,
  Ms extends Middleware<S>[] = Middleware<S>[]
>(
  app: App<S>,
  pattern: string,
  ...chain: [...middlewares: Ms, handler: WebSocketHandler, options: undefined]
): App<S>;
export function upgradeWebSocket(
  app: App,
  pattern: string,
  ...chain: readonly (Middleware | WebSocketHandler | WebSocketRouteOptions)[]
): App {
  const last = chain[chain.length - 1];
  // Positional trust, like the HTTP registrars' `register`: the overloads
  // are the contract — the last function is the terminal handler, a
  // trailing non-function (or undefined) is the options bag.
  const handler =
    typeof last === 'function'
      ? (last as WebSocketHandler)
      : (chain[chain.length - 2] as WebSocketHandler | undefined);
  if (handler === undefined) {
    throw new Error(
      `Invalid WebSocket route '${pattern}': a terminal handler is required`
    );
  }
  // A trailing undefined keeps the old `options = {}` default semantics.
  const options: WebSocketRouteOptions =
    typeof last === 'function' || last === undefined ? {} : last;
  const middlewares = (
    typeof last === 'function' ? chain.slice(0, -1) : chain.slice(0, -2)
  ) as Middleware[];
  const list = registry.get(app);
  const route: WebSocketRoute = {
    pattern,
    segments: createSegments(pattern),
    middlewares,
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
 * response (`res` stays `undefined` — a socket answers, not a Response)
 * and minus the matched `route` (the ws registry's route is a different
 * shape than the core `Route`).
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
    // No HTTP route matched — an upgrade is answered by a socket, and the
    // ws registry's route is a different shape than the core `Route`.
    route: undefined,
    res: undefined,
  };
}

/** The middleware verdict for one upgrade request. `ok: true` approves
 * the handshake — `ctx` is the exact context the handler then receives
 * (middleware `state` mutations included). `ok: false` carries the
 * rejection `Response` the adapter answers with instead of `101`. */
export type WsUpgradeDecision =
  | { readonly ok: true; readonly ctx: Ctx }
  | { readonly ok: false; readonly response: Response };

// Composed-chain caches, mirroring app.ts: versioned on array identity —
// `use` replaces `app.middlewares` on every registration, and a route's
// middlewares are fixed at registration. `compose`'s double-next index is
// created per invocation, so one composed chain is safe to reuse.
const wsAppChainCache = new WeakMap<
  App,
  {
    readonly middlewares: readonly Middleware[];
    readonly chain: ReturnType<typeof compose>;
  }
>();
const wsRouteChainCache = new WeakMap<WebSocketRoute, ReturnType<typeof compose>>();

/**
 * Adoption wrapper for ws chains: a middleware may answer by RETURNING a
 * Response (HTTP ignores middleware returns — only handler returns are
 * adopted; an upgrade has no handler slot below the chain to adopt one,
 * so the decision honors a returned Response directly).
 */
const adoptsReturns =
  (middleware: Middleware): Middleware =>
  async (ctx, next) => {
    const returned: unknown = await middleware(ctx, next);
    if (ctx.res === undefined && returned instanceof Response) {
      ctx.res = returned;
    }
  };

function wsAppChain(app: App): ReturnType<typeof compose> {
  const cached = wsAppChainCache.get(app);
  if (cached !== undefined && cached.middlewares === app.middlewares) {
    return cached.chain;
  }
  // One seam cast, like app.ts's getAppChain: the stored middlewares are
  // exactly this app's — the cache key is the array identity.
  const middlewares = app.middlewares as readonly Middleware[];
  const chain = compose(middlewares.map(adoptsReturns));
  wsAppChainCache.set(app, { middlewares, chain });
  return chain;
}

function wsRouteChain(route: WebSocketRoute): ReturnType<typeof compose> {
  const cached = wsRouteChainCache.get(route);
  if (cached !== undefined) {
    return cached;
  }
  const chain = compose(route.middlewares.map(adoptsReturns));
  wsRouteChainCache.set(route, chain);
  return chain;
}

/**
 * Runs the full middleware chain for one upgrade request — the app's own
 * middlewares first, then the route's, in registration order — and turns
 * the outcome into a decision for the adapters:
 *
 * - the chain settling with `ctx.res` still `undefined` APPROVES the
 *   upgrade: the socket is the response, unwinding middlewares observe
 *   `res: undefined`, and `state` mutations ride into the handler;
 * - any middleware writing `ctx.res` (or returning a Response) REJECTS
 *   it: that response becomes the HTTP answer instead of `101` — the
 *   node adapter writes it to the socket before the handshake, the bun
 *   bridge returns it from the fetch handler;
 * - a thrown error maps exactly like HTTP: `HttpError` to its status and
 *   envelope, anything else through the app's `onError`/`logError`
 *   policy (an `onError` that stays silent falls back to the default
 *   mapping — an upgrade has no fallback body to answer with).
 *
 * `setHeader`/`setHeaders` entries pending on the ctx ride the rejection
 * response, like any first response materialization.
 */
export async function resolveUpgrade(
  app: App,
  route: WebSocketRoute,
  request: Request,
  url: URL,
  params: Params
): Promise<WsUpgradeDecision> {
  const ctx = createWsCtx(request, url, params);
  try {
    await compose([wsAppChain(app), wsRouteChain(route)])(ctx);
  } catch (error) {
    await mapError(app, ctx, error);
    if (ctx.res === undefined) {
      ctx.res = toErrorResponse(error);
    }
  }
  if (ctx.res === undefined) {
    return { ok: true, ctx };
  }
  drainPendingHeaders(ctx, ctx.res);
  return { ok: false, response: ctx.res };
}
