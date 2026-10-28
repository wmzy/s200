/**
 * Circuit breaker as plain data + functions: after enough admitted
 * failures inside a sliding window the breaker trips `open`, rejects
 * calls for a cooldown, then admits a bounded number of probes
 * (`half-open`) — one straggler failure re-trips, a streak of successes
 * closes the circuit again. Made to wrap the upstream calls a reverse
 * proxy makes (`s200/proxy`), but it guards any async operation.
 *
 * The state is one mutable data object created by
 * {@link createCircuitBreaker}; every function operates on it. There is
 * no locking: JavaScript is single-threaded per event loop, and every
 * transition happens synchronously inside a `canPass`/`record*` call —
 * concurrent callers only interleave at `await` points they own (the
 * wrapped `fn`), by which point admission has already been decided.
 *
 * Two calling faces, same accounting:
 *
 * - {@link breakerCall} wraps any async call: it admits through
 *   {@link canPass} (a rejection throws a 503 `HttpError` with
 *   `Retry-After`, so inside an app the error boundary answers — the
 *   same shape `s200/rate-limit` ships), records the outcome, and always
 *   rethrows the underlying error untouched.
 * - {@link canPass} + {@link recordSuccess}/{@link recordFailure} for
 *   callers that want the policy without the 503 (their own fallback
 *   response, their own logging). A `true` from `canPass` in `half-open`
 *   reserves one of the probe slots — settle every admitted call exactly
 *   once with a `record*`, or the slot leaks.
 *
 * @module
 */

import { assertPositive } from './assert';
import { httpError, isHttpError } from './errors';
import { pushSlidingTimestamps } from './map-limit';

/** Phase of the state machine: `closed` → `open` → `half-open` → … */
export type CircuitPhase = 'closed' | 'open' | 'half-open';

/**
 * Decides whether a thrown value counts as a failure. `true` counts (it
 * moves the breaker toward `open`); `false` passes through — the call
 * was still admitted and still settles its probe slot, it just does not
 * accrue. See {@link skipClientErrors} for the ready-made 4xx variant.
 */
export type CircuitErrorFilter = (error: unknown) => boolean;

/** Options for {@link createCircuitBreaker} — every field optional. */
export type CircuitBreakerOptions = {
  /**
   * Admitted failures inside `windowMs` that trip the breaker `open`;
   * default 5.
   */
  readonly failureThreshold?: number;
  /** Failure-counting window in milliseconds; default 10_000. */
  readonly windowMs?: number;
  /** How long `open` rejects before probes are admitted; default 30_000. */
  readonly cooldownMs?: number;
  /** Consecutive probe successes that close a `half-open` breaker; default 2. */
  readonly successesNeeded?: number;
  /**
   * Probe calls admitted concurrently while `half-open`; default 1. With
   * more than 1, a straggler probe that settles after a sibling already
   * re-tripped the breaker counts against whatever phase is live when it
   * settles — settle probes promptly (pair with the timeout battery) or
   * keep 1 for exact accounting.
   */
  readonly probeConcurrency?: number;
  /**
   * Failure filter; default: every thrown value counts. Pass
   * {@link skipClientErrors} to let client-caused 4xx answers pass
   * through without accruing.
   */
  readonly errorFilter?: CircuitErrorFilter;
  /** Clock override (tests, deterministic replays); default `Date.now`. */
  readonly now?: () => number;
};

/**
 * Options with defaults applied — the frozen `options` field of a
 * {@link CircuitBreaker}. Validate once at creation, never again.
 */
export type CircuitBreakerConfig = {
  readonly failureThreshold: number;
  readonly windowMs: number;
  readonly cooldownMs: number;
  readonly successesNeeded: number;
  readonly probeConcurrency: number;
  readonly errorFilter: CircuitErrorFilter;
  readonly now: () => number;
};

/**
 * The breaker's state: one mutable data object every function operates
 * on. Fields are the live machine, not a stable API surface — read them
 * through {@link circuitStatus} (dashboards, logs) and mutate them only
 * through the exported functions. All timestamps live in the injected
 * clock's frame (epoch ms by default).
 */
export type CircuitBreaker = {
  /** Resolved, immutable options. */
  readonly options: CircuitBreakerConfig;
  /**
   * Current phase. `open` → `half-open` happens lazily: the first
   * `canPass`/`record*`/`circuitStatus` after the cooldown elapsed is
   * the one that moves it.
   */
  phase: CircuitPhase;
  /** Admitted-failure timestamps inside the sliding window (the `closed` era). */
  failures: number[];
  /** Consecutive probe successes in the current `half-open` era. */
  successes: number;
  /** Probe slots reserved in `half-open`, not yet settled by a `record*`. */
  probesInFlight: number;
  /** Epoch ms of the latest trip to `open` (0 before the first one). */
  openedAt: number;
};

