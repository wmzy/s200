/**
 * Load-shed battery — the pressure valve. `loadShed()` is a gate middleware
 * that checks optional pressure thresholds on entry — event-loop
 * utilization (0..1), resident memory (bytes), in-flight request count —
 * and when any configured dimension is over, throws a 503 `HttpError`
 * (`{"error":"Service Unavailable"}` with a `Retry-After` advice header)
 * into the app's error boundary: the default mapping ships exactly that, a
 * configured `onError` takes over, and the rest of the chain never runs.
 * An overloaded unit spends its remaining budget on requests it already
 * accepted instead of queueing more (the @fastify/under-pressure role,
 * zero dependencies, no background timers).
 *
 * Every sensor is injectable (`options.sensors`, per dimension), so tests
 * drive the gate with fake readings and multi-instance deployments can
 * share one counter. The defaults read `performance.eventLoopUtilization()`
 * incrementally (each check diffed against the previous one — the reading
 * spans exactly the gap between requests), `process.memoryUsage().rss`,
 * and an internal in-flight ledger that counts requests in and out — a
 * count, never a sample. `bypass` exempts the probes: a shedder that
 * answers 503 on `/healthz` tells the platform the unit is dead and gets
 * it replaced exactly when it needed breathing room instead.
 *
 * @module
 */

import type { Ctx, Middleware } from './types';

import { assertPositive } from './assert';
import { createEluReader } from './elu';
import { httpError } from './errors';

/**
 * Pressure sensors — one reader per dimension, each independently
 * injectable. Unspecified dimensions fall back to the built-in readers;
 * see each field for its default.
 */
export type LoadShedSensors = {
  /**
   * Event-loop busy ratio 0..1. Default: an incremental
   * `performance.eventLoopUtilization()` diff since the previous check —
   * no background timer keeps the loop awake, and the reading covers
   * exactly the gap between requests.
   */
  readonly eventLoopUtilization?: () => number;
  /**
   * Resident set size in bytes. Default: `process.memoryUsage().rss`.
   */
  readonly rssBytes?: () => number;
  /**
   * Requests currently in flight. Default: the middleware's own
   * incremental counter — incremented on entry, decremented when the
   * request settles, shed 503s included. Inject this to enforce a cap
   * shared across instances (a Redis-backed counter, an upstream
   * dispatcher's number).
   */
  readonly inFlight?: () => number;
};

/** Knobs for {@link loadShed}: thresholds, the `Retry-After` advice, the probe exemption, and the sensors. */
export type LoadShedOptions = {
  /**
   * Shed when the event-loop busy ratio is strictly above this (0..1 —
   * `0.95` sheds at `0.951`, passes at exactly `0.95`). Unset: the
   * dimension is not checked and its sensor is never read.
   */
  readonly maxEventLoopUtilization?: number;
  /**
   * Shed when resident memory is strictly above this many bytes. Unset:
   * not checked.
   */
  readonly maxRssBytes?: number;
  /**
   * Shed when the in-flight count is strictly above this. The incoming
   * request itself counts: `maxInFlight: 100` lets the 100th concurrent
   * request in and sheds the 101st. Unset: not checked.
   */
  readonly maxInFlight?: number;
  /**
   * The `Retry-After` header on the 503, in seconds; default `1`.
   * Recovery time under pressure is unknowable without a sensor, so the
   * number is advice, not a promise — clients that honor it back off one
   * interval and retry.
   */
  readonly retryAfterSeconds?: number;
  /**
   * Skip predicate: `true` and the request is neither counted nor
   * checked — the chain runs immediately. Exempt the liveness/readiness
   * probes (`ctx.url.pathname === '/healthz'`): shedding them tells the
   * platform the unit is dead exactly when it needed breathing room.
   */
  readonly bypass?: (ctx: Ctx) => boolean;
  /**
   * Sensor overrides, per dimension — see {@link LoadShedSensors} for the
   * defaults. Tests drive the gate through these instead of manufacturing
   * real load.
   */
  readonly sensors?: LoadShedSensors;
};

/**
 * Load-shed gate. On entry, every configured threshold is checked against
 * its reading; the first one strictly over throws a 503 `HttpError`
 * (`{"error":"Service Unavailable"}` + `Retry-After`) into the error
 * boundary — the chain below never runs, unwind middlewares (logger, cors)
 * observe the real 503, and a configured `onError` owns the wire answer.
 * Unconfigured dimensions cost nothing: their sensors are never read.
 *
 * The in-flight ledger settles every request in a `finally` — handler
 * resolved, handler errored, or shed — so the count recovers the moment
 * the chain drains. Invalid thresholds throw a plain `Error` at creation:
 * a bad bound is a programmer error, not a runtime failure to report.
 */
export function loadShed(options: LoadShedOptions = {}): Middleware {
  const maxElu = options.maxEventLoopUtilization;
  const maxRssBytes = options.maxRssBytes;
  const maxInFlight = options.maxInFlight;
  const retryAfterSeconds = options.retryAfterSeconds ?? 1;
  const bypass = options.bypass;
  const sensors = options.sensors;

  if (
    maxElu !== undefined &&
    (!Number.isFinite(maxElu) || maxElu <= 0 || maxElu > 1)
  ) {
    throw new Error(
      `Invalid load-shed maxEventLoopUtilization ${String(maxElu)}: must be in (0, 1]`
    );
  }
  if (maxRssBytes !== undefined) {
    assertPositive('load-shed', 'maxRssBytes', maxRssBytes);
  }
  if (maxInFlight !== undefined) {
    assertPositive('load-shed', 'maxInFlight', maxInFlight);
  }
  if (!Number.isInteger(retryAfterSeconds) || retryAfterSeconds < 1) {
    throw new Error(
      `Invalid load-shed retryAfterSeconds ${String(retryAfterSeconds)}: must be a positive integer`
    );
  }

  // The in-flight ledger: count requests in and out, never sample. An
  // injected sensor replaces the reading, not the bookkeeping.
  let inFlight = 0;
  // ELU reader for the incremental default: each reading is diffed
  // against the previous one, so it covers the inter-request gap and no
  // timer ever wakes the loop (NaN→0 clamp lives in the reader).
  const elu = createEluReader();

  const readElu =
    sensors?.eventLoopUtilization ??
    ((): number => elu.read());
  const readRssBytes =
    sensors?.rssBytes ?? ((): number => process.memoryUsage().rss);
  const readInFlight = sensors?.inFlight ?? ((): number => inFlight);

  return async (ctx: Ctx, next) => {
    // Exempt requests skip the whole gate — not counted, not checked — so
    // a probe can never be shed and never skews the ledger.
    if (bypass !== undefined && bypass(ctx)) {
      return next();
    }
    inFlight += 1;
    try {
      // Strictly-over: a reading exactly at the threshold passes, and the
      // guards mean an unconfigured dimension never touches its sensor.
      if (
        (maxElu !== undefined && readElu() > maxElu) ||
        (maxRssBytes !== undefined && readRssBytes() > maxRssBytes) ||
        (maxInFlight !== undefined && readInFlight() > maxInFlight)
      ) {
        throw httpError(
          503,
          'Service Unavailable',
          { error: 'Service Unavailable' },
          { 'retry-after': String(retryAfterSeconds) }
        );
      }
      return await next();
    } finally {
      inFlight -= 1;
    }
  };
}
