/**
 * Health battery — the NestJS Terminus equivalent for s200: `health` is
 * the liveness probe (a process that answers at all is alive), `readiness`
 * runs a named check set concurrently under one per-check budget, and
 * `createGate` is the resettable switch `s200/lifecycle` flips first in a
 * graceful drain — probes answer 503 the instant draining starts, so load
 * balancers stop sending traffic before any socket closes.
 *
 * @module
 */

import type { JsonResponse } from './respond';
import type { Handler, Params, State } from './types';

import { json } from './respond';

/**
 * One health check: returns/resolves when healthy, throws/rejects with the
 * reason when not — the same shape NestJS Terminus gives its health
 * indicators, minus the DI. {@link Gate.check} and any hand-written
 * predicate both satisfy it.
 */
export type HealthCheck = () => void | Promise<void>;

/** Options for {@link readiness}: `timeout` is the per-check budget in ms (default 1000). */
export type ReadinessOptions = { timeout?: number };

/** Body of a liveness response. */
export type HealthBody = { readonly status: 'ok' };

/**
 * Body of a readiness report: the overall verdict plus each check's own
 * verdict — `'ok'`, or the failure reason (timeout, abort, or the thrown
 * message, truncated to {@link REASON_LIMIT} chars).
 */
export type ReadinessBody = {
  readonly status: 'ok' | 'fail';
  readonly checks: Readonly<Record<string, string>>;
};

/** Longest failure reason kept in a report — one chatty dependency must not bloat every probe response. */
const REASON_LIMIT = 200;

/** Default reason when a gate is closed without one. */
const GATE_CLOSED = 'unavailable';

/** Failure reason from any thrown value: an `Error`'s message, anything else stringified, truncated. */
function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > REASON_LIMIT ? `${message.slice(0, REASON_LIMIT - 1)}…` : message;
}

/**
 * Runs one check under the budget: raced against the deadline and against
 * the request's abort signal, so a hung dependency cannot pin the handler
 * past either. First settlement wins and clears both the timer and the
 * abort listener — no per-check leaks. Resolves healthy, rejects with the
 * failure/timeout/abort reason.
 */
function runCheck(check: HealthCheck, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    const armTimer = (): void => {
      timer = setTimeout(() => finish(new Error(`timeout of ${ms}ms exceeded`)), ms);
    };
    const finish = (error?: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    const onAbort = (): void => finish(signal.reason);
    armTimer();
    // An already-aborted signal never fires retroactively — fail fast
    // instead of running the check against a dead request.
    if (signal.aborted) {
      finish(signal.reason);
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    let result: void | Promise<void>;
    try {
      result = check();
    } catch (error) {
      finish(error);
      return;
    }
    const thenable = result as { then?: unknown } | undefined;
    if (thenable !== undefined && typeof thenable.then === 'function') {
      (result as Promise<void>).then(
        () => finish(),
        (error) => finish(error)
      );
    } else {
      finish();
    }
  });
}

/**
 * Liveness handler: a process that can answer at all is alive — 200
 * `{"status":"ok"}` with zero dependencies. Register on a dedicated path
 * (`get(app, '/live', health())`); liveness must never consult readiness
 * concerns, or one bad dependency gets the container killed.
 */
export function health(): Handler<Params, State, JsonResponse<HealthBody>> {
  return (ctx) => json(ctx, { status: 'ok' } satisfies HealthBody);
}

/**
 * Readiness handler: runs every check CONCURRENTLY under one per-check
 * budget (default 1000ms) — one slow dependency never delays the verdict
 * behind another, and every check reports even when a sibling fails. All
 * healthy → 200 `{"status":"ok","checks":{"db":"ok",...}}`; any failure →
 * 503 `{"status":"fail","checks":{"db":"<reason>",...}}` — failed checks
 * carry the reason, healthy ones carry `"ok"`. The budget also races
 * `ctx.signal`: a client that gave up stops the wait instead of pinning
 * the handler.
 */
export function readiness(
  checks: Record<string, HealthCheck>,
  options: ReadinessOptions = {}
): Handler<Params, State, JsonResponse<ReadinessBody, 200 | 503>> {
  const ms = options.timeout ?? 1000;
  return async (ctx) => {
    const outcomes = await Promise.all(
      Object.entries(checks).map(async ([name, check]) => {
        try {
          await runCheck(check, ms, ctx.signal);
          return { name, ok: true, reason: 'ok' };
        } catch (error) {
          return { name, ok: false, reason: reasonOf(error) };
        }
      })
    );
    const report: Record<string, string> = {};
    let healthy = true;
    for (const outcome of outcomes) {
      report[outcome.name] = outcome.reason;
      if (!outcome.ok) {
        healthy = false;
      }
    }
    return healthy
      ? json(ctx, { status: 'ok', checks: report } satisfies ReadinessBody)
      : json(ctx, { status: 'fail', checks: report } satisfies ReadinessBody, { status: 503 });
  };
}

/** A resettable drain switch — see {@link createGate}. */
export type Gate = {
  /** The {@link HealthCheck} face: throws the close reason while tripped. */
  check(): void;
  /** Trips the gate; `reason` becomes the 503 body's check message. */
  close(reason?: string): void;
  /** Resets the gate — the probe reports healthy again. */
  open(): void;
};

/**
 * Creates a {@link Gate} — the readiness half of a graceful drain. Wire it
 * into the probe (`readiness({ gate: gate.check })`) and into
 * `lifecycle(server, { readiness: gate })`: the moment draining starts the
 * probe answers 503 with the close reason, before any socket closes; flip
 * it back with `open()` once the process should take traffic again.
 */
export function createGate(): Gate {
  let reason: string | undefined;
  return {
    check(): void {
      if (reason !== undefined) {
        throw new Error(reason);
      }
    },
    close(why?: string): void {
      reason = why ?? GATE_CLOSED;
    },
    open(): void {
      reason = undefined;
    },
  };
}