/** Frozen snapshot for dashboards and logs — {@link circuitStatus}. */
export type CircuitBreakerStatus = {
  /** Phase a `canPass` would see right now (lazy transition applied). */
  readonly phase: CircuitPhase;
  /** Admitted failures inside the live window (0 unless `closed`). */
  readonly failures: number;
  /** Consecutive probe successes in the current `half-open` era. */
  readonly successes: number;
  /** Probe slots reserved and not yet settled (0 unless `half-open`). */
  readonly probesInFlight: number;
  /** Epoch ms of the latest trip to `open` (0 before the first one). */
  readonly openedAt: number;
  /** Earliest epoch ms a call is admitted again; 0 unless `open`. */
  readonly retryAtMs: number;
};

/** The default filter: every thrown value counts as a failure. */
function countsEverything(): boolean {
  return true;
}

/**
 * Ready-made {@link CircuitBreakerOptions.errorFilter}: an `HttpError`
 * the client caused (status < 500) does not count — the upstream
 * answered that request, it did not fail — while 5xx answers, network
 * errors, and plain exceptions do. The canonical pairing with
 * `s200/proxy`: a proxied 404 is the caller's truth, not the upstream
 * dying.
 */
export function skipClientErrors(error: unknown): boolean {
  return !(isHttpError(error) && error.status < 500);
}

/** Applies the lazy `open` → `half-open` transition once the cooldown elapsed. */
function settlePhase(breaker: CircuitBreaker): void {
  if (
    breaker.phase === 'open' &&
    breaker.options.now() - breaker.openedAt >= breaker.options.cooldownMs
  ) {
    breaker.phase = 'half-open';
    breaker.successes = 0;
    breaker.probesInFlight = 0;
  }
}

/** Trips `open`: restarts the cooldown and clears every per-era counter. */
function trip(breaker: CircuitBreaker): void {
  breaker.phase = 'open';
  breaker.openedAt = breaker.options.now();
  breaker.failures = [];
  breaker.successes = 0;
  breaker.probesInFlight = 0;
}

/** Releases one `half-open` probe slot (a settled call's admission). */
function releaseProbe(breaker: CircuitBreaker): void {
  if (breaker.phase === 'half-open' && breaker.probesInFlight > 0) {
    breaker.probesInFlight -= 1;
  }
}

/**
 * Builds a breaker in `closed` phase. Options are validated here —
 * non-positive numbers throw a plain `Error` — and frozen onto the
 * state's `options`; nothing validates twice.
 */
export function createCircuitBreaker(
  options: CircuitBreakerOptions = {}
): CircuitBreaker {
  const config: CircuitBreakerConfig = {
    failureThreshold: options.failureThreshold ?? 5,
    windowMs: options.windowMs ?? 10_000,
    cooldownMs: options.cooldownMs ?? 30_000,
    successesNeeded: options.successesNeeded ?? 2,
    probeConcurrency: options.probeConcurrency ?? 1,
    errorFilter: options.errorFilter ?? countsEverything,
    now: options.now ?? Date.now,
  };
  for (const [name, value] of [
    ['failureThreshold', config.failureThreshold],
    ['windowMs', config.windowMs],
    ['cooldownMs', config.cooldownMs],
    ['successesNeeded', config.successesNeeded],
    ['probeConcurrency', config.probeConcurrency],
  ] as const) {
    assertPositive('circuit-breaker', name, value);
  }
  return {
    options: config,
    phase: 'closed',
    failures: [],
    successes: 0,
    probesInFlight: 0,
    openedAt: 0,
  };
}

/**
 * Sync admission probe. `true` means a call may run now: in `closed`
 * every call is admitted; in `half-open` a `true` reserves one of the
 * `probeConcurrency` slots — settle that call exactly once with
 * {@link recordSuccess} or {@link recordFailure}, or the slot leaks
 * until the next trip. `false` means rejected: the breaker is `open`
 * with cooldown left, or `half-open` with every probe slot taken.
 *
 * This is the no-throw face: `false` here is yours to answer (fallback
 * response, queue, drop). {@link breakerCall} turns the same verdict
 * into a 503 `HttpError`.
 */
