/**
 * Executor adapter layer for the schedulable-unit contract: turns
 * `ShardPlan`s (from `s200/shard`) into actually-running units. The library
 * stays a data plane — it starts, watches, and stops units, but never
 * decides WHERE a request goes (that is `matchShard` + the gateway's job).
 *
 * Four executors:
 * - `inline` — nothing to run; the caller dispatches through
 *   `s200/shard-dev` in-process. Present in `units()` for observability.
 * - `thread` — the flagship: the supervisor pre-binds each shard's port
 *   with a paused listener, spawns a worker thread only when the FIRST
 *   connection arrives, then hands the listening server (and the paused
 *   sockets) over to the worker via Node's worker-thread postMessage
 *   transfer (node ≥ 26). On older runtimes — which cannot transfer
 *   handles at all — the supervisor pipes accepted sockets byte-for-byte
 *   to the worker's private port instead: same lazy spawn, same first
 *   request served, never a refused or reset connection. Idle shards cost
 *   zero threads in both modes; only the ≥ 26 path keeps a shard's HTTP
 *   traffic entirely off the supervisor thread.
 * - `process` — forks the child-realm module (`./executor-child`) as a
 *   shim; the child detects the `S200_*` sentinel env vars, imports the
 *   user entry, and serves its own port. Process isolation for shards
 *   that must not share a V8 heap.
 * - `external` — already running elsewhere; reported as `state: 'external'`,
 *   never spawned or stopped by us.
 *
 * The code that runs inside a child realm — worker bootstrap, process
 * shim, the node-http bridge, the entry/app contract — lives in
 * `./executor-child`, re-exported below so `s200/executor` remains the
 * one public specifier for the battery.
 *
 * @module
 */

import type { App } from './app';
import type { ShardSpec } from './shard';
import type { WorkerOut } from './executor-child';

import type { ChildProcess } from 'node:child_process';
import type { Server as NetServer, Socket } from 'node:net';

import { fork } from 'node:child_process';
import { createServer as createNetServer, connect as connectSocket } from 'node:net';
import process from 'node:process';
import { Worker } from 'node:worker_threads';

import { SELF_PATH, SELF_URL, WORKER_BOOTSTRAP } from './executor-child';
import { messageOf } from './errors';

// Child-realm machinery re-exports: `s200/executor` keeps the whole
// battery's public surface at one specifier (and the published bundle
// merges both modules into this entry's chunk anyway).
export {
  appFromEntry,
  createShardServer,
  installShardResolution,
  runThreadShard,
  startShardWorker,
} from './executor-child';
export type { WorkerLaunch } from './executor-child';

/**
 * How a shard runs. `inline` keeps everything in-process (the caller
 * dispatches), `thread`/`process` run the entry in a child realm with
 * increasing isolation, `external` marks a unit this supervisor neither
 * starts nor owns.
 */
export type Executor =
  | { readonly kind: 'inline'; readonly app: App }
  | { readonly kind: 'thread'; readonly entry: string }
  | { readonly kind: 'process'; readonly entry: string }
  | { readonly kind: 'external'; readonly address: string };

/** One resolved {@link ShardSpec} plus the executor that should run it. */
export type ShardPlan = {
  readonly spec: ShardSpec;
  readonly executor: Executor;
  /** Explicit port override; omitted, thread/process units draw from the 31000+ counter. */
  readonly port?: number;
};

/**
 * Unit lifecycle. `spawning` covers "port bound (thread) or child booting,
 * not yet serving"; `failed` means an unexpected exit happened and the
 * backoff restart is pending.
 */
export type UnitState = 'spawning' | 'ready' | 'draining' | 'stopped' | 'failed' | 'external';

/** The observable face of one unit — what `units()` reports. */
export type UnitStatus = {
  readonly id: string;
  readonly state: UnitState;
  readonly port?: number;
  /** Unexpected-exit restarts since the last stable period. */
  readonly restarts: number;
  readonly lastError?: string;
};

/** Start/stop/report handle over the planned shards. */
export type Supervisor = {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly units: () => readonly UnitStatus[];
};

