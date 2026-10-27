/**
 * Child-realm half of the executor: the code that runs INSIDE a shard.
 * The worker-thread runtime (`runThreadShard`, driven by the embedded
 * `WORKER_BOOTSTRAP` the supervisor evals) and the forked process shim
 * (`runProcessShim`, selected by the `S200_*` sentinel below) both live
 * here; the supervisor that spawns and watches these realms lives in
 * `./executor`.
 *
 * Both child realms load library code from THIS module's URL with a
 * resolve-hook fallback that appends `.ts` to extensionless relative
 * imports — the published layout ships explicit extensions, the repo's
 * source layout does not, and the hook makes both load under plain `node`
 * type stripping with zero bundler help. In the published bundle this
 * module is merged into the `s200/executor` entry chunk, so the URL a
 * child realm re-imports is the entry either way.
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

import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import type { Server as NetServer, Socket } from 'node:net';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import type { MessagePort } from 'node:worker_threads';

import { createServer as createHttpServer } from 'node:http';
import process from 'node:process';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';

// `import.meta.url` survives the ESM bundle, but the CJS output replaces
// `import.meta` with `{}` (its `.url` is undefined — and the eager
// `fileURLToPath(undefined)` below would throw on `require`). In CJS,
// `__filename` is real at runtime and the typeof guard means the ESM
// branch never evaluates; in ESM, `__filename` is an undeclared global
// and `import.meta.url` is preserved. Either format resolves this module.
declare const __filename: string | undefined;

/** Where this module lives — child realms re-import it as their runtime. */
export const SELF_URL: string =
  typeof __filename === 'string'
    ? pathToFileURL(__filename).href
    : import.meta.url;
export const SELF_PATH: string =
  typeof __filename === 'string' ? __filename : fileURLToPath(SELF_URL);

/** Child-side drain deadline: reap idle connections, then force-close. */
const CHILD_DRAIN_MS = 2000;
const REAP_MS = 250;

export function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// Messages child realms send up: readiness handshake (carrying the private
// port the worker is reachable on), drain completion, and fatal boot
// errors (import failure and friends).
export type WorkerOut =
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
export const WORKER_BOOTSTRAP = [
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
    const head: Record<string, string | string[]> = {};
    response.headers.forEach((value, name) => {
      head[name] = value;
    });
    // forEach would collapse repeated set-cookie into one comma-joined
    // value, which is not a legal cookie list — keep them as an array.
    const setCookies = response.headers.getSetCookie();
    if (setCookies.length > 0) head['set-cookie'] = setCookies;
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
