/**
 * Redis store recipes for the rate-limit and session batteries.
 *
 * s200 is zero-dependency by contract, so these are recipes, not a
 * dependency: this file is repository-level TypeScript, deliberately
 * outside the package exports — vendor it into your project and bring
 * your own Redis client. Both factories take a {@link RedisLike} (the
 * four commands they need, structurally typed) and return exactly the
 * store interface the matching battery injects, so a fleet of instances
 * in front of one Redis counts and remembers as a single app.
 *
 * Full deployment guide: `docs/guides/distributed-stores.md`.
 *
 * @module
 */

import type { RateLimitStore } from '../src/rate-limit';
import type { SessionData, SessionStore } from '../src/session';

/**
 * The minimal Redis surface the recipes touch — four commands, satisfied
 * structurally. An **ioredis** client matches as-is. A **node-redis**
 * (v4+) client needs the four-line adapter from the distributed-stores
 * guide: its `eval` takes an options object instead of the positional
 * form, and its SETEX is spelled `setEx`. Methods may return values or
 * promises — the recipes await either.
 */
export type RedisLike = {
  /**
   * EVAL in the positional form: script, number of keys, then keys and
   * arguments interleaved. A multi-bulk reply comes back as an array.
   */
  eval(
    script: string,
    numKeys: number,
    ...keysAndArgs: (string | number)[]
  ): unknown[] | Promise<unknown[]>;
  /** GET — `null` for a missing or expired key. */
  get(key: string): string | null | Promise<string | null>;
  /** SETEX — write a string with a seconds TTL, overwriting wholesale. */
  setex(key: string, seconds: number, value: string): unknown | Promise<unknown>;
  /** DEL — remove a key; the reply is ignored. */
  del(key: string): unknown | Promise<unknown>;
};

/**
 * One EVAL, one atomic unit: INCR the counter, read its remaining TTL,
 * and arm PEXPIRE only when the key has none — the first hit, or a
 * stray TTL-less key some other writer left behind (healed instead of
 * counting forever). Redis executes a script serially, so two instances
 * hitting the same key can never both observe `count == 1`: the
 * increment and its expiry land together or not at all.
 */
const RATE_LIMIT_SCRIPT = [
  'local count = redis.call("INCR", KEYS[1])',
  'local ttl = redis.call("PTTL", KEYS[1])',
  'if ttl < 0 then',
  '  redis.call("PEXPIRE", KEYS[1], ARGV[1])',
  '  ttl = tonumber(ARGV[1])',
  'end',
  'return { count, ttl }',
].join('\n');

/**
 * `RateLimitStore` over shared Redis: one counter per key, its window
 * anchored at the key's first hit and expiring `windowMs` later — the
 * `INCR` + first-`PEXPIRE` shape the battery's store contract names.
 * Every instance of every app process using the same Redis sees the
 * same counter, so the limit holds across the fleet.
 *
 * The window is fixed-from-first-hit, not the true sliding window of
 * the in-process default: hits do not expire individually, the whole
 * counter does. Blocked retries are told to wait out the remainder of
 * the window (what `PTTL` reported), which `rateLimit` renders as
 * `Retry-After`.
 *
 * Prefix the keys when several apps share one Redis — the default
 * `s200:rl:` assumes a dedicated keyspace.
 */
export function createRedisRateLimitStore(
  redis: RedisLike,
  prefix = 's200:rl:'
): RateLimitStore {
  return {
    async hit(key, now, _limit, windowMs) {
      const reply = await redis.eval(RATE_LIMIT_SCRIPT, 1, prefix + key, windowMs);
      const count = Number(reply[0]);
      const ttl = Number(reply[1]);
      if (!Number.isFinite(count) || !Number.isFinite(ttl)) {
        throw new Error(
          `Unexpected EVAL reply for rate-limit key ${prefix}${key}: wanted [count, ttl]`
        );
      }
      // The whole window expires at once — a blocked retry waits out
      // exactly the remainder PTTL reported.
      return { count, retryAt: now + Math.max(ttl, 0) };
    },
  };
}

/**
 * `SessionStore` over shared Redis: one JSON record per session id,
 * born with the TTL the cookie advertises (`set` receives it), so the
 * data dies with its cookie instead of leaking ids past their
 * lifetime. `touch()` renews by writing the record again with a fresh
 * TTL — the middleware settles that on the unwind.
 *
 * A record Redis returns but JSON cannot parse counts as no session:
 * the middleware mints a fresh one rather than failing the request.
 *
 * Prefix the keys when several apps share one Redis — the default
 * `s200:sess:` assumes a dedicated keyspace.
 */
export function createRedisSessionStore(
  redis: RedisLike,
  prefix = 's200:sess:'
): SessionStore {
  return {
    async get(id) {
      const raw = await redis.get(prefix + id);
      if (raw === null) return undefined;
      try {
        return JSON.parse(raw) as SessionData;
      } catch {
        return undefined;
      }
    },
    async set(id, data, ttlSeconds) {
      // SETEX demands a whole, positive second — round, never zero.
      const seconds = Math.max(1, Math.round(ttlSeconds));
      await redis.setex(prefix + id, seconds, JSON.stringify(data));
    },
    async delete(id) {
      await redis.del(prefix + id);
    },
  };
}
