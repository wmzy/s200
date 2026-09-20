import type {
  Ctx,
  ErrorHandler,
  Handler,
  MatchFn,
  Middleware,
  Next,
  NotFoundHandler,
  Params,
  Plugin,
  Route,
  State,
} from './types';

import type { ParamsOf } from './router';

import { isHttpError, toErrorResponse } from './errors';
import { compose } from './compose';
import { createMatcher, createRoute } from './router';

/**
 * Options for {@link createApp}: the router is replaceable via `match`, and
 * error/404 rendering is customizable per app.
 */
export type AppOptions<S extends State = State> = {
  match?: MatchFn;
  /** Trailing-slash tolerance for the default matcher; default true = strict. */
  strict?: boolean;
  onError?: ErrorHandler<S>;
  onNotFound?: NotFoundHandler<S>;
};

/**
 * An application is plain data — routes, middlewares, config. The arrays
 * are snapshot-immutable: every registration replaces them with a frozen
 * copy, so the composed-chain and route-index caches can version on array
 * identity alone. Mutate through the registration functions (or
 * {@link removeRoute}); a direct `push` throws a TypeError on the frozen
 * array instead of silently corrupting the dispatch caches.
 * No behavior hangs off the app; dispatch lives in {@link handle}.
 *
 * `S` is the per-app state shape — `createApp<MyState>()` types
 * `ctx.state` as `MyState` in that app's middlewares, handlers, and
 * error/404 policy (default: the global {@link State} interface).
 */
export type App<S extends State = State> = {
  routes: readonly Route[];
  middlewares: readonly Middleware<S>[];
  match: MatchFn;
  onError: ErrorHandler<S> | undefined;
  onNotFound: NotFoundHandler<S> | undefined;
};

export function createApp<S extends State = State>(options: AppOptions<S> = {}): App<S> {
  return {
    routes: Object.freeze([]),
    middlewares: Object.freeze([]),
    match: options.match ?? createMatcher({ strict: options.strict }),
    onError: options.onError,
    onNotFound: options.onNotFound,
  };
}

export function use<S extends State = State>(app: App<S>, middleware: Middleware<S>): App<S> {
  // Replace, don't mutate: the app chain cache versions on array identity
  // (see appChainCache). One O(n) copy per registration is startup cost.
  app.middlewares = Object.freeze([...app.middlewares, middleware]);
  return app;
}

/**
 * Removes every route registered for `method` (normalized uppercase) and
 * `pattern`. No-op when nothing matches. The route table is replaced, so
 * the matcher's cached index rebuilds on the next dispatch.
 */
export function removeRoute<S extends State = State>(
  app: App<S>,
  method: string,
  pattern: string
): App<S> {
  const normalized = method.toUpperCase();
  const filtered = app.routes.filter(
    (route) => !(route.method === normalized && route.pattern === pattern)
  );
  if (filtered.length !== app.routes.length) {
    app.routes = Object.freeze(filtered);
  }
  return app;
}

export function usePlugin<S extends State = State>(app: App<S>, plugin: Plugin<S>): App<S> {
  plugin(app);
  return app;
}

/**
 * Mounts every route of `sub` under `prefix`: patterns are joined
 * (`prefix '/v1'` + `/users/:id` → `/v1/users/:id`; the sub-app root `/`
 * becomes the bare `/v1`), and `sub`'s app-level middlewares are scoped
 * onto each mounted route, running after the parent chain and before the
 * sub route's own middlewares and handler.
 *
 * Pure data transform: `sub` is copied, never mutated, so one sub-app can
 * mount under many prefixes. `sub`'s `match`/`onError`/`onNotFound` are not
 * carried over — the parent dispatches (mount routes are parent routes) and
 * the parent's error/404 policy applies. Middlewares on an empty `sub` are
 * lost (no routes to carry them); gate on the prefix with a normal `use`
 * middleware instead.
 */
