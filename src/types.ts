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

/** Continuation into the next middleware — the onion's inner layer. */
export type Next = () => Promise<void>;

/** Onion middleware: runs before and/or after `await next()`. */
export type Middleware = (ctx: Ctx, next: Next) => Promise<void> | void;

/**
 * Route terminal handler. May return a `Response` — `handle` adopts it as
 * `ctx.res` when nothing was written yet.
 */
export type Handler<P extends Params = Params> = (
  ctx: Ctx<P>
) => unknown | Promise<unknown>;

/**
 * Per-request context. The unit of mutation: middlewares and handlers write
 * `state` and `res` in place; `req` stays pinned to the incoming request.
 */
export type Ctx<P extends Params = Params> = {
  readonly req: Request;
  params: P;
  query: URLSearchParams;
  state: Record<string, unknown>;
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
  readonly handler: Handler<P>;
};

/** What a successful match yields: the route plus its captured params. */
export type MatchResult = { readonly route: Route; readonly params: Params };

/** Pluggable matcher — swap in a radix tree etc. without touching `App`. */
export type MatchFn = (
  routes: readonly Route[],
  method: string,
  pathname: string
) => MatchResult | undefined;

/** Maps a thrown value to a response; may write `ctx.res` itself. */
export type ErrorHandler = (ctx: Ctx, error: unknown) => Promise<void> | void;

/** Last chance to answer an unmatched request; default is a 404. */
export type NotFoundHandler = (ctx: Ctx) => Promise<void> | void;

/** Extension hook over the mutable `App` data structure. */
export type Plugin = (app: App) => void;
