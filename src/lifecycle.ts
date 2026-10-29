/**
 * Lifecycle battery — NestJS' enableShutdownHooks +
 * onApplicationShutdown equivalent: one graceful drain shared by `stop()`
 * and the OS signals. The order is the load-balancer-safe one: flip the
 * readiness gate FIRST (probes go 503, traffic stops arriving), then stop
 * accepting new connections, wait out in-flight requests within the
 * budget, hard-kill the stragglers, let in-flight `onFinish` callbacks
 * settle, and only then run the app's own `onShutdown`.
 *
 * Runtime-agnostic by duck typing — no node/bun imports: a raw server with
 * `closeIdleConnections` (node http/https/http2) gets `close()` plus
 * CONTINUOUS idle reaping — a one-shot reap misses keep-alive sockets that
 * go idle mid-drain as their response finishes, and they would hold
 * `close()`'s callback open until the deadline — then `closeAllConnections()`
 * on deadline; a raw server with `stop` (Bun) gets `stop(false)` graceful /
 * `stop()` forced; anything else falls back to the adapter's own `close()`.
 *
 * @module
 */

import { drainHttpServer } from './drain';
import { finishersIdle } from './finish';

/**
 * The minimal server surface {@link lifecycle} needs: every adapter
 * `serve()` result satisfies it structurally. `server` — the runtime's raw
 * server, when the adapter exposes it — unlocks the graceful paths.
 */
export type LifecycleServer = {
  close(): Promise<void>;
  server?: unknown;
};

/**
 * One shutdown hook — the `onApplicationShutdown` callback; see
 * `LifecycleOptions.onShutdown` for the array semantics.
 */
export type ShutdownHook = () => void | Promise<void>;

export type LifecycleOptions = {
  /**
   * Signals that trigger the same drain as `stop()`;
   * default `['SIGTERM', 'SIGINT']`. Pass `[]` to keep signal handling to
   * yourself. A second signal DURING a drain hard-kills immediately
   * instead of waiting out the budget.
   */
  signals?: string[];
  /**
   * Drain budget in ms: in-flight requests get this long to finish before
   * their connections are force-closed. Default 10_000.
   */
  timeout?: number;
  /**
   * Flipped closed with `'draining'` as the FIRST step of the drain —
   * pass a `createGate()` from `s200/health` (structural: anything with
   * `close(reason?)` works).
   */
  readiness?: { close(reason?: string): void };
  /**
   * Runs after connections drained (or the budget expired) and — with
   * `waitForFinishers` (the default) — after in-flight `onFinish`
   * callbacks settled: the `onApplicationShutdown` hook. Pass a single
   * function or an array; an array runs in registration order, and one
   * hook failing never blocks the rest (Fastify `onClose` semantics) —
   * the first error rejects `stop()` (a signal-triggered drain logs it
   * via `console.error`, `stopped` still resolves), every later error is
   * `console.error`'d so it cannot disappear.
   */
  onShutdown?: ShutdownHook | readonly ShutdownHook[];
  /**
   * After connections drained, wait for in-flight `onFinish` callbacks
   * (`finishersIdle()` from the core barrel) before running `onShutdown`.
   * Default `true`: by then the drain budget's hard kill has already
   * bounded the connection side, and shutdown hooks usually close the
   * sinks finishers write into (metrics, pools) — waiting keeps that
   * order honest. `false` keeps finishers strictly fire-and-forget from
   * the drain's point of view. Like `onShutdown`, the wait is not
   * time-boxed: a finisher that never settles holds the drain open.
   */
  waitForFinishers?: boolean;
};

export type LifecycleHandle = {
  /** Begins (or joins) the drain — the same path a signal takes, idempotent. */
  stop(): Promise<void>;
  /**
   * Resolves once the drain has settled — never rejects: a signal path
   * `onShutdown` failure is `console.error`'d instead of surfacing here.
   */
  stopped: Promise<void>;
};

/** Drain budget when `options.timeout` is omitted. */
const DEFAULT_TIMEOUT = 10_000;

/** The raw-server surface the graceful paths duck-type onto. */
type RawServer = {
  close?(callback?: (error?: Error) => void): unknown;
  closeIdleConnections?(): void;
  closeAllConnections?(): void;
  stop?(force?: boolean): unknown;
};

/**
 * Graceful drain for an app's server: `lifecycle(server)` registers
 * SIGTERM/SIGINT (or your list) to the same `stop()` path, takes the
 * process out of rotation via the readiness gate before touching sockets,
 * waits out in-flight requests within the budget, hard-kills on deadline
 * or a second signal, waits out in-flight `onFinish` callbacks (unless
 * `waitForFinishers: false`), then awaits `onShutdown` — one function or
 * an array, in registration order. Signal listeners are removed once the
 * drain settles — no leaks, no second lifecycle fighting over the same
 * process.
 */