/** First port handed out when a plan does not name one. */
const DEFAULT_PORT_BASE = 31000;
/** How long stop() waits for a graceful drain before terminating/killing. */
const STOP_GRACE_MS = 3000;
const RESTART_BACKOFF_BASE_MS = 100;
const RESTART_BACKOFF_MAX_MS = 5000;

// Monotonic across the process so two supervisors never hand out the same
// default port; the wrap-around keeps it honest across long test runs.
let nextPort = DEFAULT_PORT_BASE;

function allocatePort(): number {
  const port = nextPort;
  nextPort = nextPort >= 65500 ? DEFAULT_PORT_BASE : nextPort + 1;
  return port;
}

function nextBackoff(current: number): number {
  return current === 0 ? RESTART_BACKOFF_BASE_MS : Math.min(current * 2, RESTART_BACKOFF_MAX_MS);
}

// Resolved by the first thread hand-off and memoized process-wide: worker
// thread handle transfer (net.Server/net.Socket in postMessage's transfer
// list) only exists from node 26 (nodejs/node#64225) — older runtimes,
// node 20/22/24 included, throw DataCloneError and take the relay path.
let handleTransferWorks: boolean | undefined;

type Unit = {
  readonly spec: ShardSpec;
  readonly executor: Executor;
  readonly port?: number;
  state: UnitState;
  restarts: number;
  lastError?: string;
  stopping: boolean;
  stopPromise?: Promise<void>;
  backoffMs: number;
  restartTimer?: ReturnType<typeof setTimeout>;
  // thread units
  mode?: 'lazy' | 'relay';
  server?: NetServer;
  pending: Socket[];
  worker?: Worker;
  /** The live worker's private port (relay mode only). */
  relayPort?: number;
  // process units
  child?: ChildProcess;
};

function resourceLimitsOf(
  memoryMb: number | undefined
): { maxOldGenerationSizeMb: number; maxYoungGenerationSizeMb: number } | undefined {
  if (memoryMb === undefined) {
    return undefined;
  }
  // RoutePolicy.memoryMb is the old-generation hint; the young generation
  // must still fit inside it, capped at node's own default headroom.
  return { maxOldGenerationSizeMb: memoryMb, maxYoungGenerationSizeMb: Math.min(memoryMb, 64) };
}

function entryOf(unit: Unit): string {
  return unit.executor.kind === 'thread' || unit.executor.kind === 'process'
    ? unit.executor.entry
    : '';
}

function markReady(unit: Unit): void {
  unit.state = 'ready';
  unit.backoffMs = 0;
  unit.lastError = undefined;
}

function closeServer(server: NetServer): Promise<void> {
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      // Already closed or transferred away — nothing to wait for.
      resolve();
    }
  });
}

const bindThreadListener = (unit: Unit): Promise<void> =>
  new Promise((resolve) => {
    const server = createNetServer({ pauseOnConnect: true });
    server.on('connection', (socket) => {
      // Paused on arrival: bytes stay in the kernel until the worker that
      // adopts this socket resumes it — the supervisor never parses HTTP.
      socket.pause();
      if (unit.mode === 'relay' && unit.relayPort !== undefined && unit.worker !== undefined) {
        relayToWorker(unit, socket);
        return;
      }
      unit.pending.push(socket);
      ensureThreadWorker(unit);
    });
    server.on('error', (error: Error) => {
      // Listen failures (EADDRINUSE) self-heal like worker death: markFailed
      // arms the restart timer, whose unit.server===undefined branch rebinds.
      unit.server = undefined;
      markFailed(unit, messageOf(error));
      resolve();
    });
    server.listen(unit.port ?? 0, '127.0.0.1', () => {
      unit.server = server;
      if (!unit.stopping) {
        unit.state = 'spawning';
      }
      resolve();
    });
  });

const ensureThreadWorker = (unit: Unit): void => {
  if (unit.stopping || unit.worker !== undefined || unit.restartTimer !== undefined) {
    return;
  }
  spawnThreadWorker(unit);
};

