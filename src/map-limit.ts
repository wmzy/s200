/**
 * Shared bound for the bounded-Map caches (cookies' HMAC keys, jwt's
 * imported keys and JWKS documents, cache's memory store) — one
 * eviction helper instead of a hand-rolled `keys().next()` block per
 * module. Internal module: not part of any package export entry.
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
