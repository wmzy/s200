/**
 * Response-finish callbacks. `onFinish(ctx, fn)` is the public surface
 * (core barrel): middleware registers a callback that runs exactly once
 * per request — when the response finishes writing, or when the
 * connection ends before it does (first trigger wins). The adapter-side
 * half (`runFinish`/`trackFinish`/`hasFinishers`) is internal — adapters
 * import it relatively, the barrel re-exports only `onFinish` (the
 * `s200/signal` internal-module precedent).
 *
 * @module
 */

import type { Ctx } from './types';

/** What {@link onFinish} hands its callback: `aborted` is `true` when the
 * response did not finish — the client disconnected (or the response body
 * was cancelled) before the last byte was written; `false` only for a
 * cleanly completed response. */
export type FinishInfo = { readonly aborted: boolean };

/** The {@link onFinish} callback. Fire-and-forget: the response path never
 * awaits it, a returned promise's rejection is logged (through the app's
 * `logError` when the adapter knows it), and a synchronous throw is logged
 * without stopping the other callbacks. */
export type FinishFn = (info: FinishInfo) => void | Promise<void>;

/** One request's registration: the callbacks plus the ctx they were
 * registered under (the error sink wants request context). */
type FinishEntry = { readonly ctx: Ctx; readonly fns: Set<FinishFn> };

// Keyed by the request object, not the ctx: `onFinish` holds the ctx, but
// only the adapter ever built (and still holds) the request — `ctx.req` is
// that same object. WeakKeyed: a request that finishes without a trigger
// dies silently with its callbacks. One entry per request — `runFinish`
// deletes before running, so the first trigger wins and every later one is
// a no-op.
const finishers = new WeakMap<object, FinishEntry>();

/**
 * Registers a callback that runs **exactly once** when this request's
 * response finishes. `{ aborted: false }` after the response was fully
 * written; `{ aborted: true }` when the connection ended first (client
 * disconnect, a cancelled response body, or a mid-write failure — first
 * trigger wins). Register before the finish: registrations after it are
 * dropped. Typical homes: a middleware around `await next()` (the cleanup
 * counterpart of work started on the way in) or the top of a handler.
 *
 * ```ts
 * use(app, async (ctx, next) => {
 *   const startedAt = Date.now();
 *   await next();
 *   onFinish(ctx, ({ aborted }) => {
 *     metrics.observe(ctx.url.pathname, Date.now() - startedAt, aborted);
 *   });
 * });
 * ```
 */
export function onFinish(ctx: Ctx, fn: FinishFn): void {
  const key = ctx.req as object;
  const existing = finishers.get(key);
  if (existing !== undefined) {
    existing.fns.add(fn);
    return;
  }
  finishers.set(key, { ctx, fns: new Set([fn]) });
}

/**
 * True when at least one {@link onFinish} callback is registered — the
 * adapters' gate for the finish wiring, so requests without callbacks pay
 * nothing (no body wrapping on the socket-less runtimes).
 *
 * @internal
 */
export function hasFinishers(request: Request): boolean {
  return finishers.has(request as object);
}

/** The default finish-callback error sink — the app's `logError` wins
 * whenever the adapter can pass it. */
function logFinishError(error: unknown): void {
  console.error('[s200] onFinish callback failed', error);
}

/** Runs one entry's callbacks with the log-and-continue error policy. */
function fire(
  entry: FinishEntry,
  info: FinishInfo,
  logError: ((error: unknown, ctx: Ctx) => void) | undefined
): void {
  for (const fn of entry.fns) {
    try {
      const returned = fn(info);
      if (returned instanceof Promise) {
        // Fire-and-forget: the response path is already closed (or closing)
        // — the rejection must not become unhandled.
        returned.catch((error: unknown) => {
          (logError ?? logFinishError)(error, entry.ctx);
        });
      }
    } catch (error) {
      (logError ?? logFinishError)(error, entry.ctx);
    }
  }
}

/**
 * Runs the request's finish callbacks once — first call wins, later calls
 * (and calls for requests without callbacks) are no-ops. The trigger the
 * socket-event runtimes call directly (`s200/node`: completed write and
 * premature `'close'`); the body-wrapping runtimes reach it through
 * {@link trackFinish}.
 *
 * @internal
 */
export function runFinish(
  request: Request,
  info: FinishInfo,
  logError?: (error: unknown, ctx: Ctx) => void
): void {
  const key = request as object;
  const entry = finishers.get(key);
  if (entry === undefined) {
    return;
  }
  finishers.delete(key);
  fire(entry, info, logError);
}

/**
 * Wraps the response body so its completion runs the finish callbacks —
 * the trigger for runtimes without write events (Deno, Workers, Bun):
 * stream done → `{ aborted: false }`, cancel or source error →
 * `{ aborted: true }`. A cancel is propagated to the wrapped body's
 * reader, so a handler-side generator sees its `finally`. A null body
 * finishes immediately — the response is complete by construction, and
 * those runtimes offer no later write event for empty bodies. Call only
 * after {@link hasFinishers} said yes: the wrap is the opt-in cost.
 *
 * @internal
 */
export function trackFinish(
  request: Request,
  response: Response,
  logError?: (error: unknown, ctx: Ctx) => void
): Response {
  const body = response.body;
  if (body === null) {
    runFinish(request, { aborted: false }, logError);
    return response;
  }
  const reader = body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          runFinish(request, { aborted: false }, logError);
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        // The source failed mid-response: it did not finish.
        runFinish(request, { aborted: true }, logError);
        controller.error(error);
      }
    },
    cancel: (reason) => {
      runFinish(request, { aborted: true }, logError);
      // Propagate to the handler-side source; its cancel may reject — the
      // runtime's cancel() must not inherit that rejection.
      return reader.cancel(reason).then(undefined, () => undefined);
    },
  });
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
