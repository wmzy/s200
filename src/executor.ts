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
 * - `process` — forks this very module as a shim child; the child detects
 *   the `S200_*` sentinel env vars, imports the user entry, and serves its
 *   own port. Process isolation for shards that must not share a V8 heap.
 * - `external` — already running elsewhere; reported as `state: 'external'`,
 *   never spawned or stopped by us.
 *
 * Both child realms (worker thread and forked process) load library code
 * from THIS module's URL with a resolve-hook fallback that appends `.ts`
 * to extensionless relative imports — the published layout ships explicit
 * extensions, the repo's source layout does not, and the hook makes both
 * load under plain `node` type stripping with zero bundler help.
 *
 * Sentinel environment variables (the process shim's whole handshake):
 * - `S200_ENTRY` — the shard entry module to import (path or file URL);
 *   its `app` / `default` export (or `createApp()` call) must yield the
 *   shard app.
 * - `S200_PORT` — the port the shim serves.
 * - `S200_RUNNER` — set inside any child realm so a forked shim that
 *   itself spawns workers never re-enters the runner branch below.
 *
 * @module
 */

import type { App } from './app';
import type { ShardSpec } from './shard';

import type { ChildProcess } from 'node:child_process';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import type { Server as NetServer, Socket } from 'node:net';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import type { MessagePort } from 'node:worker_threads';

import { fork } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer, connect as connectSocket } from 'node:net';
import process from 'node:process';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

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

// `import.meta.url` survives the ESM bundle, but the CJS output replaces
// `import.meta` with `{}` (its `.url` is undefined — and the eager
// `fileURLToPath(undefined)` below would throw on `require`). In CJS,
// `__filename` is real at runtime and the typeof guard means the ESM
// branch never evaluates; in ESM, `__filename` is an undeclared global
// and `import.meta.url` is preserved. Either format resolves this module.
declare const __filename: string | undefined;

/** Where this module lives — child realms re-import it as their runtime. */
const SELF_URL: string =
  typeof __filename === 'string'
    ? pathToFileURL(__filename).href
    : import.meta.url;
const SELF_PATH: string =
  typeof __filename === 'string' ? __filename : fileURLToPath(SELF_URL);

/** First port handed out when a plan does not name one. */
const DEFAULT_PORT_BASE = 31000;
/** How long stop() waits for a graceful drain before terminating/killing. */
const STOP_GRACE_MS = 3000;
/** Child-side drain deadline: reap idle connections, then force-close. */
const CHILD_DRAIN_MS = 2000;
const REAP_MS = 250;
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

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function nextBackoff(current: number): number {
  return current === 0 ? RESTART_BACKOFF_BASE_MS : Math.min(current * 2, RESTART_BACKOFF_MAX_MS);
}

// Messages child realms send up: readiness handshake (carrying the private
// port the worker is reachable on), drain completion, and fatal boot
// errors (import failure and friends).
type WorkerOut =
  | { readonly type: 'ready'; readonly port?: number }
  | { readonly type: 'stopped' }
  | { readonly type: 'error'; readonly message: string };

// Messages the thread supervisor sends down. `serve` is the ≥ 26 lazy
// hand-off: the pre-bound listening server plus every paused socket,
// transferred in one shot. Runtimes without handle transfer never see it —
// their connections are relayed to the worker's private port instead.
type WorkerIn =
  | { readonly type: 'serve'; readonly server: NetServer; readonly sockets: readonly Socket[] }
  | { readonly type: 'drain' };

// Resolved by the first thread hand-off and memoized process-wide: worker
// thread handle transfer (net.Server/net.Socket in postMessage's transfer
// list) only exists from node 26 (nodejs/node#64225) — older runtimes,
// node 20/22/24 included, throw DataCloneError and take the relay path.
let handleTransferWorks: boolean | undefined;

/**
 * Worker-thread launch data. `lazy`: bind a private ephemeral port and
 * report it with `ready` — the supervisor then either transfers the public
 * listener over (`serve`) or relays connections to the private port.
 * `eager`: serve `port` (ephemeral when omitted) directly.
 */
