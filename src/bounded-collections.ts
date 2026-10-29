/**
 * Shared bound for the bounded-Map caches (cookies' HMAC keys, jwt's
 * imported keys and JWKS documents, the shared HMAC-key import cache,
 * cache's memory store) — the eviction helper, the LRU Map helpers, and
 * the LRU store factory, instead of a hand-rolled `keys().next()` block
 * per module. Internal module: not part of any package export entry.
 *
 * @internal
 */

/** Evicts the oldest entry (first in iteration order) from a non-empty
 * Map, no-ops on an empty one. Callers own the bound policy — evict
 * before insert for FIFO, after insert for LRU (a plain Map's insertion
 * order is recency order once reads re-insert). */
export function evictOldest<K, V>(map: Map<K, V>): void {
  const oldest = map.keys().next();
  if (!oldest.done) {
    map.delete(oldest.value);
  }
}

/** LRU read over a plain Map: re-insertion bumps recency (insertion
 * order is recency order), zero dependencies. */
export function lruGet<K, V>(cache: Map<K, V>, key: K): V | undefined {
  const value = cache.get(key);
  if (value !== undefined) {
    cache.delete(key);
    cache.set(key, value);
  }
  return value;
}

/** LRU write over a plain Map: one past the bound, the oldest entry goes. */
export function lruSet<K, V>(cache: Map<K, V>, key: K, value: V, limit: number): void {
  cache.set(key, value);
  if (cache.size > limit) {
    evictOldest(cache);
  }
}

/** One bounded LRU store over a private Map — the `get`/`set` shape
 * every battery's cache contract (`JwtKeyStore`, `JwksStore`,
 * `HmacKeyCache`) already speaks, so a module-level default cache is
 * one call instead of a hand-assembled `{ get, set }` pair over a
 * bare Map. */
export function lruStore<K, V>(limit: number): {
  get(key: K): V | undefined;
  set(key: K, value: V): void;
} {
  const map = new Map<K, V>();
  return {
    get: (key) => lruGet(map, key),
    set: (key, value) => lruSet(map, key, value, limit),
  };
}

/** Trims a sliding-window timestamp deque to entries newer than
 * `windowMs` (an entry expires exactly `windowMs` after it landed), then
 * pushes `now` — the shared clip between rate-limit's per-key buckets and
 * circuit-breaker's failure window. Mutates `timestamps` in place.
 *
 * @internal */
export function pushSlidingTimestamps(
  timestamps: number[],
  now: number,
  windowMs: number
): void {
  const cutoff = now - windowMs;
  let drop = 0;
  while (drop < timestamps.length && (timestamps[drop] ?? 0) <= cutoff) {
    drop += 1;
  }
  if (drop > 0) {
    timestamps.splice(0, drop);
  }
  timestamps.push(now);
}
