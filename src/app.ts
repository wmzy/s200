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
  MountedScoped,
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
  ScopedOf,
  ScopedPush,
  ScopedState,
  State,
  StateOf,
} from './types';

import type { ParamsOf } from './router';

import { isHttpError } from './errors';
import { compose } from './compose';
import { mapError, runOnError } from './error-map';
import { cachedUrl, isLightRequest, isLightResponse, setCachedUrl } from './light';
import { neverSignal } from './signal';
import { adoptResponse, drainPendingHeaders, jsonFallback, rebuild } from './respond';
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
   * answers an anonymous 500. One exception since the `cause` channel:
   * an `HttpError` built with a `cause` (`httpError(status, msg, body?,
   * headers?, cause)`) is routed here too — the client still gets its
   * status/body, the sink sees the root cause. Receives the error and
   * the request's `Ctx`; the second parameter is additive, so
   * `(error) => void` sinks keep working. The default prints one leading
   * context line — `[s500] <method> <pathname>[ <request id>]` — then
   * the error (a third `cause` argument when one is present), so a 500
   * is correlatable back to its request (the id is the request-id
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
 *
 * `G` is a phantom type parameter too — a compile-time log of the app's
 * prefix-scoped state injections (`use(app, '/admin', withUser)` parks its
 * brand there). Registrars filter it per route pattern, so handlers under
 * the prefix read the injected keys typed while the app-wide `S` stays
 * untouched. Never part of the runtime shape.
 */
export type App<
  S extends State = State,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- R is a phantom type parameter: a compile-time route log consumed by s200/client, never part of the runtime shape
  R extends readonly RouteDef[] = readonly RouteDef[],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- G is a phantom type parameter: a compile-time log of prefix-scoped state injections, filtered per route by the registrars, never part of the runtime shape
  G extends readonly ScopedState[] = readonly []
> = {
  routes: readonly Route[];
  middlewares: readonly Middleware<S>[];
  match: MatchFn;
  onError: ErrorHandler<S> | undefined;
  onNotFound: NotFoundHandler<S> | undefined;
  logError: ((error: unknown, ctx: Ctx) => void) | undefined;
};

// Default matchers handed out by `createApp` (no `options.match` given),
// with the strictness they were built for. `mount` drops the sub-app's
// router — a CUSTOM matcher is worth a warning, and so is a default
// matcher whose strictness differs from the parent's: the parent's
// matcher dispatches the mounted routes, so a sub-app created with
// `strict: false` loses its trailing-slash tolerance. WeakMap: keyed per
// closure, zero retention.
const defaultMatchers = new WeakMap<MatchFn, boolean>();

export function createApp<S extends State = State>(
  options: AppOptions<S> = {}
): App<S, []> {
  const match = options.match ?? createMatcher({ strict: options.strict });
  if (options.match === undefined) {
    defaultMatchers.set(match, options.strict ?? true);
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
 * Where a prefix group parks the last `Response` one of its middlewares
 * returned. A private symbol: it never shows up in the app's data, in
 * `Object.keys`, or in a serialized ctx.
 */
const GROUP_RETURNED = Symbol('s200.groupReturned');

/** The ctx view that carries a prefix group's captured response. */
type GroupCtx = Ctx<Params, State> & {
  [GROUP_RETURNED]?: Response | undefined;
};

/** The ctx as the group carrier — a cast, not a copy: the ctx is the
 * request's own mutable state. */
function groupCtx<S extends State>(ctx: Ctx<Params, S>): GroupCtx {
  return ctx as unknown as GroupCtx;
}

/** The prefix form's state widening, shared by `use` and its
 * `RoutesBuilder.use` mirror: `''`/`'/'` prefixes ARE the global form (the
 * brands widen the app `S`, the scoped log stays untouched); any other
 * prefix contributes nothing to `S` — its brands park in the scoped log
 * ({@link PrefixedScoped}) for the registrars to filter per pattern. */
type PrefixedState<
  S extends State,
  Prefix extends string,
  Ms extends readonly unknown[]
> = S & (Prefix extends '' | '/' ? StateOf<Ms> : unknown);

/** The prefix form's scoped-log update, shared by the same two surfaces:
 * nothing for `''`/`'/'` (global form), else the brands pushed under the
 * prefix. */
type PrefixedScoped<
  G extends readonly ScopedState[],
  Prefix extends string,
  Ms extends readonly unknown[]
> = Prefix extends '' | '/' ? G : ScopedPush<G, Prefix, StateOf<Ms>>;

/**
 * Prefix-scoped middlewares: the group runs only for requests whose
 * pathname falls under `prefix` (`/admin` matches `/admin`, `/admin/…`; a
 * prefix may contain params — `/users/:id` scopes per user). Scope checks
 * use the router's own matching (strict trailing slashes), so behavior
 * matches routing. Scoped groups nest in registration order like ordinary
 * middlewares; `next()` from inside one continues into the next scope and
 * the route chain below. A prefix with no middlewares is a programmer
 * error — it typechecks, but `use` throws at registration.
 *
 * ## The state channel
 *
 * A middleware branded by `withState<X>` (core barrel) advertises the
 * keys it writes onto `ctx.state`, and the brand travels three ways:
 *
 * - **Global form** (`use(app, withUser)`): every argument's brand is
 *   collected into the returned app's `S`, so all downstream middlewares
 *   and handlers read the injected keys typed.
 * - **Prefix form** (`use(app, '/admin', withUser)`): the app-wide `S` is
 *   NOT widened. The brand is parked in the app's phantom scoped log
 *   (see `App`'s `G` parameter) and registrars intersect it into exactly
 *   the routes whose pattern falls under the prefix — segment-wise, so
 *   `/admin`, `/admin/x`, and param (`/users/:id`) prefixes typecheck like
 *   they dispatch. Routes outside the prefix never see the keys (their
 *   `ctx.state` keeps the loose view, and app-level middlewares still
 *   type against the plain `S`). Non-literal patterns or prefixes (a
 *   dynamic `string`) cannot be checked at compile time: the runtime
 *   scoping still applies, the types stay conservative.
 * - **Route chains** (`get(app, '/x', withUser, handler)`): the brands of
 *   the chain's middlewares are threaded into that route's handler —
 *   `ctx.state` sees the app `S`, the matching scoped brands, and the
 *   chain's brands intersected.
 *
 * Plain, unbranded middlewares are the identity case everywhere: their
 * contribution collapses and types are unchanged.
 */
export function use<
  S extends State = State,
  R extends readonly RouteDef[] = readonly RouteDef[],
  G extends readonly ScopedState[] = readonly [],
  M extends Middleware<S> = Middleware<S>,
  Ms extends Middleware<S>[] = Middleware<S>[]
>(
  app: App<S, R, G>,
  prefixOrMiddleware: M,
  ...middlewares: Ms
): App<S & StateOf<[M, ...Ms]>, R, G>;
export function use<
  S extends State = State,
  R extends readonly RouteDef[] = readonly RouteDef[],
  G extends readonly ScopedState[] = readonly [],
  Prefix extends string = string,
  Ms extends Middleware<S>[] = Middleware<S>[]
>(
  app: App<S, R, G>,
  prefix: Prefix,
  ...middlewares: Ms
): App<PrefixedState<S, Prefix, Ms>, R, PrefixedScoped<G, Prefix, Ms>>;
export function use<
  S extends State = State,
  R extends readonly RouteDef[] = readonly RouteDef[],
  G extends readonly ScopedState[] = readonly []
>(
  app: App<S, R, G>,
  prefixOrMiddleware: string | Middleware<S>,
  ...middlewares: Middleware<S>[]
): App<S, R, G>;
export function use<S extends State = State>(
  app: App<S>,
  prefixOrMiddleware: string | Middleware<S>,
  ...middlewares: Middleware<S>[]
): App<S> {
  if (typeof prefixOrMiddleware === 'string') {
    const prefix = prefixOrMiddleware;
    if (middlewares.length === 0) {
      throw new Error(
        `use(app, prefix, ...middlewares): at least one middleware is required for prefix '${prefix}'`
      );
    }
    // '' and '/' scope everything — equivalent to the global form, so
    // delegate to it rather than duplicating the tail's append (one append
    // site for the global idiom). `first` is a middleware by the length
    // check above; the cast only sheds the index-access undefined.
    if (prefix === '' || prefix === '/') {
      const [first, ...rest] = middlewares;
      return use(app, first as Middleware<S>, ...rest);
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
    //
    // The group's resolved value is its LAST middleware's return value, so
    // a middleware that awaits `next()` without returning it swallows a
    // Response another middleware in the group returned — and the
    // WebSocket upgrade decision honors a returned Response. Each
    // middleware therefore parks the Response it saw on the ctx (a private
    // symbol, invisible to the app's data) and the guard hands the last
    // one to the outer chain. HTTP ignores middleware returns (only a
    // handler's return is adopted), so nothing changes there.
    const group = compose(
      (middlewares as readonly Middleware<S>[]).map((middleware) =>
        async (ctx: Ctx<Params, S>, next: Next) => {
          const returned: unknown = await middleware(ctx, next);
          if (returned instanceof Response) {
            groupCtx(ctx)[GROUP_RETURNED] = returned;
          }
          return returned as never;
        }
      )
    );
    const guard: Middleware<S> = async (ctx, next) => {
      const pathname = ctx.url.pathname;
      const scoped =
        segments === undefined
          ? pathname === base || pathname.startsWith(`${base}/`)
          : matchSegments(segments, pathname) !== undefined;
      if (!scoped) {
        return next();
      }
      const carrier = groupCtx(ctx);
      carrier[GROUP_RETURNED] = undefined;
      const returned: unknown = await group(ctx, next);
      const answer = returned instanceof Response ? returned : carrier[GROUP_RETURNED];
      // The seam: `Middleware` types the return as void, but the upgrade
      // decision reads the runtime value.
      return answer as never;
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
  G extends readonly ScopedState[] = readonly [],
  M extends string = string,
  P extends string = string
>(
  app: App<S, R, G>,
  method: M,
  pattern: P
): App<S, RouteFilter<R, Uppercase<M>, P>, G> {
  const normalized = method.toUpperCase();
  const filtered = app.routes.filter(
    (route) => !(route.method === normalized && route.pattern === pattern)
  );
  if (filtered.length !== app.routes.length) {
    app.routes = Object.freeze(filtered);
  }
  return app as App<S, RouteFilter<R, Uppercase<M>, P>, G>;
}

/**
 * Applies a plugin (any function over the mutable `App`) and returns the
 * app. Routes a plugin registers are not tracked in `R` — the plugin's
 * signature cannot describe them — so `s200/client` does not type them.
 * For client-typed routes, register through the registrars directly.
 */
export function usePlugin<
  S extends State = State,
  R extends readonly RouteDef[] = readonly RouteDef[],
  G extends readonly ScopedState[] = readonly []
>(app: App<S, R, G>, plugin: Plugin<S>): App<S, R, G> {
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
 * decline (or a crashing handler) rethrows so the parent's policy maps it.
 * That last step differs from a standalone dispatch: standalone, a
 * declining `onError` leaves the response unwritten and the in-chain
 * terminal answers `500 {"error":"No response written"}`; mounted, the
 * parent's policy answers instead (its default: the error is logged and
 * the response is `500 {"error":"Internal Server Error"}`).
 *
 * What cannot structurally travel is dropped with a one-time warning per
 * mount: `onNotFound` (the parent's 404 policy answers unmatched paths —
 * mounted routes are parent routes) and a custom `match` (the parent's
 * router dispatches the joined patterns). A default matcher is dropped
 * silently only when it behaves like the parent's — a sub-app created with
 * `strict: false` loses its trailing-slash tolerance under a strict
 * parent, and that is warned about too.
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
  Prefix extends string = string,
  G extends readonly ScopedState[] = readonly [],
  G2 extends readonly ScopedState[] = readonly []
>(
  app: App<S, R, G>,
  prefix: Prefix,
  sub: App<S, R2, G2>
): App<S, [...R, ...MountedDefs<R2, MountBase<Prefix>>], [...G, ...MountedScoped<G2, MountBase<Prefix>>]> {
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
  // A default matcher is normally interchangeable with the parent's — but
  // not when their strictness differs: the parent's matcher dispatches the
  // mounted routes, so a `strict: false` sub-app loses its trailing-slash
  // tolerance (`/users/` stops matching its `/users` route) with no other
  // trace. Warn like the dropped custom matcher above.
  const subStrict = defaultMatchers.get(sub.match);
  const parentStrict = defaultMatchers.get(app.match);
  if (subStrict !== undefined && parentStrict !== undefined && subStrict !== parentStrict) {
    console.warn(
      `[s200] mount: the sub-app's strict:${subStrict} is not carried by mount() — ` +
        `the parent dispatches the mounted routes with strict:${parentStrict}; ` +
        'register the trailing-slash variant on the parent instead'
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
            // A declining sub policy rethrows — the parent's applies. A
            // crashing handler propagates out of this boundary too: the
            // parent maps it, the same degradation mapError applies when
            // an onError crashes.
            if ((await runOnError(subOnError, ctx, error)) === 'declined') {
              throw error;
            }
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
  return app as App<
    S,
    [...R, ...MountedDefs<R2, MountBase<Prefix>>],
    [...G, ...MountedScoped<G2, MountBase<Prefix>>]
  >;
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

/** The literal-overload constraint (and default) for a registrar chain's
 * middleware tuple: the chain's middlewares run inside every scope guard
 * matching the pattern, so they type against the app `S` plus those
 * scoped brands. Written out by `Registrar`, `AddRoute`, and
 * `BuilderMethod`. */
type ScopedMs<
  S extends State,
  G extends readonly ScopedState[],
  P extends string
> = Middleware<S & ScopedOf<G, P>>[];

/**
 * A literal-pattern registrar's `[...middlewares, handler]` rest tuple:
 * the terminal handler's params come from the pattern (`ParamsOf<P>`) and
 * its `ctx.state` is the app `S`, the prefix-scoped brands matching `P`,
 * and the chain's own brands (`StateOf<Ms>`). This is an inference
 * position — `Ms` infers from the spread — so the alias must expand to
 * exactly the tuple the overloads used to spell out; the generic
 * parameter lists on the public signatures stay put.
 */
type LiteralChainTail<
  P extends string,
  S extends State,
  G extends readonly ScopedState[],
  Ms extends readonly unknown[],
  O
> = [...Ms, Handler<ParamsOf<P>, S & ScopedOf<G, P> & StateOf<Ms>, O>];

/**
 * A dynamic-pattern registrar's rest tuple: a plain `string` pattern
 * cannot be prefix-matched at compile time, so the handler's params fall
 * back to the loose `Params` and its `ctx.state` sees the app `S` plus
 * the chain's brands only. Shared by the same three registrar surfaces.
 */
type DynChainTail<S extends State, Ms extends readonly unknown[], O> = [
  ...Ms,
  Handler<Params, S & StateOf<Ms>, O>
];

/**
 * The signature every method registrar shares (`get`, `post`, …): two
 * overloads — a literal pattern gives the terminal handler
 * `ParamsOf<P>`-typed params; a plain `string` pattern (a dynamic route)
 * falls back to the loose `Params`. One shared implementation backs them
 * all (see `methodRegistrar`); every call lands in `register`.
 *
 * The chain's state brands thread into the handler: its `ctx.state` is
 * the app `S` intersected with the prefix-scoped brands matching `P`
 * (literal patterns only — a dynamic pattern cannot be prefix-matched at
 * compile time) and with the `_state` brands of the chain's own
 * middlewares (`get(app, '/x', withUser, handler)` types `ctx.state.user`).
 * The chain's middlewares type against the app `S` plus the matching
 * scoped brands (they run inside every scope guard); a branded consumer
 * with an explicit read-type still wants the `use` order enforcement —
 * chain middlewares do not progressively see earlier chain brands.
 */
export type Registrar<M extends string> = {
  <
    P extends string,
    S extends State = State,
    R extends readonly RouteDef[] = readonly RouteDef[]
  ,
    G extends readonly ScopedState[] = readonly [],
    O = unknown,
    Ms extends ScopedMs<S, G, P> = ScopedMs<S, G, P>
  >(
    app: App<S, R, G>,
    pattern: P,
    ...chain: LiteralChainTail<P, S, G, Ms, O>
  ): App<S, [...R, RouteDefEntry<M, P, Ms, O>]>;
  <
    S extends State = State,
    R extends readonly RouteDef[] = readonly RouteDef[]
  ,
    G extends readonly ScopedState[] = readonly [],
    O = unknown,
    Ms extends Middleware<S>[] = Middleware<S>[]
  >(
    app: App<S, R, G>,
    pattern: string,
    ...chain: DynChainTail<S, Ms, O>
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
    G extends readonly ScopedState[] = readonly [],
    O = unknown,
    Ms extends ScopedMs<S, G, P> = ScopedMs<S, G, P>
  >(
    app: App<S, R, G>,
    method: M,
    pattern: P,
    ...chain: LiteralChainTail<P, S, G, Ms, O>
  ): App<S, [...R, RouteDefEntry<Uppercase<M>, P, Ms, O>]>;
  <
    S extends State = State,
    M extends string = string,
    R extends readonly RouteDef[] = readonly RouteDef[]
  ,
    G extends readonly ScopedState[] = readonly [],
    O = unknown,
    Ms extends Middleware<S>[] = Middleware<S>[]
  >(
    app: App<S, R, G>,
    method: M,
    pattern: string,
    ...chain: DynChainTail<S, Ms, O>
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
  R extends readonly RouteDef[],
  G extends readonly ScopedState[] = readonly []
> = {
  <
    P extends string,
    O = unknown,
    Ms extends ScopedMs<S, G, P> = ScopedMs<S, G, P>
  >(
    pattern: P,
    ...chain: LiteralChainTail<P, S, G, Ms, O>
  ): RoutesBuilder<S, [...R, RouteDefEntry<M, P, Ms, O>], G>;
  <O = unknown, Ms extends Middleware<S>[] = Middleware<S>[]>(
    pattern: string,
    ...chain: DynChainTail<S, Ms, O>
  ): RoutesBuilder<S, [...R, RouteDefEntry<M, string, Ms, O>], G>;
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
  R extends readonly RouteDef[] = readonly RouteDef[],
  G extends readonly ScopedState[] = readonly []
> = {
  /** The app every method registers on — typed with the chain's full log. */
  readonly app: App<S, R, G>;
  readonly get: BuilderMethod<'GET', S, R, G>;
  readonly post: BuilderMethod<'POST', S, R, G>;
  readonly put: BuilderMethod<'PUT', S, R, G>;
  readonly patch: BuilderMethod<'PATCH', S, R, G>;
  readonly del: BuilderMethod<'DELETE', S, R, G>;
  readonly head: BuilderMethod<'HEAD', S, R, G>;
  readonly options: BuilderMethod<'OPTIONS', S, R, G>;
  readonly all: BuilderMethod<'ALL', S, R, G>;
  readonly use: {
    <M extends Middleware<S>, Ms extends Middleware<S>[]>(
      ...middlewares: [M, ...Ms]
    ): RoutesBuilder<S & StateOf<[M, ...Ms]>, R, G>;
    <Prefix extends string, Ms extends Middleware<S>[]>(
      prefix: Prefix,
      ...middlewares: Ms
    ): RoutesBuilder<PrefixedState<S, Prefix, Ms>, R, PrefixedScoped<G, Prefix, Ms>>;
    (prefixOrMiddleware: string | Middleware<S>, ...middlewares: Middleware<S>[]): RoutesBuilder<
      S,
      R,
      G
    >;
  };
  readonly mount: <
    R2 extends readonly RouteDef[] = readonly RouteDef[],
    Prefix extends string = string,
    G2 extends readonly ScopedState[] = readonly []
  >(
    prefix: Prefix,
    sub: App<S, R2, G2>
  ) => RoutesBuilder<
    S,
    [...R, ...MountedDefs<R2, MountBase<Prefix>>],
    [...G, ...MountedScoped<G2, MountBase<Prefix>>]
  >;
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
  R extends readonly RouteDef[] = readonly RouteDef[],
  G extends readonly ScopedState[] = readonly []
>(app: App<S, R, G>): RoutesBuilder<S, R, G> {
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
  return builder as unknown as RoutesBuilder<S, R, G>;
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
        adoptResponse(routeCtx, returned);
      } else if (
        isLightRequest(routeCtx.req) && isLightResponse(returned)
      ) {
        adoptResponse(routeCtx, returned as unknown as Response);
      } else if (isHttpError(returned)) {
        throw returned;
      }
    }
    // A response the handler wrote itself (raw `ctx.res = …`, not a
    // respond helper) also bypassed newResponse — apply any headers
    // deferred onto this ctx first. The adoptions above already drained;
    // this is idempotent.
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
      jsonFallback(ctx, 405, 'Method Not Allowed', {
        Allow: allowedMethods.join(', '),
      });
    } else if (route === undefined) {
      if (app.onNotFound !== undefined) {
        await app.onNotFound(ctx);
      }
      if (ctx.res === undefined) {
        jsonFallback(ctx, 404, 'Not Found');
      }
    } else {
      jsonFallback(ctx, 500, 'No response written');
    }
  };
  // The fallback's two call sites — the in-chain terminal below and the
  // post-error rerun further down — share one error move: a throw while
  // the terminal materializes is mapped through the same boundary as any
  // chain error, so the unwind sees the mapped response either way.
  const runFallback = async (): Promise<void> => {
    try {
      await fallback();
    } catch (error) {
      await mapError(app, ctx, error);
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
      await runFallback();
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
    await runFallback();
  }
  if (request.method === 'HEAD') {
    // fallback()/mapError guarantee a response above, but the write happens
    // inside a closure tsc cannot see through.
    const res = ctx.res as Response;
    // HEAD must not carry a body, but content-length stays so the client can
    // learn the size a GET would have returned.
    ctx.res = rebuild(ctx, res, null);
  }
  return ctx.res as Response;
}
