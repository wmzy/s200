/**
 * Third-party battery entry point: the published identity wrapper for
 * middleware authors packaging s200 batteries.
 *
 * @module
 */

import type { Ctx, Middleware, Next, State, StateMiddleware } from './types';

/**
 * Publishes a middleware as a reusable s200 battery — the labeled front
 * door for third-party middleware authors, mirroring how the built-in
 * batteries are packaged.
 *
 * The contract a battery signs up for: a function of `(ctx, next)` in the
 * onion model. It runs before `await next()` for request-side work and
 * after it for response-side work (once `next()` resolves, `ctx.res` is
 * guaranteed to exist — the 404/405/500 fallbacks are materialized inside
 * the chain). A middleware may write `ctx.res` itself, and short-circuits
 * the rest of the chain by simply not calling `next()`; calling `next()`
 * a second time rejects. Gate middlewares may brand their return type with
 * a phantom `_in` (see `s200/validate`'s `jsonBody` and `s200/query`'s
 * `queryParams`) so route registrars can type the app client's request
 * inputs — {@link defineMiddleware} preserves that full type.
 *
 * Zero runtime cost: this is the identity function. It exists for
 * discoverability (one importable symbol to author against) and as the
 * attachment point for future battery tooling (docs generation, contract
 * checks) without breaking call sites.
 */
export function defineMiddleware<M extends (ctx: Ctx, next: Next) => Promise<void> | void>(
  mw: M
): M {
  return mw;
}

/**
 * Brands a middleware as a state injector: `X` names the keys it writes
 * onto `ctx.state` before `next()`, so `use(app, withState<X>(mw))`
 * widens the app's `S` — every downstream middleware and handler reads
 * the injected keys typed, with no hand-written app state interface and
 * no global `declare module` merge:
 *
 * ```ts
 * const withUser = withState<{ user: User }>(async (ctx, next) => {
 *   ctx.state.user = await loadUser(ctx); // X keys are writable here
 *   await next();
 * });
 * const app2 = use(app, withUser);
 * get(app2, '/me', (ctx) => json(ctx, ctx.state.user)); // User, typed
 * ```
 *
 * The second type parameter (default: the global `State`) is what the
 * middleware may READ — pass it explicitly when the injector consumes
 * earlier injections; its own `X` keys are also visible inside its body
 * (the injector owns initializing them):
 *
 * ```ts
 * const withProfile = withState<{ profile: Profile }, { user: User }>(…);
 * use(use(app, withUser), withProfile); // ok — { user } is already there
 * use(app, withProfile);                // type error — { user } missing
 * ```
 *
 * Purely compile-time: the identity function, zero runtime cost — the
 * brand rides the type exactly like `throws`' `_errors` and the gates'
 * `_in`, and plain (unbranded) middlewares keep their old behavior
 * unchanged. The brand is collected by `use` — both the global and the
 * prefix-scoped form; in a route's middleware chain a branded middleware
 * still runs, but its brand is not threaded into the handler's
 * `ctx.state` (scope the injection with `use` instead).
 */
export function withState<X extends State, S extends State = State>(
  middleware: Middleware<S & X>
): StateMiddleware<X, S> {
  return middleware as StateMiddleware<X, S>;
}