export type WorkerLaunch = {
  readonly mode?: 'lazy' | 'eager';
  readonly port?: number;
};

/**
 * The whole worker-thread bootstrap, embedded as source so the library
 * ships as one file with no runtime assets. It runs as CommonJS in an
 * eval'd worker: flags this realm as a runner (so a forked shim spawning
 * workers never re-enters the runner branch), re-imports THIS module by
 * URL, and delegates — every line of real logic stays typed library code.
 */
const WORKER_BOOTSTRAP = [
  "const wt = require('node:worker_threads');",
  "process.env.S200_RUNNER = '1';",
  'import(wt.workerData.self)',
  '  .then((self) => self.runThreadShard(wt.workerData.entry, wt.parentPort, wt.workerData))',
  '  .catch((error) => {',
  "    try { wt.parentPort.postMessage({ type: 'error', message: String((error && error.stack) || error) }); } catch (ignored) {}",
  '    process.exit(1);',
  '  });',
].join('\n');

/**
 * Installs (once per realm) a synchronous resolve hook that retries failed
 * extensionless relative imports with a `.ts` suffix. Why: child realms
 * load this module from the repo's source layout, where `import('./app')`
 * has no explicit extension and plain-node ESM resolution rejects it —
 * published/bundled layouts already carry extensions and never hit the
 * fallback. No-op where `module.registerHooks` does not exist.
 */
// Once-per-realm memo: the hook must be registered exactly once, before
// the first relative import of any child realm.
let resolutionDone: Promise<void> | undefined;

export async function installShardResolution(): Promise<void> {
  resolutionDone ??= (async (): Promise<void> => {
    try {
      const nodeModule = (await import('node:module')) as {
        registerHooks?: (hooks: {
          resolve(
            specifier: string,
            context: unknown,
            nextResolve: (specifier: string, context?: unknown) => unknown
          ): unknown;
        }) => unknown;
      };
      const register = nodeModule.registerHooks;
      if (register === undefined) {
        return;
      }
      register({
        resolve: (specifier, context, nextResolve) => {
          try {
            return nextResolve(specifier, context);
          } catch {
            return nextResolve(specifier + '.ts', context);
          }
        },
      });
    } catch {
      // Older runtimes without sync hooks: explicit-extension layouts
      // (the published package) still load fine without the fallback.
    }
  })();
  return resolutionDone;
}

// The core dispatcher, loaded lazily so this module evaluates under plain
// node (as a forked shim main) without touching relative imports at link
// time — the resolve fallback must be installed first in child realms.
let core: Promise<typeof import('./app')> | undefined;

function loadCore(): Promise<typeof import('./app')> {
  core ??= import('./app');
  return core;
}

/**
 * Resolves the shard app from a user entry: `app` export, then `default`,
 * then calling `createApp()` — the contract every executor realm uses.
 */
export async function appFromEntry(entry: string): Promise<App> {
  const mod = (await import(entry)) as {
    app?: unknown;
    default?: unknown;
    createApp?: () => unknown;
  };
  const candidate =
    mod.app ?? mod.default ?? (typeof mod.createApp === 'function' ? await mod.createApp() : undefined);
  if (candidate === undefined || candidate === null) {
    throw new Error('shard entry exports no app (app, default, or createApp): ' + entry);
  }
  return candidate as App;
}

/**
 * Minimal node-http bridge for child realms: web-standard `Request` in,
 * s200 `handle` dispatch, `Response` back out. `s200/node`'s full adapter
 * (light mode, static files, upgrades) cannot be reused here because the
 * child loads library code by URL under type stripping, so this carries
 * exactly what a shard's own routes need — headers, body streaming, and
 * backpressure — and nothing else.
 */
export function createShardServer(app: App): HttpServer {
  return createHttpServer((req, res) => {
    void serveShardRequest(app, req, res);
  });
}

