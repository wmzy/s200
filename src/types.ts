/**
 * Shared data shapes of s200. Pure types — no runtime code lives here.
 *
 * @module
 */

// Circular on purpose: Plugin needs App's shape and app.ts needs these
// types. `import type` keeps it a paper cycle — erased at compile time.
import type { App } from './app';

/** Path params captured from a route pattern, keyed by `:name` / `*name`. */
export type Params = Record<string, string>;

/** One query-name list entry: `'page&limit'` → `'page' | 'limit'`. */
type QueryName<QS extends string> = QS extends `${infer Head}&${infer Tail}`
  ? Head | QueryName<Tail>
  : QS;

/**
 * Compile-time shape of a query string: `QueryOf<'page&limit'>` is
 * `{ page?: string | string[]; limit?: string | string[] }` — exactly the
 * shape `parseQuery` (see `s200/query`) produces: repeated keys collect
 * into arrays, and every key is optional.
 */
export type QueryOf<QS extends string> = Partial<
  Record<QueryName<QS>, string | string[]>
>;

/**
 * The default per-request typed state bag. Extend it per app via
 * declaration merging (koa's `DefaultState` trick):
 *
 * ```ts
 * declare module 's200' {
 *   interface State { user: User }
 * }
 * ```
 *
 * For apps that must not share one global shape, skip the merge and pass a
 * per-app interface to `createApp<MyState>()` instead — `ctx.state` is then
 * `MyState` throughout that app's middlewares, handlers, and error policy.
 * Per-app states are interfaces (like this one): only interfaces satisfy
 * the `[key: string]: unknown` index-signature constraint.
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions, @typescript-eslint/consistent-indexed-object-style -- must be an interface with an index signature: declaration merging (koa's DefaultState pattern) only extends interfaces, and `type State = Record<...>` cannot be augmented
export interface State {
  [key: string]: unknown;
}

/** Continuation into the next middleware — the onion's inner layer. */
export type Next = () => Promise<void>;

/**
 * Onion middleware: runs before and/or after `await next()`. The `S` type
 * parameter carries the per-app state shape — it defaults to the global
 * {@link State} interface, so batteries typed `Middleware` plug into any
 * app; an app with `createApp<MyState>()` types its own middlewares as
 * `Middleware<MyState>`.
 */
export type Middleware<S extends State = State> = (
  ctx: Ctx<Params, S>,
  next: Next
) => Promise<void> | void;

/**
 * Route terminal handler. May return a `Response` — `handle` adopts it as
 * `ctx.res` when nothing was written yet.
 */
export type Handler<P extends Params = Params, S extends State = State> = (
  ctx: Ctx<P, S>
) => unknown | Promise<unknown>;

/**
 * Per-request context. The unit of mutation: middlewares and handlers write
 * `state` and `res` in place; `req` stays pinned to the incoming request.
 * `url` is the request URL parsed once — reuse it instead of re-parsing.
 * `S` is the per-app state shape (`createApp<MyState>()`); batteries that
 * stay on the default `State` are assignable to any app.
 */
export type Ctx<P extends Params = Params, S extends State = State> = {
  readonly req: Request;
  readonly url: URL;
  params: P;
  query: URLSearchParams;
  state: S;
  res: Response | undefined;
};

/** One parsed pattern segment: literal, `:param`, or terminal `*wildcard`. */
export type Segment =
  | { readonly _tag: 'static'; value: string }
  | { readonly _tag: 'param'; name: string }
  | { readonly _tag: 'wildcard'; name: string };

/** An immutable registration entry produced by `createRoute`. */
export type Route<P extends Params = Params> = {
  /** Uppercase HTTP method; `'ALL'` matches any method. */
  readonly method: string;
  readonly pattern: string;
  readonly segments: readonly Segment[];
  /** Chain scoped to this route: runs after the app chain, before the handler. */
  readonly middlewares: readonly Middleware[];
  readonly handler: Handler<P>;
};

/**
 * What a match yields: the route plus captured params, or — when the path
 * matched but no route's method did — the methods that would have matched
 * (the `Allow` list for a 405).
 */
export type MatchResult =
  | { readonly route: Route; readonly params: Params }
  | { readonly allowedMethods: readonly string[] };

/** Pluggable matcher — swap in a radix tree etc. without touching `App`. */
export type MatchFn = (
  routes: readonly Route[],
  method: string,
  pathname: string
) => MatchResult | undefined;

/** Maps a thrown value to a response; may write `ctx.res` itself. */
export type ErrorHandler<S extends State = State> = (
  ctx: Ctx<Params, S>,
  error: unknown
) => Promise<void> | void;

/** Last chance to answer an unmatched request; default is a 404. */
export type NotFoundHandler<S extends State = State> = (
  ctx: Ctx<Params, S>
) => Promise<void> | void;

/** Extension hook over the mutable `App` data structure. */
export type Plugin<S extends State = State> = (app: App<S>) => void;
