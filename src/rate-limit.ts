/**
 * Sliding-window rate limiter as a gate middleware: counts requests per key
 * (client identity) and answers the overflow in place with 429 +
 * `Retry-After` — the rest of the chain never runs.
 *
 * Zero dependencies: a per-key timestamp deque by default, or an injected
 * store (shared counters across instances, e.g. Redis) behind the same
 * contract.
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
  /**
   * Hit accounting. The default is an in-process sliding window; a custom
   * store must make `hit` atomic per key (the Redis INCR + PEXPIRE shape)
   * so limits hold across instances — the in-memory default never can.
   */
  readonly store?: RateLimitStore;
};

/** One accounting result: the live count and the earliest retry time. */
export type RateLimitHit = {
  /** Hits inside the current window, this one included. */
  readonly count: number;
  /**
   * Earliest time (ms epoch, the `now` clock's frame) a retry is expected
   * to pass: with `count = limit + 1`, the oldest hit must expire first.
   */
  readonly retryAt: number;
};

/** Per-key hit accounting — see {@link RateLimitOptions.store}. */
export type RateLimitStore = {
  hit(
    key: string,
    now: number,
    limit: number,
    windowMs: number
  ): RateLimitHit | Promise<RateLimitHit>;
};

// Sweep bound: the key map only grows when distinct keys arrive, so an
// unbounded map is a slow memory leak. At this many live keys, expired
// entries are swept opportunistically on the next over-limit request.
const MAX_BUCKETS = 10_000;

/**
 * In-process sliding window: one timestamp deque per key. A hit expires
 * exactly `windowMs` after it landed (no fixed boundary), so the limit is
 * never burstable at window edges the way a fixed-window counter is.
 */
function memoryStore(): RateLimitStore {
  const buckets = new Map<string, number[]>();
  let hits = 0;
  return {
    hit(key, now, limit, windowMs) {
      let timestamps = buckets.get(key);
      if (timestamps === undefined) {
        timestamps = [];
        buckets.set(key, timestamps);
      }
      const cutoff = now - windowMs;
      let drop = 0;
      while (
        drop < timestamps.length &&
        (timestamps[drop] ?? 0) <= cutoff
      ) {
        drop += 1;
      }
      if (drop > 0) {
        timestamps.splice(0, drop);
      }
      timestamps.push(now);
      const count = timestamps.length;
      // Sweep on over-limit AND on a hit counter: an under-limit-only
      // workload would otherwise never trigger cleanup once the map
      // passed MAX_BUCKETS, leaking one deque per distinct key forever.
      hits += 1;
      if (buckets.size > MAX_BUCKETS && (count > limit || hits % 256 === 0)) {
        for (const [candidate, entries] of buckets) {
          while (entries.length > 0 && (entries[0] ?? 0) <= cutoff) {
            entries.shift();
          }
          if (entries.length === 0) {
            buckets.delete(candidate);
          }
        }
      }
      if (count <= limit) {
        return { count, retryAt: now };
      }
      // A retry passes once the (count - limit)'th-oldest hit expires.
      const oldestBlocking = timestamps[count - limit - 1] ?? now;
      return { count, retryAt: oldestBlocking + windowMs };
    },
  };
}

function defaultKey(ctx: Ctx): string {
  const forwarded = ctx.req.headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first === undefined || first === '' ? 'unknown' : first;
}

/**
 * Rate-limit gate. Requests over `limit` inside a sliding `windowMs` window
 * are answered in place with 429 `{"error":"Too Many Requests"}` +
 * `Retry-After` (seconds until the oldest blocking hit expires), and
 * `next()` is never called.
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
  const store = options.store ?? memoryStore();
  if (windowMs <= 0) {
    throw new Error(
      `Invalid rate-limit windowMs ${String(windowMs)}: must be positive`
    );
  }
  if (limit <= 0) {
    throw new Error(
      `Invalid rate-limit limit ${String(limit)}: must be positive`
    );
  }

  return async (ctx: Ctx, next) => {
    const id = key !== undefined ? key(ctx) : defaultKey(ctx);
    const t = now();
    const { count, retryAt } = await store.hit(id, t, limit, windowMs);
    if (count > limit) {
      const retryAfter = Math.max(1, Math.ceil((retryAt - t) / 1000));
      ctx.res = Response.json(
        { error: 'Too Many Requests' },
        { status: 429, headers: { 'retry-after': String(retryAfter) } }
      );
      return; // gate: nothing below runs, the 429 stands
    }
    return next();
  };
}
