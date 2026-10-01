/**
 * Unit-metrics battery — the scheduler's eyes on one schedulable unit. A
 * `createUnitMetrics()` bundle holds three things: a `middleware` that counts
 * requests entering/leaving the unit (in-flight, cumulative peak, cumulative
 * completions), a `snapshot()` that reads those counters plus live process
 * vitals (event-loop utilization, RSS, heap), and `reset()` for a fresh
 * measurement window (dev hot-reload re-baselining, test isolation). The
 * `unitMetricsEndpoint` handler exposes the snapshot over HTTP so a supervisor
 * can scrape the unit it dispatched work to.
 *
 * The library deliberately makes no scheduling decisions: `maxConcurrency`
 * here only shapes the `queueDepth` *report* (requests beyond the announced
 * cap would have to queue upstream) — enforcing the cap is the dispatcher's
 * job. ELU is read incrementally on each `snapshot()`: the previous reading is
 * kept and diffed, so there is no background timer thread keeping the module
 * alive or waking the event loop.
 *
 * @module
 */


import type { JsonResponse } from './respond';
import type { Handler, Middleware, Params, State } from './types';

import { performance } from 'node:perf_hooks';

import { json } from './respond';

/**
 * One point-in-time reading of a unit. All counters are cumulative since the
 * last {@link createUnitMetrics} call or `reset()`. `eventLoopUtilization`
 * is the 0..1 busy ratio *between* the previous snapshot and this one (the
 * first snapshot measures from creation), so a supervisor polling at its own
 * cadence gets utilization over exactly that interval.
 */
export type UnitMetrics = {
  /** Requests currently inside the unit's chain. */
  readonly inFlight: number;
  /** Highest {@link inFlight} ever seen — the peak the unit actually absorbed. */
  readonly maxInFlight: number;
  /** Requests that finished (handler resolved or errored) — completions, not arrivals. */
  readonly requests: number;
  /** `max(0, inFlight - maxConcurrency)`; always 0 when no cap was announced. */
  readonly queueDepth: number;
  /** Event-loop busy ratio 0..1 since the previous snapshot. */
  readonly eventLoopUtilization: number;
  /** Resident set size in bytes (`process.memoryUsage().rss`). */
  readonly rss: number;
  /** JS heap in use in bytes (`process.memoryUsage().heapUsed`). */
  readonly heapUsed: number;
  /** Sticky: `true` once `requests` reached `warmAfter` (default 1) — until `reset()`. */
  readonly warm: boolean;
  /** `Date.now()` at creation (or last `reset()`) — the measurement window's start. */
  readonly startedAt: number;
};

/** Knobs for {@link createUnitMetrics}: the concurrency the *dispatcher* announced (shapes `queueDepth`) and the completion count that marks the unit warm. */
export type UnitMetricsOptions = {
  readonly maxConcurrency?: number;
  readonly warmAfter?: number;
};

/**
 * Creates a metrics bundle for one unit. Register `middleware` early (before
 * routes) so every request — handled, 404, or errored — is counted on both
 * entry and exit; the chain's in-band error boundary means `next()` resolving
 * already implies a materialized response, and the `finally` keeps the
 * counters honest even when a sibling middleware throws past it. A request
 * that errored still counts as *completed*: the unit did finish doing
 * something with it.
 */
export function createUnitMetrics(options: UnitMetricsOptions = {}): {
  readonly middleware: Middleware;
  readonly snapshot: () => UnitMetrics;
  readonly reset: () => void;
} {
  // 0 = uncapped: queueDepth stays 0 whatever the concurrency, because no
  // dispatcher-side cap was announced for this unit.
  const maxConcurrency = options.maxConcurrency ?? 0;
  const warmAfter = options.warmAfter ?? 1;

  let inFlight = 0;
  let maxInFlight = 0;
  let requests = 0;
  let warm = false;
  let startedAt = Date.now();
  let lastElu = performance.eventLoopUtilization();

  const middleware: Middleware = (_ctx, next) => {
    inFlight += 1;
    if (inFlight > maxInFlight) {
      maxInFlight = inFlight;
    }
    return (async () => {
      try {
        await next();
      } finally {
        inFlight -= 1;
        requests += 1;
        if (requests >= warmAfter) {
          warm = true;
        }
      }
    })();
  };

  /**
   * Event-loop busy ratio since the previous read, consumed and rebaselined:
   * each snapshot stores its reading as the base of the next diff. Node
   * returns `NaN` when zero loop time elapsed between reads (an idle unit
   * scraped twice back-to-back) — that is 0% busy, not NaN.
   */
  const eluSinceLastRead = (): number => {
    const current = performance.eventLoopUtilization();
    const delta = performance.eventLoopUtilization(current, lastElu);
    lastElu = current;
    return Number.isFinite(delta.utilization)
      ? Math.min(1, Math.max(0, delta.utilization))
      : 0;
  };

  const snapshot = (): UnitMetrics => {
    const memory = process.memoryUsage();
    return {
      inFlight,
      maxInFlight,
      requests,
      queueDepth:
        maxConcurrency > 0 ? Math.max(0, inFlight - maxConcurrency) : 0,
      eventLoopUtilization: eluSinceLastRead(),
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      // The flag is sticky (never un-sets mid-window); the fallback covers a
      // degenerate warmAfter of 0 — warm from creation, before any request.
      warm: warm || requests >= warmAfter,
      startedAt,
    };
  };

  /** Zeroes every counter, clears warmth, and opens a fresh window: new `startedAt`, ELU rebaselined to *now*. */
  const reset = (): void => {
    inFlight = 0;
    maxInFlight = 0;
    requests = 0;
    warm = false;
    startedAt = Date.now();
    lastElu = performance.eventLoopUtilization();
  };

  return { middleware, snapshot, reset };
}

/**
 * Metrics scrape endpoint: 200 with the current {@link UnitMetrics} body.
 * Register it on the unit's own app (`get(app, '/metrics', unitMetricsEndpoint(m))`)
 * — mounted before or after `m.middleware` it stays correct: unwrapped it
 * reports the unit's totals, wrapped it honestly shows itself as the one
 * request currently in flight.
 */
export function unitMetricsEndpoint(
  m: { readonly snapshot: () => UnitMetrics }
): Handler<Params, State, JsonResponse<UnitMetrics>> {
  return (ctx) => json(ctx, m.snapshot());
}