async function serveShardRequest(app: App, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const { handle } = await loadCore();
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) {
        continue;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          headers.append(name, item);
        }
      } else {
        headers.set(name, value);
      }
    }
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const url = 'http://127.0.0.1:' + String(req.socket.localPort ?? 0) + (req.url ?? '/');
    const request = new Request(url, {
      method: req.method,
      headers,
      ...(hasBody
        ? {
            body: Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>,
            duplex: 'half' as const,
          }
        : {}),
    });
    const response = await handle(app, request);
    const head: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      head[name] = value;
    });
    res.writeHead(response.status, head);
    if (response.body === null) {
      res.end();
      return;
    }
    for await (const chunk of Readable.fromWeb(response.body as unknown as NodeWebReadableStream)) {
      if (!res.write(chunk)) {
        await once(res, 'drain');
      }
    }
    res.end();
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
    }
    res.end(JSON.stringify({ error: 'shard executor failed to serve', detail: messageOf(error) }));
  }
}

/**
 * Graceful drain for a child-realm http server: stop accepting, reap
 * keep-alive sockets that go idle mid-drain (undici leaves them parked),
 * force-close at {@link CHILD_DRAIN_MS}, then hand control back.
 */
function drainServer(server: HttpServer, done: () => void): void {
  let settled = false;
  const reaper = setInterval(() => server.closeIdleConnections?.(), REAP_MS);
  const deadline = setTimeout(() => server.closeAllConnections?.(), CHILD_DRAIN_MS);
  const finish = (): void => {
    if (settled) {
      return;
    }
    settled = true;
    clearInterval(reaper);
    clearTimeout(deadline);
    done();
  };
  server.closeIdleConnections?.();
  try {
    server.close(() => finish());
  } catch {
    // A server refusing a second close() is already drained.
    finish();
  }
}

/**
 * Thread-shard runtime (called from the embedded bootstrap with this
 * module re-imported inside the worker). Both modes bind a port up front
 * and report it with `ready`: lazy mode takes a PRIVATE ephemeral port so
 * the supervisor can either hand the public listener over (`serve`, node
 * ≥ 26: new connections then arrive directly in this worker, exactly how
 * cluster hands adopted sockets to a child) or relay connections to the
 * private port (older runtimes); eager mode serves `port` itself.
 */
export async function startShardWorker(
  app: App,
  parentPort: MessagePort,
  data: WorkerLaunch
): Promise<void> {
  await installShardResolution();
  const httpServer = createShardServer(app);
  const post = (message: WorkerOut): void => {
    try {
      parentPort.postMessage(message);
    } catch {
      // Parent gone (stop() racing us) — the exit path settles it.
    }
  };
  let drained = false;
  const drain = (): void => {
    if (drained) {
      return;
    }
    drained = true;
    drainServer(httpServer, () => {
      post({ type: 'stopped' });
      setImmediate(() => process.exit(0));
    });
  };
  httpServer.listen(data.mode === 'eager' ? (data.port ?? 0) : 0, '127.0.0.1', () => {
    const address = httpServer.address();
    post({ type: 'ready', port: typeof address === 'object' ? address?.port : undefined });
  });
  parentPort.on('message', (raw: unknown) => {
    const message = raw as WorkerIn;
    if (message.type === 'serve') {
      const netServer = message.server;
      // The adopted listener keeps the supervisor's pauseOnConnect flag —
      // every socket it hands us arrives paused, so resume them all.
      netServer.on('connection', (socket) => {
        httpServer.emit('connection', socket);
        socket.resume();
      });
      // The public listener supersedes the private one — stop accepting
      // on it; established private connections (relay mode races aside,
      // there are none in transfer mode) keep flowing.
      httpServer.close(() => undefined);
      for (const socket of message.sockets) {
        httpServer.emit('connection', socket);
        socket.resume();
      }
    } else if (message.type === 'drain') {
      drain();
    }
  });
}

/** Entry point the eval'd worker bootstrap calls (see {@link WORKER_BOOTSTRAP}). */
export async function runThreadShard(
  entry: string,
  parentPort: MessagePort,
  data: WorkerLaunch
): Promise<void> {
  await installShardResolution();
  const app = await appFromEntry(entry);
  await startShardWorker(app, parentPort, data);
}

/**
 * Process-shim main: runs when this module is forked with `S200_ENTRY`
 * set (see `runShards`), which is how the shim ships inside the library
 * without a second file. Serves `S200_PORT`, drains on SIGTERM or a drain
 * message, exits 0 when the last connection settles.
 */