const spawnThreadWorker = (unit: Unit): void => {
  unit.state = 'spawning';
  // Units spawned after the first hand-off resolved the capability probe:
  // without handle transfer the worker serves a private port we relay to.
  const relay = handleTransferWorks === false;
  if (relay) {
    unit.mode = 'relay';
  }
  const limits = resourceLimitsOf(unit.spec.policy.memoryMb);
  const worker = new Worker(WORKER_BOOTSTRAP, {
    eval: true,
    // Plain-node child: no vitest/tsx preload leaks into the shard realm.
    execArgv: [],
    ...(limits !== undefined ? { resourceLimits: limits } : {}),
    workerData: {
      self: SELF_URL,
      entry: entryOf(unit),
      mode: relay ? 'eager' : 'lazy',
      port: relay ? undefined : unit.port,
    },
  });
  unit.worker = worker;
  worker.on('message', (message: WorkerOut) => onWorkerMessage(unit, worker, message));
  worker.on('error', (error: Error) => {
    unit.lastError = messageOf(error);
  });
  worker.on('exit', (code: number) => onWorkerExit(unit, code));
};

/**
 * The node < 26 delivery path: a dumb byte pipe from an accepted public
 * socket to the worker's private port. The supervisor still never parses
 * HTTP — it moves bytes and propagates errors, nothing else.
 */
function relayToWorker(unit: Unit, socket: Socket): void {
  const port = unit.relayPort;
  if (port === undefined) {
    socket.destroy();
    return;
  }
  socket.resume();
  const conn = connectSocket(port, '127.0.0.1');
  socket.pipe(conn);
  conn.pipe(socket);
  const kill = (): void => {
    socket.destroy();
    conn.destroy();
  };
  socket.on('error', kill);
  conn.on('error', kill);
}

/** Relay adoption — the worker just reported ready on its private port:
 * point this unit's relays at that port, flip the unit ready, and flush
 * every parked socket into the relay. The ready path of relay-mode units
 * and the handle-transfer fallback (node < 26) alike. */
const adoptRelay = (unit: Unit, port: number | undefined, sockets: readonly Socket[]): void => {
  unit.relayPort = port;
  markReady(unit);
  for (const socket of sockets) {
    relayToWorker(unit, socket);
  }
};

const onWorkerMessage = (unit: Unit, worker: Worker, message: WorkerOut): void => {
  if (message.type === 'error') {
    unit.lastError = message.message;
    return;
  }
  if (message.type === 'stopped') {
    return; // the exit event settles stop()
  }
  // 'ready': the worker is serving the port it named. Relay-mode units
  // (and every unit once the capability probe said no) point relays at it;
  // a first transfer-capable worker instead gets the public listener.
  if (unit.mode === 'relay' || handleTransferWorks === false) {
    adoptRelay(unit, message.port, unit.pending.splice(0));
    return;
  }
  const server = unit.server;
  if (server === undefined) {
    return; // stop() closed it, or a rebind is pending — those paths own recovery
  }
  const sockets = unit.pending.splice(0);
  try {
    worker.postMessage({ type: 'serve', server, sockets }, [server, ...sockets]);
    unit.server = undefined; // listening ownership moved into the worker
    handleTransferWorks = true;
    markReady(unit);
  } catch {
    // Handle transfer is unavailable on this runtime (node < 26): the
    // worker that just reported ready keeps serving its private port and
    // every accepted socket — the parked ones included — is relayed to it.
    // Same worker, same lazy spawn: the first request still gets served.
    handleTransferWorks = false;
    unit.mode = 'relay';
    adoptRelay(unit, message.port, sockets);
  }
};

/** One failed-exit path for both unit kinds: bump the restart counter,
 * flip to 'failed', keep the FIRST error of the incident (a later exit
 * during recovery must not overwrite the original cause), double the
 * backoff, then arm the restart — last, so the timer reads the new
 * backoff. */
const markFailed = (unit: Unit, message: string): void => {
  unit.restarts += 1;
  unit.state = 'failed';
  unit.lastError ??= message;
  unit.backoffMs = nextBackoff(unit.backoffMs);
  scheduleRestart(unit);
};