export function lifecycle(
  server: LifecycleServer,
  options: LifecycleOptions = {}
): LifecycleHandle {
  const signals = options.signals ?? ['SIGTERM', 'SIGINT'];
  const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT;
  const waitForFinishers = options.waitForFinishers !== false;
  // A single function and an array are the same feature — normalize once
  // so the drain path never re-inspects the shape.
  const hooks: readonly ShutdownHook[] =
    options.onShutdown === undefined
      ? []
      : typeof options.onShutdown === 'function'
        ? [options.onShutdown]
        : options.onShutdown;

  let drain: Promise<void> | undefined;
  // The active hard-kill while connections are being waited on — a second
  // signal invokes it instead of starting a second drain.
  let kill: (() => void) | undefined;
  let settleStopped: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    settleStopped = resolve;
  });

  const cleanup = (): void => {
    unregister();
    settleStopped();
  };

  // Fastify onClose semantics: one failing hook never blocks the rest.
  // The first error keeps the single-hook contract — stop() rejects, a
  // signal path logs it, stopped never rejects — every later error is
  // console.error'd: swallowing it would be silent, and rejecting with it
  // would race the first.
  const runShutdownHooks = async (): Promise<void> => {
    let first: { readonly error: unknown } | undefined;
    for (const hook of hooks) {
      try {
        await hook();
      } catch (error) {
        if (first === undefined) {
          first = { error };
        } else {
          console.error('[s200] onShutdown hook failed', error);
        }
      }
    }
    if (first !== undefined) {
      throw first.error;
    }
  };

  // Node path: stop accepting new connections, reap keep-alive sockets
  // that go idle mid-drain, force-close on deadline. The skeleton is
  // drain.ts's, shared with the node adapter's close() and the shard
  // executor's child realms; this wiring only adds the second-signal
  // kill switch. Resolves when the server's close callback fires — never
  // rejects (a close() error here means already-drained).
  const drainNode = (raw: RawServer): Promise<void> =>
    new Promise((resolve) => {
      drainHttpServer(raw, {
        budgetMs: timeoutMs,
        onKill: (killNow) => {
          kill = killNow;
        },
        settle: () => resolve(),
      });
    });

  // Bun path: stop(false) is the graceful stop, stop() the immediate one.
  // The graceful promise settles the wait when the runtime provides one;
  // otherwise there is nothing observable to await — the stop is initiated
  // and onShutdown proceeds. Never rejects.
  const drainBun = (raw: RawServer): Promise<void> =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(deadline);
        kill = undefined;
        resolve();
      };
      const hardKill = (): void => {
        try {
          raw.stop?.();
        } catch {
          // Already stopped — nothing to force.
        }
        finish();
      };
      const deadline = setTimeout(hardKill, timeoutMs);
      kill = hardKill;
      let stopping: unknown;
      try {
        stopping = raw.stop?.(false);
      } catch {
        // A stop() that throws is a stopped server — nothing to wait for.
        finish();
        return;
      }
      if (stopping !== undefined && typeof (stopping as { then?: unknown }).then === 'function') {
        (stopping as Promise<unknown>).then(
          () => finish(),
          () => finish()
        );
      } else {
        finish();
      }
    });

  const drainConnections = (): Promise<void> => {
    const raw = server.server as RawServer | undefined;
    if (
      raw !== undefined &&
      typeof raw.closeIdleConnections === 'function' &&
      typeof raw.close === 'function'
    ) {
      return drainNode(raw);
    }
    if (raw !== undefined && typeof raw.stop === 'function') {
      return drainBun(raw);
    }
    // Fallback: the adapter's own close(), whatever its semantics.
    return Promise.resolve().then(() => server.close());
  };

  // Idempotent trigger: the first caller (signal or stop()) runs the
  // sequence, everyone else joins the same drain promise.
  const trigger = (): Promise<void> => {
    if (drain === undefined) {
      // Step 1: out of rotation BEFORE sockets close, so load balancers
      // stop sending before connections drop.
      options.readiness?.close('draining');
      // Steps 2-3: stop accepting, wait out in-flight (never rejects).
      // Step 4: in-flight onFinish callbacks settle BEFORE the hooks —
      // hooks usually close what finishers write into, and the finishers
      // themselves stay fire-and-forget; this is only the wait.
      // Step 5: onShutdown hooks in registration order.
      drain = drainConnections()
        .then(() => (waitForFinishers ? finishersIdle() : undefined))
        .then(runShutdownHooks);
      // Settlement wiring rides the same chain; the error branch keeps
      // the rejection from surfacing as an unhandledRejection — stop()
      // callers still receive it from the drain promise itself.
      drain.then(cleanup, cleanup);
    }
    return drain;
  };

  const onSignal = (): void => {
    if (drain !== undefined) {
      // Second signal during a drain: hard kill, no waiting.
      kill?.();
      return;
    }
    void trigger().catch((error) => {
      console.error(error);
    });
  };

  // Signal registration is runtime-optional: edge runtimes without a
  // `process` still get stop(); the drain path itself needs no globals.
  const register = (): void => {
    if (typeof process === 'undefined' || typeof process.on !== 'function') {
      return;
    }
    for (const signal of signals) {
      process.on(signal, onSignal);
    }
  };
  const unregister = (): void => {
    if (typeof process === 'undefined' || typeof process.removeListener !== 'function') {
      return;
    }
    for (const signal of signals) {
      process.removeListener(signal, onSignal);
    }
  };

  register();

  return {
    stop: trigger,
    stopped,
  };
}