export function canPass(breaker: CircuitBreaker): boolean {
  settlePhase(breaker);
  if (breaker.phase === 'open') {
    return false;
  }
  if (breaker.phase === 'half-open') {
    if (breaker.probesInFlight >= breaker.options.probeConcurrency) {
      return false;
    }
    breaker.probesInFlight += 1;
    return true;
  }
  return true;
}

/**
 * Settles an admitted call as a success. In `half-open` it releases the
 * probe slot and earns one of the `successesNeeded` consecutive
 * successes that close the breaker (closing also clears the failure
 * window — the closed era starts fresh). In `closed` it is a no-op
 * (successes never erase failures; the window slides them out); in
 * `open` it is a no-op (only the cooldown admits again).
 */
export function recordSuccess(breaker: CircuitBreaker): void {
  settlePhase(breaker);
  if (breaker.phase !== 'half-open') {
    return;
  }
  releaseProbe(breaker);
  breaker.successes += 1;
  if (breaker.successes >= breaker.options.successesNeeded) {
    breaker.phase = 'closed';
    breaker.failures = [];
    breaker.successes = 0;
    breaker.probesInFlight = 0;
  }
}

/**
 * Settles an admitted call as a failure and reports whether it counted.
 * The breaker's `errorFilter` decides: a filtered-out error (e.g. a 4xx
 * under {@link skipClientErrors}) still releases its probe slot but
 * accrues nothing — the caller rethrows it as-is. A counted failure in
 * `closed` lands in the sliding window (`windowMs`) and trips `open` at
 * `failureThreshold`; in `half-open` any counted failure re-trips
 * `open` immediately, restarting the cooldown; in `open` it is a no-op
 * (already tripped).
 *
 * Returns `true` when the failure counted toward a transition.
 */
export function recordFailure(
  breaker: CircuitBreaker,
  error?: unknown
): boolean {
  settlePhase(breaker);
  const counts = breaker.options.errorFilter(error);
  if (breaker.phase === 'half-open') {
    releaseProbe(breaker);
    if (counts) {
      trip(breaker);
    }
    return counts;
  }
  if (breaker.phase !== 'closed' || !counts) {
    return false;
  }
  const now = breaker.options.now();
  pushSlidingTimestamps(breaker.failures, now, breaker.options.windowMs);
  if (breaker.failures.length >= breaker.options.failureThreshold) {
    trip(breaker);
  }
  return true;
}

/**
 * Wraps one async call in the breaker's policy — the one-liner face.
 *
 * Admission: rejected calls never run `fn`; the rejection is a 503
 * `HttpError` (`{"error":"Service Unavailable"}`) carrying
 * `Retry-After` as the seconds of cooldown left (a `half-open` slot
 * rejection answers `1` — a probe is out, not a cooldown). Inside an
 * app this flows to the error boundary like `s200/rate-limit`'s 429:
 * `onError` can take over, and the chain below never ran. Callers that
 * prefer their own fallback use {@link canPass} instead.
 *
 * Outcome: the value passes through on success; the underlying error
 * passes through untouched on failure — the breaker records it (via
 * `errorFilter`) but never translates, wraps, or swallows it.
 */
export async function breakerCall<T>(
  breaker: CircuitBreaker,
  fn: () => T | Promise<T>
): Promise<T> {
  if (!canPass(breaker)) {
    const remaining =
      breaker.phase === 'open'
        ? breaker.options.cooldownMs -
          (breaker.options.now() - breaker.openedAt)
        : 0;
    const retryAfter = Math.max(1, Math.ceil(remaining / 1000));
    throw httpError(
      503,
      'Service Unavailable',
      { error: 'Service Unavailable' },
      { 'retry-after': String(retryAfter) }
    );
  }
  try {
    const value = await fn();
    recordSuccess(breaker);
    return value;
  } catch (error) {
    recordFailure(breaker, error);
    throw error;
  }
}

/**
 * Frozen snapshot of the live machine — what a `canPass` would see
 * right now (the lazy `open` → `half-open` transition applied), plus
 * the counters a dashboard wants. Mutating the returned object is a
 * no-op by design: it is a report, not the state.
 */
export function circuitStatus(breaker: CircuitBreaker): CircuitBreakerStatus {
  settlePhase(breaker);
  return Object.freeze({
    phase: breaker.phase,
    failures: breaker.failures.length,
    successes: breaker.successes,
    probesInFlight: breaker.probesInFlight,
    openedAt: breaker.openedAt,
    retryAtMs:
      breaker.phase === 'open'
        ? breaker.openedAt + breaker.options.cooldownMs
        : 0,
  });
}
