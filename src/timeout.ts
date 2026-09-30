/**
 * Timeout middleware: races the rest of the chain against a deadline. When
 * the deadline wins, the chain below rejects with a 503 `HttpError` — the
 * app's error path renders it, and the unwind middlewares (logger, cors)
 * observe the real status.
 *
 * The deadline also aborts a per-request `AbortController` composed into
 * `ctx.signal` for everything below, so cooperative work — body reads
 * (`readJson` & co cancel their stream and reject with an `AbortError`),
 * fetches racing `ctx.signal` — stops instead of buffering a corpse. Work
 * that never observes `ctx.signal` keeps running detached (like hono's
 * timeout); this only bounds the response time and signals the loss.
 *
 * @module
 */

import type { Ctx, Middleware, Next } from './types';

import { httpError } from './errors';

// `AbortSignal.any` composes the previous signal with the deadline's;
// runtimes without it keep the old detached-loss semantics instead of
// breaking the swap contract.
export function timeout(ms: number): Middleware {
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`Invalid timeout ${String(ms)}ms: must be positive`);
  }
  return (ctx: Ctx, next: Next): Promise<void> => {
    const controller = new AbortController();
    const prev = ctx.signal;
    const composed =
      typeof AbortSignal.any === 'function'
        ? AbortSignal.any([prev, controller.signal])
        : undefined;
    if (composed !== undefined) {
      ctx.signal = composed;
    }
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Abort before rejecting: the losing chain's in-flight body reads
        // reject with AbortError and cancel their source promptly, while
        // the 503 below wins the race out of the onion.
        controller.abort();
        reject(httpError(503, 'Request timeout'));
      }, ms);
    });
    // The losing member must not reject unhandled: a chain that fails after
    // the deadline already won would otherwise surface as an
    // unhandledRejection (fatal under --unhandled-rejections=throw). The
    // chain's own error boundary turns the late failure into a response
    // inside the (already lost) branch — the returned 503 was handed to the
    // caller before that detached materialization can touch `ctx.res`.
    const chain = next();
    chain.catch(() => undefined);
    return Promise.race([chain, deadline]).finally(() => {
      clearTimeout(timer);
      // Onion discipline: outer middlewares unwind against the signal they
      // saw on the way in.
      if (composed !== undefined) {
        ctx.signal = prev;
      }
    });
  };
}
