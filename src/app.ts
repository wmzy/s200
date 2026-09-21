import type {
  Ctx,
  ErrorHandler,
  Handler,
  MatchFn,
  Middleware,
  MountBase,
  MountedDefs,
  Next,
  NotFoundHandler,
  Params,
  Plugin,
  Route,
  RouteDef,
  ResolveOut,
  RouteFilter,
  State,
} from './types';

import type { ParamsOf } from './router';

import { isHttpError, toErrorResponse } from './errors';
import { compose } from './compose';
import { cachedUrl, setCachedUrl } from './light';
import { newResponse } from './respond';
import { createMatcher, createRoute, createSegments, matchSegments } from './router';

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
  /**
   * Sink for unexpected (non-{@link HttpError}) errors when no custom
   * `onError` is set — the default policy logs via `console.error` and
   * answers an anonymous 500. Inject a structured logger here; the client
   * still sees the anonymous 500 either way.
   */
  logError?: (error: unknown) => void;
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
 *
 * `R` is a phantom type parameter — a compile-time log of every registered
 * route's method + pattern literal, accumulated by the registrars and
 * consumed by `s200/client`'s {@link createClient}. It never appears in the
 * runtime shape, so apps type the same with or without it.
 */
export type App<
  S extends State = State,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- R is a phantom type parameter: a compile-time route log consumed by s200/client, never part of the runtime shape
  R extends readonly RouteDef[] = readonly RouteDef[]
> = {
  routes: readonly Route[];
  middlewares: readonly Middleware<S>[];
  match: MatchFn;
  onError: ErrorHandler<S> | undefined;
  onNotFound: NotFoundHandler<S> | undefined;
  logError: ((error: unknown) => void) | undefined;
};

export function createApp<S extends State = State>(
  options: AppOptions<S> = {}
): App<S, []> {
  return {
    routes: Object.freeze([]),
    middlewares: Object.freeze([]),
    match: options.match ?? createMatcher({ strict: options.strict }),
    onError: options.onError,
    onNotFound: options.onNotFound,
    logError: options.logError,
  };
}

/**
 * Prefix-scoped middlewares: the group runs only for requests whose
 * pathname falls under `prefix` (`/admin` matches `/admin`, `/admin/…`; a
 * prefix may contain params — `/users/:id` scopes per user). Scope checks
 * use the router's own matching (strict trailing slashes), so behavior
 * matches routing. Scoped groups nest in registration order like ordinary
 * middlewares; `next()` from inside one continues into the next scope and
 * the route chain below. A prefix with no middlewares is a programmer
 * error — it typechecks, but `use` throws at registration.
 */
export function use<
  S extends State = State,
  R extends readonly RouteDef[] = readonly RouteDef[]
>(
  app: App<S, R>,
  prefixOrMiddleware: string | Middleware<S>,
  ...middlewares: Middleware<S>[]
): App<S, R> {
  if (typeof prefixOrMiddleware === 'string') {
    const prefix = prefixOrMiddleware;
    if (middlewares.length === 0) {
      throw new Error(
        `use(app, prefix, ...middlewares): at least one middleware is required for prefix '${prefix}'`
      );
    }
    // '' and '/' scope everything — equivalent to the global form.
    if (prefix === '' || prefix === '/') {
      app.middlewares = Object.freeze([...app.middlewares, ...middlewares]);
      return app;
    }
    if (!prefix.startsWith('/')) {
      throw new Error(
        `Invalid middleware prefix '${prefix}': must start with '/'`
      );
    }
    const base = prefix.replace(/\/+$/, '');
    // Static prefixes get a plain string check (no per-request split);
    // param/wildcard prefixes use the router's own matcher.
    const dynamic = base.includes(':') || base.includes('*');
    const segments = dynamic ? createSegments(`${base}/*rest`) : undefined;
    // Composed once: compose()'s double-next index is per invocation, so
    // the shared group is safe to reuse across requests.
    const group = compose(middlewares as readonly Middleware<S>[]);
    const guard: Middleware<S> = async (ctx, next) => {
      const pathname = ctx.url.pathname;
      const scoped =
        segments === undefined
          ? pathname === base || pathname.startsWith(`${base}/`)
          : matchSegments(segments, pathname) !== undefined;
      if (!scoped) {
        return next();
      }
      return group(ctx, next);
    };
    // Replace, don't mutate: the app chain cache versions on array identity
    // (see appChainCache). One O(n) copy per registration is startup cost.
    app.middlewares = Object.freeze([...app.middlewares, guard]);
    return app;
  }
  app.middlewares = Object.freeze([
    ...app.middlewares,
    prefixOrMiddleware,
    ...middlewares,
  ]);
  return app;
}

