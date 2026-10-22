import type {
  BranchesOf,
  ChainIn,
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
  RouteErrors,
  ResolveOut,
  ResolveStatus,
  RouteFilter,
  State,
} from './types';

import type { ParamsOf } from './router';

import { isHttpError } from './errors';
import { compose } from './compose';
import { mapError } from './error-map';
import { cachedUrl, isLightRequest, isLightResponse, setCachedUrl } from './light';
import { neverSignal } from './signal';
import { drainPendingHeaders, newResponse } from './respond';
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
   * answers an anonymous 500. Receives the error and the request's `Ctx`;
   * the second parameter is additive, so `(error) => void` sinks keep
   * working. The default prints one leading context line —
   * `[s500] <method> <pathname>[ <request id>]` — then the error, so a
   * 500 is correlatable back to its request (the id is the request-id
   * battery's `state.requestId`, whatever header name it uses, falling
   * back to a literal `x-request-id` header). Inject a structured logger
   * here; the client still sees the anonymous 500 either way.
   */
  logError?: (error: unknown, ctx: Ctx) => void;
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
  logError: ((error: unknown, ctx: Ctx) => void) | undefined;
};

// Default matchers handed out by `createApp` (no `options.match` given).
// `mount` drops the sub-app's router — only a CUSTOM matcher is worth a
// warning, since dropping the default changes nothing (the parent's
// default behaves identically). WeakSet: keyed per closure, zero retention.
const defaultMatchers = new WeakSet<MatchFn>();