/** Destroys the unit's parked (never-adopted) sockets so their clients
 * fail fast instead of hanging on a socket nobody will ever read — a
 * paused socket attached to the listener would hold close()'s callback
 * open forever. The worker-death path and stop()'s close path alike;
 * relayed sockets die with the worker's exit on their own. */
const destroyParked = (unit: Unit): void => {
  for (const socket of unit.pending.splice(0)) {
    socket.destroy();
  }
};

const onWorkerExit = (unit: Unit, code: number): void => {
  unit.worker = undefined;
  unit.relayPort = undefined;
  if (unit.stopping) {
    return;
  }
  // Sockets still parked here were never adopted (the worker died before
  // or without a hand-off) — destroyParked's exact case.
  destroyParked(unit);
  if (unit.server === undefined) {
    // The dead worker owned the public port (transfer mode); re-bind it
    // immediately so the port answers during the backoff window. The
    // listener's async 'listening' callback runs after markFailed below,
    // so it still sees (and overwrites) the 'failed' state.
    void bindThreadListener(unit);
  }
  markFailed(unit, 'worker exited unexpectedly (code ' + code + ')');
};

const scheduleRestart = (unit: Unit): void => {
  unit.restartTimer = setTimeout(() => {
    unit.restartTimer = undefined;
    if (unit.stopping) {
      return;
    }
    if (unit.executor.kind === 'process') {
      spawnProcessUnit(unit);
      return;
    }
    if (unit.server === undefined) {
      void bindThreadListener(unit); // rebind failed earlier — try again
      return;
    }
    if (unit.pending.length > 0) {
      ensureThreadWorker(unit); // a client is already parked on the port
    } else {
      unit.state = 'spawning'; // armed: the next connection spawns
    }
  }, unit.backoffMs);
};

const spawnProcessUnit = (unit: Unit, onSettled?: () => void): void => {
  unit.state = 'spawning';
  let settled = false;
  const settle = (): void => {
    if (!settled) {
      settled = true;
      onSettled?.();
    }
  };
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    S200_ENTRY: entryOf(unit),
    S200_PORT: String(unit.port ?? 0),
  };
  delete env.S200_RUNNER;
  const child = fork(SELF_PATH, {
    execArgv: [],
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  unit.child = child;
  let stderrTail = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    // Roll the last stderr line across chunk boundaries — a pipe may
    // split one line mid-flight, and the boot-failure diagnostic below
    // should quote it whole — and cap it so a newline-less flood cannot
    // grow the tail unboundedly.
    stderrTail = ((stderrTail + String(chunk)).trimEnd().split('\n').pop() ?? '').slice(-200);
  });
  child.on('message', (message: unknown) => {
    if ((message as { type?: string }).type === 'ready') {
      markReady(unit);
      settle();
    }
  });
  child.on('error', (error: Error) => {
    unit.lastError = messageOf(error);
  });
  child.on('exit', (code: number | null, signal: string | null) => {
    unit.child = undefined;
    if (unit.stopping) {
      return;
    }
    // Release start()'s settle gate first — its continuation runs as a
    // microtask after this handler, so it already observes the 'failed'
    // state markFailed sets synchronously below.
    settle();
    markFailed(
      unit,
      'process exited unexpectedly (code ' +
        String(code) +
        ' signal ' +
        String(signal) +
        ')' +
        (stderrTail !== '' ? ': ' + stderrTail : '')
    );
  });
};

/**
 * The one stop path for both unit kinds: watch for the exit event, issue
 * the polite stop ask (drain message / SIGTERM), and escalate after
 * {@link STOP_GRACE_MS} (terminate / SIGKILL). Resolves on the exit
 * event, or when an awaitable escalation lands — whichever comes first;
 * resolve is idempotent, so the stray second path is a no-op.
 */
const stopWithGrace = (
  listenExit: (onExit: () => void) => void,
  polite: () => void,
  escalate: () => Promise<void> | undefined
): Promise<void> =>
  new Promise<void>((resolve) => {
    const grace = setTimeout(() => {
      void escalate()?.then(() => resolve());
    }, STOP_GRACE_MS);
    listenExit(() => {
      clearTimeout(grace);
      resolve();
    });
    polite();
  });