async function runProcessShim(): Promise<void> {
  process.env.S200_RUNNER = '1';
  await installShardResolution();
  const app = await appFromEntry(process.env.S200_ENTRY ?? '');
  const server = createShardServer(app);
  server.listen(Number(process.env.S200_PORT ?? '0'), '127.0.0.1', () => {
    process.send?.({ type: 'ready' });
  });
  let drained = false;
  const drain = (): void => {
    if (drained) {
      return;
    }
    drained = true;
    drainServer(server, () => process.exit(0));
  };
  process.on('SIGTERM', drain);
  process.on('message', (message: unknown) => {
    if ((message as { type?: string }).type === 'drain') {
      drain();
    }
  });
}

// The fork detection itself: only a child spawned by runShards carries
// S200_ENTRY without S200_RUNNER. Every other import of this module —
// vitest, a bundler, an app — has neither, so this stays inert.
if (process.env.S200_ENTRY !== undefined && process.env.S200_RUNNER === undefined) {
  void runProcessShim().catch((error: unknown) => {
    process.stderr.write('s200 executor runner failed: ' + messageOf(error) + '\n');
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// Supervisor side
// ---------------------------------------------------------------------------

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
      unit.server = undefined;
      unit.state = 'failed';
      unit.lastError = messageOf(error);
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
    unit.relayPort = message.port;
    markReady(unit);
    for (const socket of unit.pending.splice(0)) {
      relayToWorker(unit, socket);
    }
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
    unit.relayPort = message.port;
    markReady(unit);
    for (const socket of sockets) {
      relayToWorker(unit, socket);
    }
  }
};

const onWorkerExit = (unit: Unit, code: number): void => {
  unit.worker = undefined;
  unit.relayPort = undefined;
  if (unit.stopping) {
    return;
  }
  unit.restarts += 1;
  unit.state = 'failed';
  unit.lastError ??= 'worker exited unexpectedly (code ' + code + ')';
  unit.backoffMs = nextBackoff(unit.backoffMs);
  // Sockets still parked here were never adopted (the worker died before
  // or without a hand-off) — destroy them so their clients fail fast
  // instead of hanging on a socket nobody will ever read. Relayed sockets
  // die with the worker's exit on their own.
  for (const socket of unit.pending.splice(0)) {
    socket.destroy();
  }
  if (unit.server === undefined) {
    // The dead worker owned the public port (transfer mode); re-bind it
    // immediately so the port answers during the backoff window.
    void bindThreadListener(unit);
  }
  scheduleRestart(unit);
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
    const lines = String(chunk).trim().split('\n');
    stderrTail = lines[lines.length - 1] ?? stderrTail;
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
    unit.restarts += 1;
    unit.state = 'failed';
    unit.lastError ??=
      'process exited unexpectedly (code ' + String(code) + ' signal ' + String(signal) + ')' +
      (stderrTail !== '' ? ': ' + stderrTail : '');
    unit.backoffMs = nextBackoff(unit.backoffMs);
    settle();
    scheduleRestart(unit);
  });
};

const stopThreadUnit = async (unit: Unit): Promise<void> => {
  const worker = unit.worker;
  if (worker !== undefined) {
    try {
      worker.postMessage({ type: 'drain' });
    } catch {
      // Already gone — the exit path settles it.
    }
    await new Promise<void>((resolve) => {
      const grace = setTimeout(() => {
        void worker.terminate().then(() => resolve());
      }, STOP_GRACE_MS);
      worker.once('exit', () => {
        clearTimeout(grace);
        resolve();
      });
    });
    unit.worker = undefined;
  }
  // Parked sockets must die before close(): a paused socket attached to
  // the listener would hold the close callback open forever.
  for (const socket of unit.pending.splice(0)) {
    socket.destroy();
  }
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
  await new Promise<void>((resolve) => {
    const grace = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
    child.once('exit', () => {
      clearTimeout(grace);
      resolve();
    });
    child.kill('SIGTERM');
  });
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