export function mount<S extends State = State>(
  app: App<S>,
  prefix: string,
  sub: App<S>
): App<S> {
  if (prefix !== '' && !prefix.startsWith('/')) {
    throw new Error(`Invalid mount prefix '${prefix}': must be empty or start with '/'`);
  }
  // Normalize: '' and '/' are no-prefix; a trailing slash would double up
  // against the pattern's leading slash.
  const base = prefix === '' || prefix === '/' ? '' : prefix.replace(/\/+$/, '');
  const added: Route[] = [];
  for (const route of sub.routes) {
    const pattern = base === '' ? route.pattern : route.pattern === '/' ? base : `${base}${route.pattern}`;
    const middlewares =
      sub.middlewares.length === 0
        ? route.middlewares
        : ([...sub.middlewares, ...route.middlewares] as Middleware[]);
    added.push(
      createRoute(route.method, pattern, route.handler as Handler, middlewares)
    );
  }
  if (added.length > 0) {
    // One replacement per mount, not one per route (snapshot semantics).
    app.routes = Object.freeze([...app.routes, ...added]);
  }
  return app;
}

/**
 * Shared body of every route registration. `chain` is the route's
 * `[...middlewares, handler]` tuple — every element but the last is a
 * route-scoped middleware. The `Handler<never, S>` element accepts both
 * literal-typed handlers (contravariance: `Ctx<never, S>` is assignable to
 * every `Ctx<P, S>`) and the dynamic-pattern `Handler`, so one
 * implementation serves both overloads of each public registrar.
 */
function register<S extends State = State>(
  app: App<S>,
  method: string,
  pattern: string,
  chain: readonly [...Middleware<S>[], Handler<never, S>]
): App<S> {
  const handler = chain[chain.length - 1];
  if (handler === undefined) {
    throw new Error(`Invalid route ${method} '${pattern}': a terminal handler is required`);
  }
  const middlewares = chain.slice(0, -1) as Middleware[];
  // matchRoutes guarantees the params keys for this pattern; the runtime
  // table stores the erased shape. Replace, don't mutate: the route index
  // cache versions on array identity (snapshot semantics, see createApp).
  app.routes = Object.freeze([
    ...app.routes,
    createRoute(method, pattern, handler as unknown as Handler, middlewares),
  ]);
  return app;
}

export function addRoute<P extends string, S extends State = State>(
  app: App<S>,
  method: string,
  pattern: P,
  ...chain: [...Middleware<S>[], Handler<ParamsOf<P>, S>]
): App<S>;
export function addRoute<S extends State = State>(
  app: App<S>,
  method: string,
  pattern: string,
  ...chain: [...Middleware<S>[], Handler<Params, S>]
): App<S>;
export function addRoute<S extends State = State>(
  app: App<S>,
  method: string,
  pattern: string,
  ...chain: [...Middleware<S>[], Handler<never, S>]
): App<S> {
  return register(app, method, pattern, chain);
}

export function get<P extends string, S extends State = State>(
  app: App<S>,
  pattern: P,
  ...chain: [...Middleware<S>[], Handler<ParamsOf<P>, S>]
): App<S>;
export function get<S extends State = State>(
  app: App<S>,
  pattern: string,
  ...chain: [...Middleware<S>[], Handler<Params, S>]
): App<S>;
export function get<S extends State = State>(
  app: App<S>,
  pattern: string,
  ...chain: [...Middleware<S>[], Handler<never, S>]
): App<S> {
  return register(app, 'GET', pattern, chain);
}

export function post<P extends string, S extends State = State>(
  app: App<S>,
  pattern: P,
  ...chain: [...Middleware<S>[], Handler<ParamsOf<P>, S>]
): App<S>;
export function post<S extends State = State>(
  app: App<S>,
  pattern: string,
  ...chain: [...Middleware<S>[], Handler<Params, S>]
): App<S>;
export function post<S extends State = State>(
  app: App<S>,
  pattern: string,
  ...chain: [...Middleware<S>[], Handler<never, S>]
): App<S> {
  return register(app, 'POST', pattern, chain);
}

export function put<P extends string, S extends State = State>(
  app: App<S>,
  pattern: P,
  ...chain: [...Middleware<S>[], Handler<ParamsOf<P>, S>]
): App<S>;
export function put<S extends State = State>(
  app: App<S>,
  pattern: string,
  ...chain: [...Middleware<S>[], Handler<Params, S>]
): App<S>;
export function put<S extends State = State>(
  app: App<S>,
  pattern: string,
  ...chain: [...Middleware<S>[], Handler<never, S>]
): App<S> {
  return register(app, 'PUT', pattern, chain);
}

