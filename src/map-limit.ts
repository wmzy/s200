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
