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
 * `ctx.res` when nothing was written yet — or return an `HttpError`, which
 * `handle` treats as sugar for throwing it (same error boundary, same
 * `onError`/envelope mapping). `O` is the return type; when it is a branded
 * {@link JsonResponse}, the route's phantom log entry records the body type
 * for `s200/client` (`ResolveOut`).
 */
export type Handler<P extends Params = Params, S extends State = State, O = unknown> = (
  ctx: Ctx<P, S>
) => O | Promise<O>;

/**
 * Per-request context. The unit of mutation: middlewares and handlers write
 * `state` and `res` in place; `req` stays pinned to the incoming request.
 * `url` is the request URL parsed once — reuse it instead of re-parsing.
 * `S` is the per-app state shape (`createApp<MyState>()`); batteries that
 * stay on the default `State` are assignable to any app.
 *
 * `signal` carries cooperative cancellation. By default it is a shared,
 * never-aborted signal (zero per-request cost); adapters that can detect
 * client disconnects seed it with the request's disconnect signal, and
 * middlewares may swap it on the way in and restore it on unwind (e.g. a
 * timeout battery narrows it with `AbortSignal.any`). Readers race it —
 * `await fetch(url, { signal: ctx.signal })` — instead of polling.
 */
export type Ctx<P extends Params = Params, S extends State = State> = {
  readonly req: Request;
  readonly url: URL;
  params: P;
  query: URLSearchParams;
  state: S;
  signal: AbortSignal;
  res: Response | undefined;
};

/** One parsed pattern segment: literal, `:param` (optionally `:param?`),
 * or terminal `*wildcard`. */
export type Segment =
  | { readonly _tag: 'static'; value: string }
  | { readonly _tag: 'param'; name: string; optional: boolean }
  | { readonly _tag: 'wildcard'; name: string };

/**
 * One registered route's compile-time signature: normalized method plus the
 * pattern literal, and — when the terminal handler returned a branded
 * {@link JsonResponse} — the response body type (`out`). Carried by
 * {@link App}'s phantom `R` parameter so `s200/client` can type paths,
 * params, and `json()` bodies from the app itself.
 */
export type RouteDef = {
  readonly method: string;
  readonly pattern: string;
  readonly out?: unknown;
  /** The response status type carried out of a handler return type
   * (a branded responder's `_status`, `number` when unbranded) — the
   * status-side twin of `out`. */
  readonly status?: unknown;
  /** Input types collected from the route's gate middlewares (`_in`
   * phantoms) — the request-side twin of `out`. */
  readonly in?: unknown;
  /** The error branches a route's `throws` gates declare (`_errors`
   * phantoms) merged with the ones its handler's returned `httpError`
   * values infer — the error-side twin of `in`: statuses the route may
   * answer with and the body shapes those answers ship. */
  readonly errors?: unknown;
  /** The status → body pairs a handler's return union declares
   * ({@link BranchesOf}) — keeps the pairing that separate `out`/`status`
   * extraction loses, so `s200/client` can discriminate on `status`. */
  readonly branches?: unknown;
};

/**
 * The response-body type carried out of a handler return type: unwraps the
 * Promise, extracts a branded {@link JsonResponse}'s body, and falls back
 * to `unknown` for everything else (plain `Response`, `redirect`, streams).
 */
export type ResolveOut<O> = [O] extends [Promise<infer P>]
  ? ResolveOut<P>
  : O extends { readonly _out?: infer T }
    ? T
    : unknown;

/**
 * The response-status type carried out of a handler return type: unwraps
 * the Promise, extracts a status-branded responder's `_status` (a union of
 * literals across a union of returns), and falls back to `number` for
 * everything else (plain `Response`, unbranded builders). The twin of
 * {@link ResolveOut} — deliberately NOT defaulted to a helper's default
 * status: a handler returning `json(ctx, x)` brands 200 because that is
 * what ships, one returning `json(ctx, x, { status: 404 })` brands 404.
 */
export type ResolveStatus<O> = [O] extends [Promise<infer P>]
  ? ResolveStatus<P>
  : O extends { readonly _status?: infer S }
    ? S
    : number;

