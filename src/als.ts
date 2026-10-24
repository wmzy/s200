/**
 * Async-context battery: opt-in ambient access to the request `Ctx`.
 *
 * s200's paradigm is explicit ctx passing — middlewares and handlers take
 * `ctx` as a parameter. This battery is the opt-in supplement, not a
 * replacement: one middleware makes the ctx reachable from anywhere inside
 * the request's async extent via `currentCtx()`, for call stacks that
 * cannot thread it (logging sinks, metrics helpers, deep legacy code).
 *
 * Runtime boundary: `node:async_hooks` exists on Node and Bun. Cloudflare
 * Workers has no async_hooks — importing this entry
 * fails there, so keep it out of edge bundles.
 *
 * @module
 */

import type { Ctx, Middleware, Next } from './types';

import { AsyncLocalStorage } from 'node:async_hooks';

// Module-level singleton: one storage for the whole process — the simplest
// shape, and tree-shakable (importing currentCtx alone pulls exactly this
// module and nothing else).
const storage = new AsyncLocalStorage<Ctx>();

/**
 * Ambient-ctx middleware: wraps the rest of the chain in the platform's
 * `AsyncLocalStorage`, so {@link currentCtx} resolves this request's ctx
 * from any await point, timer callback, or nested helper below it. Outside
 * the wrapped extent — before the middleware, after the chain settles, on
 * code paths that never saw a request — there is no ambient ctx.
 */
export function als(): Middleware {
  return (ctx: Ctx, next: Next): Promise<void> => storage.run(ctx, () => next());
}

/**
 * The ambient request `Ctx`, or `undefined` when the executing code is not
 * inside a chain wrapped by {@link als} — including entirely outside
 * request handling, and code reached without the middleware registered.
 */
export function currentCtx(): Ctx | undefined {
  return storage.getStore();
}
