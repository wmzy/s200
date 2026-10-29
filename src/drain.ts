/**
 * Internal node-drain primitives shared across modules so no second copy
 * grows: `s200/node`'s graceful close, `s200/lifecycle`'s shutdown drain,
 * and the shard executor's child-realm drain all run the same skeleton —
 * stop accepting, reap idle keep-alive sockets continuously, hard-kill on
 * the deadline. NOT a public entry — the barrel does not re-export this
 * module; import it relatively from within src.
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
  /** Extra destruction on the hard kill — `s200/node`'s upgraded-socket
   * and h2-session registries: `closeAllConnections()` cannot reach
   * sockets taken over by `'upgrade'`, and HTTP/2 sessions have no such
   * method at all. */
  readonly onHardKill?: () => void;
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
 *
 * @internal
 */
export function drainHttpServer(server: DrainedServer, options: DrainOptions): void {
  const { budgetMs, onHardKill, afterClose, onKill, settle } = options;
  let settled = false;
  let reaper: ReturnType<typeof setInterval> | undefined;
  const hardKill = (): void => {
    server.closeAllConnections?.();
    onHardKill?.();
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
    // Stop accepting new connections. The callback fires once every
    // connection has ended — in-flight responses finish and their sockets
    // are reaped below.
    server.close?.((error) => finish(error));
    afterClose?.();
  } catch (error) {
    // A server refusing a second close() is already drained.
    finish(error as Error);
  }
  if (!settled) {
    // Keep-alive sockets that go idle mid-drain (their response just
    // finished) would otherwise hold close()'s callback open until the
    // deadline — reap continuously, not once.
    server.closeIdleConnections?.();
    reaper = setInterval(() => server.closeIdleConnections?.(), reapCadenceMs(budgetMs));
  }
}
