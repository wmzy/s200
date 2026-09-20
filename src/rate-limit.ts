/**
 * Sliding-window rate limiter as a gate middleware: counts requests per key
 * (client identity) and answers the overflow in place with 429 +
 * `Retry-After` — the rest of the chain never runs.
 *
 * Zero dependencies: one Map of buckets, an injectable clock for tests.
 *
 * @module
 */

import type { Ctx, Middleware } from './types';

export type RateLimitOptions = {
  /** Window length in milliseconds; default 60_000. */
  readonly windowMs?: number;
  /** Requests allowed per window per key; default 60. */
  readonly limit?: number;
  /** Identity selector; default: first `x-forwarded-for` hop. */
  readonly key?: (ctx: Ctx) => string;
  /** Clock override (tests, deterministic replays); default `Date.now`. */
  readonly now?: () => number;
};

type Bucket = { count: number; reset: number };

// Sweep bound: the bucket map only grows when distinct keys arrive, so an
// unbounded map is a slow memory leak. At this many live buckets, expired
// ones are swept opportunistically on the next miss-free call.
const MAX_BUCKETS = 10_000;

function defaultKey(ctx: Ctx): string {
  const forwarded = ctx.req.headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first === undefined || first === '' ? 'unknown' : first;
}

/**
 * Rate-limit gate. The counter runs per window: request `limit + 1` inside
 * one window is answered 429 `{"error":"Too Many Requests"}` with
 * `Retry-After` set to the remaining window seconds, and `next()` is never
 * called. A fresh window resets the count.
 *
 * The default key trusts `x-forwarded-for` — only meaningful behind a proxy
 * that overwrites it. Any deployment reachable directly MUST pass `key`
 * (e.g. derived from a reverse proxy's client-address header).
 */
export function rateLimit(options: RateLimitOptions = {}): Middleware {
  const windowMs = options.windowMs ?? 60_000;
  const limit = options.limit ?? 60;
  const key = options.key;
  const now = options.now ?? Date.now;
  if (windowMs <= 0) {
    throw new Error(`Invalid rate-limit windowMs ${String(windowMs)}: must be positive`);
  }
  if (limit <= 0) {
    throw new Error(`Invalid rate-limit limit ${String(limit)}: must be positive`);
  }
  const buckets = new Map<string, Bucket>();

  return (ctx: Ctx, next) => {
    const id = key !== undefined ? key(ctx) : defaultKey(ctx);
    const t = now();
    let bucket = buckets.get(id);
    if (bucket !== undefined && t >= bucket.reset) {
      buckets.delete(id);
      bucket = undefined;
    }
    if (bucket === undefined) {
      bucket = { count: 0, reset: t + windowMs };
      buckets.set(id, bucket);
    }
    bucket.count += 1;
    if (bucket.count > limit) {
      if (buckets.size > MAX_BUCKETS) {
        for (const [candidate, entry] of buckets) {
          if (t >= entry.reset) buckets.delete(candidate);
        }
      }
      const retryAfter = Math.max(1, Math.ceil((bucket.reset - t) / 1000));
      ctx.res = Response.json(
        { error: 'Too Many Requests' },
        { status: 429, headers: { 'retry-after': String(retryAfter) } }
      );
      return; // gate: nothing below runs, the 429 stands
    }
    return next();
  };
}