/** Union → intersection: a union of function types is not an overload set
 * (a call would have to match every parameter list at once); the
 * intersection is. Used to merge per-gate phantom inputs into one input
 * shape. */
export type UnionToIntersection<T> = (T extends unknown ? (x: T) => void : never) extends (
  x: infer I
) => void
  ? I
  : never;

/** The phantom `_in` a chain member carries, `never` when it has none. */
type PhantomIn<M> = M extends { readonly _in?: infer X } ? X : never;

/**
 * The input shape a route's gate middlewares declare: every chain member
 * may brand itself with `readonly _in?: { … }` (see `s200/validate`'s
 * `jsonBody` and `s200/query`'s `queryParams`), and the brands intersect —
 * `jsonBody` + `queryParams` yields `{ json: T } & { query: Q }`. A chain
 * with no branded members collapses to `unknown` (`never` would poison
 * every downstream intersection), so plain routes stay untyped on the
 * input side.
 */
export type ChainIn<Ms extends readonly unknown[]> = [PhantomIn<Ms[number]>] extends [infer U]
  ? [U] extends [never]
    ? unknown
    : UnionToIntersection<U>
  : never;

/** The phantom `_errors` a chain member carries, `never` when it has none. */
type PhantomErrors<M> = M extends { readonly _errors?: infer E } ? E : never;

/**
 * The error branches a route's `throws` gates declare: every chain member
 * may brand itself with `readonly _errors?: { … }` (see `s200`'s `throws`
 * gate), and the brands intersect — several gates merge their
 * status → body-shape records. A chain with no branded members collapses
 * to an empty record (`Record<never, never>`, not `unknown`:
 * `keyof`/value lookups stay neutral downstream), so plain routes are
 * untouched on the error side.
 */
export type ChainErrors<Ms extends readonly unknown[]> = [PhantomErrors<Ms[number]>] extends [
  infer U
]
  ? [U] extends [never]
    ? Record<never, never>
    : UnionToIntersection<U>
  : never;

/** Unwraps the `Promise` members of a handler's return union: `A | Promise<B>`
 * distributes into `A | B`, so sync and async branches flow alike through
 * the phantom extractors below (a tuple-guarded unwrap would lose the
 * mixed-union members instead of distributing them). */
type Unpromise<O> = O extends Promise<infer P> ? Unpromise<P> : O;

/** A handler return member shaped like an {@link HttpError} value. The
 * `_tag` discriminant is the only safe key to test — a bare
 * `{ status, body }` match would swallow ordinary objects. */
type HttpErrorBrand = {
  readonly _tag: 'HttpError';
  readonly status: number;
  readonly body?: unknown;
};

/** One returned-`HttpError` member's error-channel branch: the default
 * `{ error: string }` envelope when it carries no body, the body itself
 * when it does — exactly what `toErrorResponse` ships for that value. */
type OutErrorBranch<M> = M extends { readonly body?: infer B }
  ? [B] extends [undefined]
    ? { error: string }
    : Exclude<B, undefined>
  : never;

/** One return member's contribution to the errors channel: `HttpError`
 * members contribute their status → body record, everything else nothing. */
type MemberErrors<M> = M extends HttpErrorBrand
  ? Readonly<Record<M['status'], OutErrorBranch<M>>>
  : Record<never, never>;

/** Flattens a union of records into one record — same-key values union. */
type FlattenRecords<R> = {
  readonly [K in R extends unknown ? keyof R : never]: R extends unknown
    ? K extends keyof R
      ? R[K]
      : never
    : never;
};

/**
 * The error branches a handler's RETURNED `httpError` values declare.
 * TypeScript cannot inspect a function body's `throw` sites, so the return
 * type is the only inferable channel: a handler that returns (instead of
 * throws) an `HttpError` brands its statuses and body shapes here, and
 * `handle` treats such a return as sugar for throwing it — the declared
 * branches describe real wire answers.
 */
export type OutErrors<O> = FlattenRecords<MemberErrors<Unpromise<O>>>;

