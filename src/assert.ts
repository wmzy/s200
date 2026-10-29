/**
 * Shared creation-time argument guards — one message format instead of a
 * hand-rolled `throw new Error(...)` block per battery (crypto-util.ts /
 * bounded-collections.ts precedent for internal modules): imported via relative
 * paths, never re-exported from the barrel.
 *
 * @module
 */

/** Throws when `value` is not a finite positive number — a bad bound is
 * a programmer error, not a runtime failure to report. The message is
 * the house format: `` Invalid ${module} ${name} ${String(value)}: must
 * be positive ``. */
export function assertPositive(
  module: string,
  name: string,
  value: number
): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `Invalid ${module} ${name} ${String(value)}: must be positive`
    );
  }
}