export function patch<P extends string, S extends State = State>(
  app: App<S>,
  pattern: P,
  ...chain: [...Middleware<S>[], Handler<ParamsOf<P>, S>]
): App<S>;
export function patch<S extends State = State>(
  app: App<S>,
  pattern: string,
  ...chain: [...Middleware<S>[], Handler<Params, S>]
): App<S>;
export function patch<S extends State = State>(
  app: App<S>,
  pattern: string,
  ...chain: [...Middleware<S>[], Handler<never, S>]
): App<S> {
  return register(app, 'PATCH', pattern, chain);
}

export function del<P extends string, S extends State = State>(
  app: App<S>,
  pattern: P,
  ...chain: [...Middleware<S>[], Handler<ParamsOf<P>, S>]
): App<S>;
export function del<S extends State = State>(
  app: App<S>,
  pattern: string,
  ...chain: [...Middleware<S>[], Handler<Params, S>]
): App<S>;
export function del<S extends State = State>(
  app: App<S>,
  pattern: string,
  ...chain: [...Middleware<S>[], Handler<never, S>]
): App<S> {
  return register(app, 'DELETE', pattern, chain);
}

export function head<P extends string, S extends State = State>(
  app: App<S>,
  pattern: P,
  ...chain: [...Middleware<S>[], Handler<ParamsOf<P>, S>]
): App<S>;
export function head<S extends State = State>(
  app: App<S>,
  pattern: string,
  ...chain: [...Middleware<S>[], Handler<Params, S>]
): App<S>;
export function head<S extends State = State>(
  app: App<S>,
  pattern: string,
  ...chain: [...Middleware<S>[], Handler<never, S>]
): App<S> {
  return register(app, 'HEAD', pattern, chain);
}

export function options<P extends string, S extends State = State>(
  app: App<S>,
  pattern: P,
  ...chain: [...Middleware<S>[], Handler<ParamsOf<P>, S>]
): App<S>;
export function options<S extends State = State>(
  app: App<S>,
  pattern: string,
  ...chain: [...Middleware<S>[], Handler<Params, S>]
): App<S>;
export function options<S extends State = State>(
  app: App<S>,
  pattern: string,
  ...chain: [...Middleware<S>[], Handler<never, S>]
): App<S> {
  return register(app, 'OPTIONS', pattern, chain);
}

export function all<P extends string, S extends State = State>(
  app: App<S>,
  pattern: P,
  ...chain: [...Middleware<S>[], Handler<ParamsOf<P>, S>]
): App<S>;
export function all<S extends State = State>(
  app: App<S>,
  pattern: string,
  ...chain: [...Middleware<S>[], Handler<Params, S>]
): App<S>;
export function all<S extends State = State>(
  app: App<S>,
  pattern: string,
  ...chain: [...Middleware<S>[], Handler<never, S>]
): App<S> {
  return register(app, 'ALL', pattern, chain);
}

// Composed-chain caches. `compose`'s double-next `index` is created per
// invocation, so one composed function is safe to reuse across requests;
// only the continuation differs per request. Both caches version on array
// IDENTITY: `use`/`register`/`removeRoute` replace the arrays with frozen
// copies (snapshot semantics), so identity changes exactly when content
// does — no length comparison that in-place mutation could defeat.
const appChainCache = new WeakMap<
  App,
  { readonly middlewares: readonly Middleware[]; readonly chain: ReturnType<typeof compose> }
>();
const routeChainCache = new WeakMap<Route, ReturnType<typeof compose>>();

function getAppChain<S extends State = State>(
  app: App<S>
): ReturnType<typeof compose<S>> {
  // The cache erases the state param (`App<State>` is assignable to every
  // `App<S>`, so the lookup cast is safe) and the composed chain is cast
  // back on return — the stored middlewares are exactly this app's.
  const cached = appChainCache.get(app as App);
  if (cached !== undefined && cached.middlewares === app.middlewares) {
    return cached.chain as ReturnType<typeof compose<S>>;
  }
  const chain = compose(app.middlewares);
  appChainCache.set(app as App, {
    middlewares: app.middlewares as Middleware[],
    chain: chain as ReturnType<typeof compose>,
  });
  return chain;
}

function getRouteChain(route: Route): ReturnType<typeof compose> {
  const cached = routeChainCache.get(route);
  if (cached !== undefined) {
    return cached;
  }
  // Terminator: the innermost "middleware" running the matched handler. A
  // returned Response is adopted only when nothing else wrote one first.
  const terminator: Middleware = async (routeCtx) => {
    const returned = await route.handler(routeCtx);
    if (returned instanceof Response && routeCtx.res === undefined) {
      routeCtx.res = returned;
    }
  };
  const chain = compose([...route.middlewares, terminator]);
  routeChainCache.set(route, chain);
  return chain;
}