const stopThreadUnit = async (unit: Unit): Promise<void> => {
  const worker = unit.worker;
  if (worker !== undefined) {
    await stopWithGrace(
      (onExit) => worker.once('exit', onExit),
      () => {
        try {
          worker.postMessage({ type: 'drain' });
        } catch {
          // Already gone — the exit path settles it.
        }
      },
      async () => {
        await worker.terminate();
      }
    );
    unit.worker = undefined;
  }
  // Parked sockets must die before close() — destroyParked's reason: a
  // paused socket attached to the listener would hold the close callback
  // open forever.
  destroyParked(unit);
  if (unit.server !== undefined) {
    await closeServer(unit.server);
    unit.server = undefined;
  }
};

const stopProcessUnit = async (unit: Unit): Promise<void> => {
  const child = unit.child;
  unit.child = undefined;
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await stopWithGrace(
    (onExit) => child.once('exit', onExit),
    () => {
      child.kill('SIGTERM');
    },
    () => {
      // Fire-and-forget: the exit event (imminent after SIGKILL) settles.
      child.kill('SIGKILL');
      return undefined;
    }
  );
};

const stopUnit = (unit: Unit): Promise<void> => {
  // external units are not ours to stop — they keep reporting 'external'.
  if (unit.executor.kind === 'external') {
    return Promise.resolve();
  }
  unit.stopPromise ??= (async (): Promise<void> => {
    unit.stopping = true;
    if (unit.restartTimer !== undefined) {
      clearTimeout(unit.restartTimer);
      unit.restartTimer = undefined;
    }
    if (unit.executor.kind === 'process') {
      await stopProcessUnit(unit);
    } else {
      await stopThreadUnit(unit);
    }
    unit.state = 'stopped';
  })();
  return unit.stopPromise;
};

const statusOf = (unit: Unit): UnitStatus => ({
  id: unit.spec.id,
  state: unit.state,
  port: unit.port,
  restarts: unit.restarts,
  ...(unit.lastError !== undefined ? { lastError: unit.lastError } : {}),
});

/**
 * Builds a {@link Supervisor} over the plans. `start()` binds thread
 * ports (no workers yet — that is the lazy contract) and forks process
 * units; `stop()` drains every owned unit within {@link STOP_GRACE_MS}
 * and force-kills whatever ignores it; `units()` snapshots observability
 * state. Unexpected child exits restart with exponential backoff
 * (100ms doubling, capped at 5s); a stable period resets it.
 */
export function runShards(plans: readonly ShardPlan[]): Supervisor {
  const units = plans.map((plan): Unit => {
    const needsPort = plan.executor.kind === 'thread' || plan.executor.kind === 'process';
    return {
      spec: plan.spec,
      executor: plan.executor,
      port: needsPort ? (plan.port ?? allocatePort()) : plan.port,
      state: 'spawning',
      restarts: 0,
      stopping: false,
      backoffMs: 0,
      pending: [],
    };
  });
  return {
    async start(): Promise<void> {
      for (const unit of units) {
        if (unit.executor.kind === 'inline') {
          unit.state = 'ready';
          continue;
        }
        if (unit.executor.kind === 'external') {
          unit.state = 'external';
          continue;
        }
        if (unit.executor.kind === 'process') {
          // Unlike lazy thread units (whose port is pre-bound, parking
          // early connections), a forked child owns a dead port until it
          // listens — start() must not hand back a supervisor that
          // refuses its first request. Resolve on the child's first
          // 'ready' IPC message, or on an unexpected exit (state
          // 'failed'; the restart loop owns recovery, units() reports).
          await new Promise<void>((resolve) => {
            spawnProcessUnit(unit, resolve);
          });
          continue;
        }
        await bindThreadListener(unit);
      }
    },
    stop(): Promise<void> {
      return Promise.all(units.map(stopUnit)).then(() => undefined);
    },
    units(): readonly UnitStatus[] {
      return units.map(statusOf);
    },
  };
}
