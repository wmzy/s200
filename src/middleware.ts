/**
 * Third-party battery entry point: the published identity wrapper for
 * middleware authors packaging s200 batteries.
 *
 * @module
 */

import type { Ctx, Next } from './types';

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