/**
 * Removes every route registered for `method` (normalized uppercase) and
 * `pattern`. No-op when nothing matches. The route table is replaced, so
 * the matcher's cached index rebuilds on the next dispatch. The `R` log
 * drops the removed entries too, so `s200/client` stops offering them.
 */
export function removeRoute<
  S extends State = State,
  R extends readonly RouteDef[] = readonly RouteDef[],
  M extends string = string,
  P extends string = string
>(
  app: App<S, R>,
  method: M,
  pattern: P
): App<S, RouteFilter<R, Uppercase<M>, P>> {
  const normalized = method.toUpperCase();
  const filtered = app.routes.filter(
    (route) => !(route.method === normalized && route.pattern === pattern)
  );
  if (filtered.length !== app.routes.length) {
    app.routes = Object.freeze(filtered);
  }
  return app as App<S, RouteFilter<R, Uppercase<M>, P>>;
}

/**
 * Applies a plugin (any function over the mutable `App`) and returns the
 * app. Routes a plugin registers are not tracked in `R` — the plugin's
 * signature cannot describe them — so `s200/client` does not type them.
 * For client-typed routes, register through the registrars directly.
 */
export function usePlugin<
  S extends State = State,
  R extends readonly RouteDef[] = readonly RouteDef[]
>(app: App<S, R>, plugin: Plugin<S>): App<S, R> {
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
export function mount<
  S extends State = State,
  R extends readonly RouteDef[] = readonly RouteDef[],
  R2 extends readonly RouteDef[] = readonly RouteDef[],
  Prefix extends string = string
>(
  app: App<S, R>,
  prefix: Prefix,
  sub: App<S, R2>
): App<S, [...R, ...MountedDefs<R2, MountBase<Prefix>>]> {
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
  return app as App<S, [...R, ...MountedDefs<R2, MountBase<Prefix>>]>;
}

/**
 * Shared body of every route registration. `chain` is the route's
 * `[...middlewares, handler]` tuple — every element but the last is a
 * route-scoped middleware. The `Handler<never, S>` element accepts both
 * literal-typed handlers (contravariance: `Ctx<never, S>` is assignable to
 * every `Ctx<P, S>`) and the dynamic-pattern `Handler`, so one
 * implementation serves both overloads of each public registrar.
 */
function register<
  S extends State = State,
  R extends readonly RouteDef[] = readonly RouteDef[]
>(
  app: App<S, R>,
  method: string,
  pattern: string,
  chain: readonly [...Middleware<S>[], Handler<never, S>]
): App<S, R> {
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

export function addRoute<
  P extends string,
  S extends State = State,
  M extends string = string,
  R extends readonly RouteDef[] = readonly RouteDef[]
,
  O = unknown
>(
  app: App<S, R>,
  method: M,
  pattern: P,
  ...chain: [...Middleware<S>[], Handler<ParamsOf<P>, S, O>]
): App<S, [...R, { readonly method: Uppercase<M>; readonly pattern: P; readonly out: ResolveOut<O> }]>;
export function addRoute<
  S extends State = State,
  M extends string = string,
  R extends readonly RouteDef[] = readonly RouteDef[]
,
  O = unknown
>(
  app: App<S, R>,
  method: M,
  pattern: string,
  ...chain: [...Middleware<S>[], Handler<Params, S, O>]
): App<S, [...R, { readonly method: Uppercase<M>; readonly pattern: string; readonly out: ResolveOut<O> }]>;
export function addRoute<
  S extends State = State,
  M extends string = string,
  R extends readonly RouteDef[] = readonly RouteDef[]
,
  O = unknown
>(
  app: App<S, R>,
  method: M,
  pattern: string,
  ...chain: [...Middleware<S>[], Handler<never, S, O>]
): App<S, [...R, { readonly method: Uppercase<M>; readonly pattern: string; readonly out: ResolveOut<O> }]> {
  return register(app, method, pattern, chain) as App<
    S,
    [...R, { readonly method: Uppercase<M>; readonly pattern: string; readonly out: ResolveOut<O> }]
  >;
}

export function get<
  P extends string,
  S extends State = State,
  R extends readonly RouteDef[] = readonly RouteDef[]
,
  O = unknown
>(
  app: App<S, R>,
  pattern: P,
  ...chain: [...Middleware<S>[], Handler<ParamsOf<P>, S, O>]
): App<S, [...R, { readonly method: 'GET'; readonly pattern: P; readonly out: ResolveOut<O> }]>;
export function get<
  S extends State = State,
  R extends readonly RouteDef[] = readonly RouteDef[]
,
  O = unknown
>(
  app: App<S, R>,
  pattern: string,
  ...chain: [...Middleware<S>[], Handler<Params, S, O>]
): App<S, [...R, { readonly method: 'GET'; readonly pattern: string; readonly out: ResolveOut<O> }]>;
export function get<
  S extends State = State,
  R extends readonly RouteDef[] = readonly RouteDef[]
,
  O = unknown
>(
  app: App<S, R>,
  pattern: string,
  ...chain: [...Middleware<S>[], Handler<never, S, O>]
): App<S, [...R, { readonly method: 'GET'; readonly pattern: string; readonly out: ResolveOut<O> }]> {
  return register(app, 'GET', pattern, chain) as App<
    S,
    [...R, { readonly method: 'GET'; readonly pattern: string; readonly out: ResolveOut<O> }]
  >;
}

export function post<
  P extends string,
  S extends State = State,
  R extends readonly RouteDef[] = readonly RouteDef[]
,
  O = unknown
>(
  app: App<S, R>,
  pattern: P,
  ...chain: [...Middleware<S>[], Handler<ParamsOf<P>, S, O>]
): App<S, [...R, { readonly method: 'POST'; readonly pattern: P; readonly out: ResolveOut<O> }]>;
export function post<
  S extends State = State,
  R extends readonly RouteDef[] = readonly RouteDef[]
,
  O = unknown
>(
  app: App<S, R>,
  pattern: string,
  ...chain: [...Middleware<S>[], Handler<Params, S, O>]
): App<S, [...R, { readonly method: 'POST'; readonly pattern: string; readonly out: ResolveOut<O> }]>;
export function post<
  S extends State = State,
  R extends readonly RouteDef[] = readonly RouteDef[]
,
  O = unknown
>(
  app: App<S, R>,
  pattern: string,
  ...chain: [...Middleware<S>[], Handler<never, S, O>]
): App<S, [...R, { readonly method: 'POST'; readonly pattern: string; readonly out: ResolveOut<O> }]> {
  return register(app, 'POST', pattern, chain) as App<
    S,
    [...R, { readonly method: 'POST'; readonly pattern: string; readonly out: ResolveOut<O> }]
  >;
}

export function put<
  P extends string,
  S extends State = State,
  R extends readonly RouteDef[] = readonly RouteDef[]
,
  O = unknown
>(
  app: App<S, R>,
  pattern: P,
  ...chain: [...Middleware<S>[], Handler<ParamsOf<P>, S, O>]
): App<S, [...R, { readonly method: 'PUT'; readonly pattern: P; readonly out: ResolveOut<O> }]>;
export function put<
  S extends State = State,
  R extends readonly RouteDef[] = readonly RouteDef[]
,
  O = unknown
>(
  app: App<S, R>,
  pattern: string,
  ...chain: [...Middleware<S>[], Handler<Params, S, O>]
): App<S, [...R, { readonly method: 'PUT'; readonly pattern: string; readonly out: ResolveOut<O> }]>;
export function put<
  S extends State = State,
  R extends readonly RouteDef[] = readonly RouteDef[]
,
  O = unknown
>(
  app: App<S, R>,
  pattern: string,
  ...chain: [...Middleware<S>[], Handler<never, S, O>]
): App<S, [...R, { readonly method: 'PUT'; readonly pattern: string; readonly out: ResolveOut<O> }]> {
  return register(app, 'PUT', pattern, chain) as App<
    S,
    [...R, { readonly method: 'PUT'; readonly pattern: string; readonly out: ResolveOut<O> }]
  >;
}

export function patch<
  P extends string,
  S extends State = State,
  R extends readonly RouteDef[] = readonly RouteDef[]
,
  O = unknown
>(
  app: App<S, R>,
  pattern: P,
  ...chain: [...Middleware<S>[], Handler<ParamsOf<P>, S, O>]
): App<S, [...R, { readonly method: 'PATCH'; readonly pattern: P; readonly out: ResolveOut<O> }]>;
export function patch<
  S extends State = State,
  R extends readonly RouteDef[] = readonly RouteDef[]
,
  O = unknown
>(
  app: App<S, R>,
  pattern: string,
  ...chain: [...Middleware<S>[], Handler<Params, S, O>]
): App<S, [...R, { readonly method: 'PATCH'; readonly pattern: string; readonly out: ResolveOut<O> }]>;
export function patch<
  S extends State = State,
  R extends readonly RouteDef[] = readonly RouteDef[]
,
  O = unknown
>(
  app: App<S, R>,
  pattern: string,
  ...chain: [...Middleware<S>[], Handler<never, S, O>]
): App<S, [...R, { readonly method: 'PATCH'; readonly pattern: string; readonly out: ResolveOut<O> }]> {
  return register(app, 'PATCH', pattern, chain) as App<
    S,
    [...R, { readonly method: 'PATCH'; readonly pattern: string; readonly out: ResolveOut<O> }]
  >;
}

export function del<
  P extends string,
  S extends State = State,
  R extends readonly RouteDef[] = readonly RouteDef[]
,
  O = unknown
>(
  app: App<S, R>,
  pattern: P,
  ...chain: [...Middleware<S>[], Handler<ParamsOf<P>, S, O>]
): App<S, [...R, { readonly method: 'DELETE'; readonly pattern: P; readonly out: ResolveOut<O> }]>;
export function del<
  S extends State = State,
  R extends readonly RouteDef[] = readonly RouteDef[]
,
  O = unknown
>(
  app: App<S, R>,
  pattern: string,
  ...chain: [...Middleware<S>[], Handler<Params, S, O>]
): App<S, [...R, { readonly method: 'DELETE'; readonly pattern: string; readonly out: ResolveOut<O> }]>;
export function del<
  S extends State = State,
  R extends readonly RouteDef[] = readonly RouteDef[]
,
  O = unknown
>(
  app: App<S, R>,
  pattern: string,
  ...chain: [...Middleware<S>[], Handler<never, S, O>]
): App<S, [...R, { readonly method: 'DELETE'; readonly pattern: string; readonly out: ResolveOut<O> }]> {
  return register(app, 'DELETE', pattern, chain) as App<
    S,
    [...R, { readonly method: 'DELETE'; readonly pattern: string; readonly out: ResolveOut<O> }]
  >;
}

export function head<
  P extends string,
  S extends State = State,
  R extends readonly RouteDef[] = readonly RouteDef[]
,
  O = unknown
>(
  app: App<S, R>,
  pattern: P,
  ...chain: [...Middleware<S>[], Handler<ParamsOf<P>, S, O>]
): App<S, [...R, { readonly method: 'HEAD'; readonly pattern: P; readonly out: ResolveOut<O> }]>;
export function head<
  S extends State = State,
  R extends readonly RouteDef[] = readonly RouteDef[]
,
  O = unknown
>(
  app: App<S, R>,
  pattern: string,
  ...chain: [...Middleware<S>[], Handler<Params, S, O>]
): App<S, [...R, { readonly method: 'HEAD'; readonly pattern: string; readonly out: ResolveOut<O> }]>;
export function head<
  S extends State = State,
  R extends readonly RouteDef[] = readonly RouteDef[]
,
  O = unknown
>(
  app: App<S, R>,
  pattern: string,
  ...chain: [...Middleware<S>[], Handler<never, S, O>]
): App<S, [...R, { readonly method: 'HEAD'; readonly pattern: string; readonly out: ResolveOut<O> }]> {
  return register(app, 'HEAD', pattern, chain) as App<
    S,
    [...R, { readonly method: 'HEAD'; readonly pattern: string; readonly out: ResolveOut<O> }]
  >;
}

export function options<
  P extends string,
  S extends State = State,
  R extends readonly RouteDef[] = readonly RouteDef[]
,
  O = unknown
>(
  app: App<S, R>,
  pattern: P,
  ...chain: [...Middleware<S>[], Handler<ParamsOf<P>, S, O>]
): App<S, [...R, { readonly method: 'OPTIONS'; readonly pattern: P; readonly out: ResolveOut<O> }]>;
export function options<
  S extends State = State,
  R extends readonly RouteDef[] = readonly RouteDef[]
,
  O = unknown
>(
  app: App<S, R>,
  pattern: string,
  ...chain: [...Middleware<S>[], Handler<Params, S, O>]
): App<S, [...R, { readonly method: 'OPTIONS'; readonly pattern: string; readonly out: ResolveOut<O> }]>;
export function options<
  S extends State = State,
  R extends readonly RouteDef[] = readonly RouteDef[]
,
  O = unknown
>(
  app: App<S, R>,
  pattern: string,
  ...chain: [...Middleware<S>[], Handler<never, S, O>]
): App<S, [...R, { readonly method: 'OPTIONS'; readonly pattern: string; readonly out: ResolveOut<O> }]> {
  return register(app, 'OPTIONS', pattern, chain) as App<
    S,
    [...R, { readonly method: 'OPTIONS'; readonly pattern: string; readonly out: ResolveOut<O> }]
  >;
}

export function all<
  P extends string,
  S extends State = State,
  R extends readonly RouteDef[] = readonly RouteDef[]
,
  O = unknown
>(
  app: App<S, R>,
  pattern: P,
  ...chain: [...Middleware<S>[], Handler<ParamsOf<P>, S, O>]
): App<S, [...R, { readonly method: 'ALL'; readonly pattern: P; readonly out: ResolveOut<O> }]>;
export function all<
  S extends State = State,
  R extends readonly RouteDef[] = readonly RouteDef[]
,
  O = unknown
>(
  app: App<S, R>,
  pattern: string,
  ...chain: [...Middleware<S>[], Handler<Params, S, O>]
): App<S, [...R, { readonly method: 'ALL'; readonly pattern: string; readonly out: ResolveOut<O> }]>;
export function all<
  S extends State = State,
  R extends readonly RouteDef[] = readonly RouteDef[]
,
  O = unknown
>(
  app: App<S, R>,
  pattern: string,
  ...chain: [...Middleware<S>[], Handler<never, S, O>]
): App<S, [...R, { readonly method: 'ALL'; readonly pattern: string; readonly out: ResolveOut<O> }]> {
  return register(app, 'ALL', pattern, chain) as App<
    S,
    [...R, { readonly method: 'ALL'; readonly pattern: string; readonly out: ResolveOut<O> }]
  >;
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
    // undebuggable in production. The sink is injectable per app.
    if (!isHttpError(error)) {
      (app.logError ?? console.error)(error);
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
  // The adapter parsed the URL when it built the request — reuse it
  // instead of re-parsing per dispatch. Falls back to a fresh parse for
  // bare `handle(app, request)` callers (edge runtimes, tests).
  let url = cachedUrl(request);
  if (url === undefined) {
    url = new URL(request.url);
    setCachedUrl(request, url);
  }
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
      ctx.res = newResponse(
        ctx,
        JSON.stringify({ error: 'Method Not Allowed' }),
        {
          status: 405,
          headers: {
            'content-type': 'application/json',
            Allow: allowedMethods.join(', '),
          },
        }
      );
    } else if (route === undefined) {
      if (app.onNotFound !== undefined) {
        await app.onNotFound(ctx);
      }
      if (ctx.res === undefined) {
        ctx.res = newResponse(
          ctx,
          JSON.stringify({ error: 'Not Found' }),
          { status: 404, headers: { 'content-type': 'application/json' } }
        );
      }
    } else {
      ctx.res = newResponse(
        ctx,
        JSON.stringify({ error: 'No response written' }),
        { status: 500, headers: { 'content-type': 'application/json' } }
      );
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
    ctx.res = newResponse(ctx, null, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }
  return ctx.res as Response;
}
