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

/** Throws when `value` is not a safe integer ≥ 0 — same house format as
 * {@link assertPositive} for the bounds where zero is legitimate (an
 * empty window is a valid choice, a negative or fractional one is not):
 * `` Invalid ${module} ${name} ${String(value)}: must be a non-negative
 * integer ``. */
export function assertNonNegativeInteger(
  module: string,
  name: string,
  value: number
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `Invalid ${module} ${name} ${String(value)}: must be a non-negative integer`
    );
  }
}

/** Throws when `value` is not a safe integer ≥ 1 — same house format as
 * {@link assertPositive} for the bounds where zero is a configuration
 * mistake (a whole-unit floor of at least one): `` Invalid ${module}
 * ${name} ${String(value)}: must be a positive integer ``. */
export function assertPositiveInteger(
  module: string,
  name: string,
  value: number
): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      `Invalid ${module} ${name} ${String(value)}: must be a positive integer`
    );
  }
}