/**
 * Maps a thrown value to a response through the app's error policy: custom
 * `onError` (its own failures degrade to the default mapping), or the
 * default — `HttpError` keeps its status/message, anything else logs via
 * `console.error` and becomes an anonymous 500. Shared by the in-chain
 * boundary (route/fallback errors) and the outer catch (middleware errors).
 */
async function mapError<S extends State = State>(
  app: App<S>,
  ctx: Ctx<Params, S>,
  error: unknown
): Promise<void> {
  if (app.onError === undefined) {
    // HttpErrors are intentional client errors mapped to responses; only
    // unexpected failures need surfacing — a silently swallowed 500 is
    // undebuggable in production.
    if (!isHttpError(error)) {
      console.error(error);
    }
    ctx.res = toErrorResponse(error);
    return;
  }
  try {
    await app.onError(ctx, error);
  } catch (handlerError) {
    // A crashing error handler is itself a failure — default mapping.
    ctx.res = toErrorResponse(handlerError);
  }
}

export async function handle<S extends State = State>(
  app: App<S>,
  request: Request
): Promise<Response> {
  const url = new URL(request.url);
  const matched = app.match(app.routes, request.method, url.pathname);
  // 'route' in matched discriminates the MatchResult union: a path match
  // with no method match yields `allowedMethods` (a 405) instead of a route.
  const hit = matched !== undefined && 'route' in matched ? matched : undefined;
  const miss =
    matched !== undefined && 'allowedMethods' in matched ? matched : undefined;
  const route = hit?.route;
  const allowedMethods = miss?.allowedMethods;
  const ctx: Ctx<Params, S> = {
    req: request,
    url,
    params: hit?.params ?? {},
    query: url.searchParams,
    // Fresh empty bag per request; the app's `S` fills it via middlewares.
    state: {} as S,
    res: undefined,
  };
  // The chain terminal: when nothing wrote a response, the 405/404/500
  // fallback is materialized INSIDE the chain — after the route chain
  // settles but before the app middlewares unwind — so anything observing
  // the unwind (logger status, CORS stamping) sees the real response.
  const fallback = async (): Promise<void> => {
    if (ctx.res !== undefined) {
      return;
    }
    if (allowedMethods !== undefined) {
      // Path matched but no route's method did: RFC 9110 wants 405 + Allow.
      ctx.res = Response.json(
        { error: 'Method Not Allowed' },
        { status: 405, headers: { Allow: allowedMethods.join(', ') } }
      );
    } else if (route === undefined) {
      if (app.onNotFound !== undefined) {
        await app.onNotFound(ctx);
      }
      if (ctx.res === undefined) {
        ctx.res = Response.json({ error: 'Not Found' }, { status: 404 });
      }
    } else {
      ctx.res = Response.json({ error: 'No response written' }, { status: 500 });
    }
  };
  // The error boundary sits BELOW the app middlewares: a route handler (or
  // the fallback) that throws is mapped right here, so the app middlewares
  // unwind with the error response materialized — the same contract the
  // 404/405/500 fallbacks already honor. Errors thrown by a middleware
  // itself (above this boundary) are mapped by the outer catch below.
  const inner: Next = async () => {
    try {
      if (route !== undefined) {
        await getRouteChain(route)(ctx);
      }
      await fallback();
    } catch (error) {
      await mapError(app, ctx, error);
    }
  };
  try {
    await getAppChain(app)(ctx, inner);
  } catch (error) {
    await mapError(app, ctx, error);
  }
  // A custom onError may answer or leave the response unwritten — the
  // latter falls back like the in-chain terminal did (original semantics:
  // the 405/404/500 decision still applies after errors).
  if (ctx.res === undefined) {
    try {
      await fallback();
    } catch (error) {
      await mapError(app, ctx, error);
    }
  }
  if (request.method === 'HEAD') {
    // fallback()/mapError guarantee a response above, but the write happens
    // inside a closure tsc cannot see through.
    const res = ctx.res as Response;
    // HEAD must not carry a body, but content-length stays so the client can
    // learn the size a GET would have returned.
    ctx.res = new Response(null, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }
  return ctx.res as Response;
}
