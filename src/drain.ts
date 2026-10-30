/**
 * Internal node-drain primitives shared across modules so no second copy
 * grows: `s200/node`'s graceful close, `s200/lifecycle`'s shutdown drain,
 * and the shard executor's child-realm drain all run the same skeleton —
 * stop accepting, reap idle keep-alive sockets continuously, hard-kill on
 * the deadline — and `s200/lifecycle`'s bun path runs the settled/deadline/
 * kill scaffolding too, with its `stop(false)`/`stop()` verbs injected
 * through {@link DrainOptions.gracefulStop} and {@link
 * DrainOptions.onHardKill}. NOT a public entry — the barrel does not
 * re-export this module; import it relatively from within src.
 *
 * @internal
 * @module
 */

/**
 * The raw-server surface the shared drain duck-types onto: node's
 * http/https servers carry every member, HTTP/2-over-TLS lacks the
 * connection reapers, and `s200/lifecycle`'s structural servers may carry
 * any subset — each call site degrades to what its server actually has.
 */
type DrainedServer = {
  close?(callback?: (error?: Error) => void): unknown;
  closeIdleConnections?(): void;
  closeAllConnections?(): void;
};

/** How a call site specializes the shared drain skeleton. */
export type DrainOptions = {
  /** Total budget before the hard kill. */
  readonly budgetMs: number;
  /** Replaces the node graceful start (`server.close(callback)` — the
   * callback settles once every connection has ended) for servers whose
   * graceful verb is something else — `s200/lifecycle`'s bun path:
   * `stop(false)`. A promise return settles on resolution or rejection,
   * anything else has nothing observable to await so it settles at once;
   * a throw means already stopped, which the skeleton's catch settles.
   * The idle reaper stays a node-path concern — it is skipped when this
   * is provided. */
  readonly gracefulStop?: (finish: (error?: Error | null) => void) => void;
  /** Extra destruction on the hard kill — `s200/node`'s upgraded-socket
   * and h2-session registries: `closeAllConnections()` cannot reach
   * sockets taken over by `'upgrade'`, and HTTP/2 sessions have no such
   * method at all. Receives the skeleton's settle for call sites whose
   * forced stop is itself terminal — bun's `stop()`, where no close
   * callback exists to settle the drain afterwards. */
  readonly onHardKill?: (finish: (error?: Error | null) => void) => void;
  /** Runs right after `close()` is issued — `s200/node`'s GOAWAY sweep
   * over persistent h2 sessions, which would otherwise hold close()'s
   * callback open until the client leaves. */
  readonly afterClose?: () => void;
  /** Observes the live hard-kill (armed at once) and its release (when
   * the drain settles) — `s200/lifecycle`'s second-signal switch: a
   * SIGTERM racing the drain invokes the kill instead of starting a
   * second drain. */
  readonly onKill?: (kill: (() => void) | undefined) => void;
  /** Settles the drain, receiving close()'s error when there is one —
   * call sites decide whether that rejects (`s200/node`) or is ignored
   * (lifecycle and the shard executor: a server refusing a second
   * `close()` is already drained). */
  readonly settle: (error?: Error | null) => void;
};

/** Idle-socket reap cadence while draining — fast enough that a response
 * finishing mid-drain does not wait the whole budget for its keep-alive
 * socket to be noticed, slow enough to be free. */
const reapCadenceMs = (budgetMs: number): number =>
  Math.max(1, Math.min(250, Math.floor(budgetMs / 20)));

/**
 * The drain skeleton itself: stop accepting new connections, destroy idle
 * keep-alive sockets now and whenever they go idle mid-drain (a one-shot
 * reap misses sockets whose response finishes mid-drain — they would hold
 * close()'s callback open until the deadline), and hard-kill on the
 * budget deadline. close()'s callback fires once every connection has
 * ended, so the last in-flight response landing settles the drain early.
 * A `gracefulStop` injection swaps the stop-accepting verb (and skips the
 * idle reaper); the settled/deadline/kill scaffolding is every call
 * site's either way.
 *
 * @internal
 */
export function drainHttpServer(server: DrainedServer, options: DrainOptions): void {
  const { budgetMs, gracefulStop, onHardKill, afterClose, onKill, settle } = options;
  let settled = false;
  let reaper: ReturnType<typeof setInterval> | undefined;
  const hardKill = (): void => {
    server.closeAllConnections?.();
    onHardKill?.(finish);
  };
  const finish = (error?: Error | null): void => {
    if (settled) {
      return;
    }
    settled = true;
    if (reaper !== undefined) {
      clearInterval(reaper);
    }
    clearTimeout(deadline);
    onKill?.(undefined);
    settle(error);
  };
  const deadline = setTimeout(hardKill, budgetMs);
  onKill?.(hardKill);
  try {
    if (gracefulStop !== undefined) {
      // The call site's own graceful verb (bun's stop(false)) — the
      // settle it receives is the skeleton's, deadline and kill switch
      // included.
      gracefulStop(finish);
    } else {
      // Stop accepting new connections. The callback fires once every
      // connection has ended — in-flight responses finish and their
      // sockets are reaped below.
      server.close?.((error) => finish(error));
      afterClose?.();
    }
  } catch (error) {
    // A server refusing a second close() — or stop() — is already
    // drained.
    finish(error as Error);
  }
  if (!settled && gracefulStop === undefined) {
    // Keep-alive sockets that go idle mid-drain (their response just
    // finished) would otherwise hold close()'s callback open until the
    // deadline — reap continuously, not once.
    server.closeIdleConnections?.();
    reaper = setInterval(() => server.closeIdleConnections?.(), reapCadenceMs(budgetMs));
  }
}
