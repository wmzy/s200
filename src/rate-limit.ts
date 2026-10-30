/**
 * Sliding-window rate limiter as a gate middleware: counts requests per key
 * (client identity) and answers the overflow by throwing a 429 `HttpError`
 * into the app's error boundary — the default mapping ships
 * `{"error":"Too Many Requests"}` with `Retry-After` and the IETF
 * `RateLimit-Limit`/`RateLimit-Remaining`/`RateLimit-Reset` headers
 * (draft-ietf-httpapi-ratelimit-headers; reset in seconds, same remainder
 * as `Retry-After`), and a configured `onError` takes over. The rest of
 * the chain never runs.
 *
 * Zero dependencies: a per-key timestamp deque by default, or an injected
 * store (shared counters across instances, e.g. Redis) behind the same
 * contract.
 *
 * @module
 */

import type { Ctx, Middleware } from './types';

import { assertPositive } from './assert';
import { httpError, retryAfterSeconds } from './errors';
import { dropExpired, pushSlidingTimestamps } from './bounded-collections';
import { splitList } from './raw-headers';

export type RateLimitOptions = {
  /** Window length in milliseconds; default 60_000. */
  readonly windowMs?: number;
  /** Requests allowed per window per key; default 60. */
  readonly limit?: number;
  /** Identity selector; default: first `x-forwarded-for` hop. */
  readonly key?: (ctx: Ctx) => string;
  /**
   * Skip predicate: `true` and this request is neither counted nor
   * blocked — the key is never computed, the store is never touched, and
   * the chain runs immediately (an exempt-identity escape hatch, e.g.
   * health checks or an internal CIDR).
   */
  readonly skip?: (ctx: Ctx) => boolean;
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
      pushSlidingTimestamps(timestamps, now, windowMs);
      const count = timestamps.length;
      // Sweep on over-limit AND on a hit counter: an under-limit-only
      // workload would otherwise never trigger cleanup once the map
      // passed MAX_BUCKETS, leaking one deque per distinct key forever.
      hits += 1;
      if (buckets.size > MAX_BUCKETS && (count > limit || hits % 256 === 0)) {
        // Not pushSlidingTimestamps: this is a many-bucket janitor pass —
        // it only drops expired entries (the shared clip, one splice per
        // bucket instead of per-entry shifts) and must not land a hit in
        // buckets whose keys were never touched.
        const cutoff = now - windowMs;
        for (const [candidate, entries] of buckets) {
          dropExpired(entries, cutoff);
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
  // splitList (raw-headers) trims and drops empty segments — the same
  // parse trust-proxy applies to this header — so 'unknown' only remains
  // for a request with no usable forwarding entry at all.
  return splitList(ctx.req.headers.get('x-forwarded-for') ?? '')[0] ?? 'unknown';
}

/**
 * Rate-limit gate. Requests over `limit` inside a sliding `windowMs` window
 * throw a 429 `HttpError` (`{"error":"Too Many Requests"}` + `Retry-After`,
 * seconds until the oldest blocking hit expires, + IETF `RateLimit-*`
 * headers) into the error boundary, and `next()` is never called.
 *
 * The default key trusts `x-forwarded-for` — only meaningful behind a proxy
 * that overwrites it. Any deployment reachable directly MUST pass `key`
 * (e.g. derived from a reverse proxy's client-address header).
 */
export function rateLimit(options: RateLimitOptions = {}): Middleware {
  const windowMs = options.windowMs ?? 60_000;
  const limit = options.limit ?? 60;
  const key = options.key;
  const skip = options.skip;
  const now = options.now ?? Date.now;
  const store = options.store ?? memoryStore();
  assertPositive('rate-limit', 'windowMs', windowMs);
  assertPositive('rate-limit', 'limit', limit);

  return async (ctx: Ctx, next) => {
    // Exempt requests bypass the whole gate — key, store hit, 429 — so
    // they neither count against the window nor can ever be blocked.
    if (skip !== undefined && skip(ctx)) {
      return next();
    }
    const id = key !== undefined ? key(ctx) : defaultKey(ctx);
    const t = now();
    const { count, retryAt } = await store.hit(id, t, limit, windowMs);
    if (count > limit) {
      const retryAfter = retryAfterSeconds(retryAt - t);
      // Into the error boundary (onError can take over): the default
      // mapping keeps the 429 envelope, now with the IETF RateLimit-*
      // fields alongside Retry-After (reset = the same remainder).
      throw httpError(
        429,
        'Too Many Requests',
        { error: 'Too Many Requests' },
        {
          'retry-after': String(retryAfter),
          'ratelimit-limit': String(limit),
          'ratelimit-remaining': '0',
          'ratelimit-reset': String(retryAfter),
        }
      );
    }
    return next();
  };
}