/** Merges two status → body records: same-key values union. */
export type MergeRecords<A, B> = {
  readonly [K in keyof A | keyof B]: K extends keyof A
    ? K extends keyof B
      ? A[K] | B[K]
      : A[K]
    : K extends keyof B
      ? B[K]
      : never;
};

/**
 * A route's full error channel: the `throws` gates' declared branches
 * ({@link ChainErrors}) merged with the handler's returned-`httpError`
 * branches ({@link OutErrors}) — same-status conflicts union their body
 * shapes. Routes whose handler returns no `HttpError` values keep
 * {@link ChainErrors}' shape untouched: the merge only wakes when there
 * is something to merge.
 */
export type RouteErrors<Ms extends readonly unknown[], O> =
  [keyof OutErrors<O>] extends [never]
    ? ChainErrors<Ms>
    : MergeRecords<ChainErrors<Ms>, OutErrors<O>>;

/** Normalizes an inferred status brand: an absent one reads `number`. */
type NormStatus<S> = S extends number ? S : number;

/** One handler return member's status → body pair. A responder branded
 * with both `_out` and `_status` keeps the pair; a status-only brand
 * (`text`/`html`/`redirect`) pairs its status with `unknown`; an unbranded
 * return pairs `number` with `unknown`. Returned `HttpError` values
 * contribute nothing here — they flow through the errors channel
 * ({@link OutErrors}) instead. */
type BranchOf<M> =
  M extends HttpErrorBrand
    ? never
    : M extends { readonly _out?: infer T; readonly _status?: infer S }
      ? { status: NormStatus<S>; out: T }
      : M extends { readonly _status?: infer S }
        ? { status: NormStatus<S>; out: unknown }
        : { status: number; out: unknown };

/**
 * The status → body pairs a handler's return union declares — the client's
 * discriminated response union. Promise-unwrapped and distributed per
 * member (see {@link Unpromise}), so `json(ctx, x)` and
 * `json(ctx, e, { status: 422 })` survive as separate `{status, out}`
 * pairs instead of collapsing into the loose `out`/`status` unions the
 * two-channel extraction produces.
 */
export type BranchesOf<O> = BranchOf<Unpromise<O>>;

/** `R` minus the routes registered for method `M` + pattern `P` — the
 * compile-time twin of `removeRoute`'s runtime filter. */
export type RouteFilter<
  R extends readonly RouteDef[],
  M extends string,
  P extends string
> =
  R extends readonly [infer Head extends RouteDef, ...infer Tail extends RouteDef[]]
    ? Head extends { readonly method: M; readonly pattern: P }
      ? RouteFilter<Tail, M, P>
      : [Head, ...RouteFilter<Tail, M, P>]
    : [];

/** A mount prefix normalized for pattern concatenation: root becomes ''. */
export type MountBase<B extends string> =
  B extends '' | '/' ? '' : B extends `${infer Rest}/` ? MountBase<Rest> : B;

/** The route defs of a mounted sub-app, patterns prefixed under `Base`
 * (the sub-app root `/` collapses onto the bare prefix). `out`, `status`,
 * `in`, `errors`, and `branches` ride along so a mounted app's client keeps
 * its response-body, response-status, request-input, error-branch, and
 * status-pair types. */
export type MountedDefs<
  R extends readonly RouteDef[],
  Base extends string
> =
  R extends readonly [infer Head extends RouteDef, ...infer Tail extends RouteDef[]]
    ? [
        {
          readonly method: Head['method'];
          readonly pattern: Head['pattern'] extends '/'
            ? Base
            : `${Base}${Head['pattern']}`;
        } & (Head extends { readonly out: infer O } ? { readonly out: O } : unknown) &
          (Head extends { readonly status: infer St } ? { readonly status: St } : unknown) &
          (Head extends { readonly in: infer I } ? { readonly in: I } : unknown) &
          (Head extends { readonly errors: infer E } ? { readonly errors: E } : unknown) &
          (Head extends { readonly branches: infer Br } ? { readonly branches: Br } : unknown),
        ...MountedDefs<Tail, Base>
      ]
    : [];

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