export function createApp<S extends State = State>(
  options: AppOptions<S> = {}
): App<S, []> {
  const match = options.match ?? createMatcher({ strict: options.strict });
  if (options.match === undefined) {
    defaultMatchers.add(match);
  }
  return {
    routes: Object.freeze([]),
    middlewares: Object.freeze([]),
    match,
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
 * The sub-app's `onError` IS carried: every mounted route is wrapped in a
 * route-scoped error boundary (outermost in its chain) that applies the
 * sub's error policy — a response the sub `onError` writes is adopted, a
 * decline (or a crashing handler) rethrows so the parent's policy maps it,
 * exactly like the standalone sub's dispatch would degrade.
 *
 * What cannot structurally travel is dropped with a one-time warning per
 * mount: `onNotFound` (the parent's 404 policy answers unmatched paths —
 * mounted routes are parent routes) and a custom `match` (the parent's
 * router dispatches the joined patterns). A default matcher is never
 * warned about — dropping it changes nothing.
 *
 * Pure data transform: `sub` is copied, never mutated, so one sub-app can
 * mount under many prefixes. Middlewares on an empty `sub` are lost (no
 * routes to carry them); gate on the prefix with a normal `use` middleware
 * instead. Post-mount registration on `sub` stays invisible to this mount
 * (snapshot semantics — the documented contract).
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
  if (sub.onNotFound !== undefined || !defaultMatchers.has(sub.match)) {
    console.warn(
      '[s200] mount: sub-app onNotFound/match are not carried by mount() — ' +
        'the parent app dispatches mounted routes; handle unmatched paths and ' +
        'custom matching on the parent (a prefixed route or middleware) instead'
    );
  }
  // Route-scoped error boundary carrying the sub's onError — outermost in
  // the mounted chain so errors from the sub's app-level middlewares, its
  // route middlewares, and the handler all reach the sub's policy, the
  // same surface a standalone dispatch gives it. Absent when the sub
  // defines no onError: the parent's policy then applies unchanged and
  // the mounted route carries zero extra runtime.
  const subOnError = sub.onError;
  const errorBoundary: Middleware<S> | undefined =
    subOnError === undefined
      ? undefined
      : async (ctx, next) => {
          try {
            await next();
          } catch (error) {
            // A crashing error handler propagates out of this boundary —
            // the parent maps it, the same degradation mapError applies
            // when an onError crashes.
            await subOnError(ctx, error);
            if (ctx.res === undefined) {
              // The sub's policy declined — the parent's applies.
              throw error;
            }
            // The adopted response bypassed newResponse — headers
            // deferred onto this ctx still ride it (mapError parity).
            drainPendingHeaders(ctx, ctx.res);
          }
        };
  const added: Route[] = [];
  for (const route of sub.routes) {
    const pattern = base === '' ? route.pattern : route.pattern === '/' ? base : `${base}${route.pattern}`;
    const inner: readonly Middleware[] =
      sub.middlewares.length === 0
        ? route.middlewares
        : ([...sub.middlewares, ...route.middlewares] as Middleware[]);
    const middlewares: readonly Middleware[] =
      errorBoundary === undefined
        ? inner
        : ([errorBoundary, ...inner] as Middleware[]);
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
  R extends readonly RouteDef[] = readonly RouteDef[],
  Ms extends Middleware<S>[] = Middleware<S>[]
>(
  app: App<S, R>,
  method: string,
  pattern: string,
  chain: readonly [...Ms, Handler<never, S>]
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

/**
 * One route def as a registrar appends it to the phantom log — the shared
 * record under every registrar's return type: the method literal, the
 * pattern, and the five channels (`in`, `errors`, `out`, `status`,
 * `branches`).
 */
type RouteDefEntry<
  M extends string,
  P extends string,
  Ms extends readonly unknown[],
  O
> = {
  readonly method: M;
  readonly pattern: P;
  readonly in: ChainIn<Ms>;
  readonly errors: RouteErrors<Ms, O>;
  readonly out: ResolveOut<O>;
  readonly status: ResolveStatus<O>;
  readonly branches: BranchesOf<O>;
};

/**
 * The signature every method registrar shares (`get`, `post`, …): two
 * overloads — a literal pattern gives the terminal handler
 * `ParamsOf<P>`-typed params; a plain `string` pattern (a dynamic route)
 * falls back to the loose `Params`. One shared implementation backs them
 * all (see `methodRegistrar`); every call lands in `register`.
 */
export type Registrar<M extends string> = {
  <
    P extends string,
    S extends State = State,
    R extends readonly RouteDef[] = readonly RouteDef[]
  ,
    O = unknown,
    Ms extends Middleware<S>[] = Middleware<S>[]
  >(
    app: App<S, R>,
    pattern: P,
    ...chain: [...Ms, Handler<ParamsOf<P>, S, O>]
  ): App<S, [...R, RouteDefEntry<M, P, Ms, O>]>;
  <
    S extends State = State,
    R extends readonly RouteDef[] = readonly RouteDef[]
  ,
    O = unknown,
    Ms extends Middleware<S>[] = Middleware<S>[]
  >(
    app: App<S, R>,
    pattern: string,
    ...chain: [...Ms, Handler<Params, S, O>]
  ): App<S, [...R, RouteDefEntry<M, string, Ms, O>]>;
};

/**
 * Builds one method registrar — the single implementation behind every
 * {@link Registrar} export. The body is type-erased on purpose: the
 * phantom route log comes from the signature, never from the runtime
 * value (`register` stores the erased route).
 */
function methodRegistrar<M extends string>(method: M): Registrar<M> {
  return ((
    app: App,
    pattern: string,
    ...chain: unknown[]
  ): App =>
    register(app, method, pattern, chain as [...Middleware[], Handler])) as Registrar<M>;
}

export const get: Registrar<'GET'> = methodRegistrar('GET');
export const post: Registrar<'POST'> = methodRegistrar('POST');
export const put: Registrar<'PUT'> = methodRegistrar('PUT');
export const patch: Registrar<'PATCH'> = methodRegistrar('PATCH');
export const del: Registrar<'DELETE'> = methodRegistrar('DELETE');
export const head: Registrar<'HEAD'> = methodRegistrar('HEAD');
export const options: Registrar<'OPTIONS'> = methodRegistrar('OPTIONS');
export const all: Registrar<'ALL'> = methodRegistrar('ALL');

/**
 * The dynamic-method registrar's signature — the {@link Registrar} shape
 * with the method as a first argument, the def's method branded
 * `Uppercase<M>`.
 */
export type AddRoute = {
  <
    P extends string,
    S extends State = State,
    M extends string = string,
    R extends readonly RouteDef[] = readonly RouteDef[]
  ,
    O = unknown,
    Ms extends Middleware<S>[] = Middleware<S>[]
  >(
    app: App<S, R>,
    method: M,
    pattern: P,
    ...chain: [...Ms, Handler<ParamsOf<P>, S, O>]
  ): App<S, [...R, RouteDefEntry<Uppercase<M>, P, Ms, O>]>;
  <
    S extends State = State,
    M extends string = string,
    R extends readonly RouteDef[] = readonly RouteDef[]
  ,
    O = unknown,
    Ms extends Middleware<S>[] = Middleware<S>[]
  >(
    app: App<S, R>,
    method: M,
    pattern: string,
    ...chain: [...Ms, Handler<Params, S, O>]
  ): App<S, [...R, RouteDefEntry<Uppercase<M>, string, Ms, O>]>;
};

export const addRoute: AddRoute = ((
  app: App,
  method: string,
  pattern: string,
  ...chain: unknown[]
): App => register(app, method, pattern, chain as [...Middleware[], Handler])) as AddRoute;

/**
 * One builder method's signature — the {@link Registrar} overloads with the
 * `app` argument bound (by {@link routes}) and the builder returned in its
 * place, the route appended to the phantom log exactly like the plain
 * registrar's return type.
 */
type BuilderMethod<
  M extends string,
  S extends State,
  R extends readonly RouteDef[]
> = {
  <
    P extends string,
    O = unknown,
    Ms extends Middleware<S>[] = Middleware<S>[]
  >(
    pattern: P,
    ...chain: [...Ms, Handler<ParamsOf<P>, S, O>]
  ): RoutesBuilder<S, [...R, RouteDefEntry<M, P, Ms, O>]>;
  <O = unknown, Ms extends Middleware<S>[] = Middleware<S>[]>(
    pattern: string,
    ...chain: [...Ms, Handler<Params, S, O>]
  ): RoutesBuilder<S, [...R, RouteDefEntry<M, string, Ms, O>]>;
};

/**
 * The chainable builder {@link routes} returns: one method per registrar
 * (`get`/`post`/`put`/`patch`/`del`/`head`/`options`/`all`) plus `use` and
 * `mount`, each returning the builder with the phantom `App` type updated
 * the same way the plain registrar's return type does — so the chain
 * threads client inference identically. `app` exposes that typed `App`
 * (the very object passed to `routes`; registration is immediate).
 */
export type RoutesBuilder<
  S extends State = State,
  R extends readonly RouteDef[] = readonly RouteDef[]
> = {
  /** The app every method registers on — typed with the chain's full log. */
  readonly app: App<S, R>;
  readonly get: BuilderMethod<'GET', S, R>;
  readonly post: BuilderMethod<'POST', S, R>;
  readonly put: BuilderMethod<'PUT', S, R>;
  readonly patch: BuilderMethod<'PATCH', S, R>;
  readonly del: BuilderMethod<'DELETE', S, R>;
  readonly head: BuilderMethod<'HEAD', S, R>;
  readonly options: BuilderMethod<'OPTIONS', S, R>;
  readonly all: BuilderMethod<'ALL', S, R>;
  readonly use: (
    prefixOrMiddleware: string | Middleware<S>,
    ...middlewares: Middleware<S>[]
  ) => RoutesBuilder<S, R>;
  readonly mount: <
    R2 extends readonly RouteDef[] = readonly RouteDef[],
    Prefix extends string = string
  >(
    prefix: Prefix,
    sub: App<S, R2>
  ) => RoutesBuilder<S, [...R, ...MountedDefs<R2, MountBase<Prefix>>]>;
};

/** One type-erased registrar method on the runtime builder object. */
type ErasedMethod<S extends State> = (
  pattern: string,
  ...chain: unknown[]
) => RoutesBuilderBase<S>;

/**
 * The type-erased runtime shape behind {@link routes}: every method
 * registers then returns the same builder object. The precise per-call
 * generics live only on {@link RoutesBuilder} — the phantom log comes
 * from signatures, never from runtime values.
 */
type RoutesBuilderBase<S extends State = State> = {
  readonly get: ErasedMethod<S>;
  readonly post: ErasedMethod<S>;
  readonly put: ErasedMethod<S>;
  readonly patch: ErasedMethod<S>;
  readonly del: ErasedMethod<S>;
  readonly head: ErasedMethod<S>;
  readonly options: ErasedMethod<S>;
  readonly all: ErasedMethod<S>;
  readonly use: (
    prefixOrMiddleware: string | Middleware<S>,
    ...middlewares: Middleware<S>[]
  ) => RoutesBuilderBase<S>;
  readonly mount: (prefix: string, sub: App<S>) => RoutesBuilderBase<S>;
  readonly app: App<S>;
};

/**
 * Chain sugar over the registrars: `routes(app)` returns a builder whose
 * `get`/`post`/`put`/`patch`/`del`/`head`/`options`/`all`/`use`/`mount`
 * methods delegate 1:1 to the plain functions and return the builder.
 * Registration is immediate — each call registers on `app` right away
 * (sugar, not a deferred model), so the original binding and the
 * builder's `.app` observe identical route tables. The phantom `App` type
 * threads through the chain, so `s200/client` inference off
 * `routes(app).…().app` matches the plain registrars byte for byte.
 *
 * ```ts
 * const app = createApp();
 * routes(app)
 *   .use(auth)
 *   .get('/users/:id', (ctx) => json(ctx, { id: ctx.params.id }))
 *   .post('/users', createUser);
 * const client = createClient(routes(app).get('/x', h).app);
 * ```
 */
export function routes<
  S extends State = State,
  R extends readonly RouteDef[] = readonly RouteDef[]
>(app: App<S, R>): RoutesBuilder<S, R> {
  const method = (m: string): ErasedMethod<S> => (pattern, ...chain) => {
    register(app, m, pattern, chain as [...Middleware<S>[], Handler<never, S>]);
    return builder;
  };
  const builder: RoutesBuilderBase<S> = {
    get: method('GET'),
    post: method('POST'),
    put: method('PUT'),
    patch: method('PATCH'),
    del: method('DELETE'),
    head: method('HEAD'),
    options: method('OPTIONS'),
    all: method('ALL'),
    use: (prefixOrMiddleware, ...middlewares) => {
      use(app, prefixOrMiddleware, ...middlewares);
      return builder;
    },
    mount: (prefix, sub) => {
      mount(app, prefix, sub);
      return builder;
    },
    app,
  };
  return builder as unknown as RoutesBuilder<S, R>;
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
  // returned Response is adopted only when nothing else wrote one first —
  // in light mode a returned light response is adopted too (duck-shaped:
  // `instanceof Response` misses it; only ever constructed on that path).
  // A returned HttpError is sugar for throwing it: rethrown here it flows
  // into the in-chain error boundary, so `onError`/`toErrorResponse` map
  // it exactly like a thrown one and the unwinding middlewares see the
  // stamped error response.
  const terminator: Middleware = async (routeCtx) => {
    const returned = await route.handler(routeCtx);
    if (routeCtx.res === undefined) {
      if (returned instanceof Response) {
        routeCtx.res = returned;
      } else if (
        isLightRequest(routeCtx.req) && isLightResponse(returned)
      ) {
        routeCtx.res = returned as unknown as Response;
      } else if (isHttpError(returned)) {
        throw returned;
      }
    }
    // A response adopted here (returned rather than written) bypassed
    // newResponse — apply any headers deferred onto this ctx first.
    if (routeCtx.res !== undefined) {
      drainPendingHeaders(routeCtx, routeCtx.res);
    }
  };
  const chain = compose([...route.middlewares, terminator]);
  routeChainCache.set(route, chain);
  return chain;
}

/**
 * Per-request initialization for {@link handle}. `signal` seeds
 * {@link Ctx.signal} — adapters pass the client-disconnect signal here so
 * middlewares and handlers can race it; omitted, the shared never-aborted
 * default applies with zero per-request allocation.
 */
export type HandleInit = { signal?: AbortSignal };

export async function handle<S extends State = State>(
  app: App<S>,
  request: Request,
  init?: HandleInit
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
    // The shared never-aborted signal unless the adapter passed one — no
    // per-request allocation on the default path.
    signal: init?.signal ?? neverSignal(),
    // The matched route, by reference into `app.routes` — undefined on the
    // 404/405 fallback paths, where no route's handler ran. Read-only.
    route,
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
