import type { App } from './app';
import type { StaticFileInfo } from './static';

import type { BunUpgrader, BunWsHandlers } from './websocket-bun';

import { lstatSync, realpathSync, statSync } from 'node:fs';

import {
  createFileRangeReaderWith,
  createFileReaderWith,
  createFileStatWith,
  createRealPathGuardWith,
  existsWith,
  missOrNull,
  type FileIo,
} from './fs-containment';
import { edgeFetch } from './finish';


// Bun's upgrade authority and per-connection callbacks are declared once,
// in the bridge module (`s200/websocket/bun`) — the shape both halves
// actually use, including the `headers` the bridge passes on upgrade. The
// import above is type-only: erased at runtime, so this adapter still
// needs no @types/bun dependency.

// Module-scoped ambient surface of the global Bun runtime — exactly the
// members used, so tsc needs no @types/bun dependency (the real Bun global
// provides them at runtime).
declare const Bun: {
  serve(options: {
    port?: number;
    hostname?: string;
    fetch: (
      request: Request,
      server: BunUpgrader
    ) => Response | Promise<Response | undefined> | undefined;
    websocket?: BunWsHandlers;
  }): { port: number; stop: (closeActiveConnections?: boolean) => void | Promise<void> };
  file(path: string): {
    exists(): Promise<boolean>;
    arrayBuffer(): Promise<ArrayBuffer>;
    stream(): ReadableStream<Uint8Array>;
    slice(start: number, end: number): { stream(): ReadableStream<Uint8Array> };
    readonly size: number;
    readonly lastModified: number;
  };
};

/**
 * The subset of Bun's served-server handle s200 types: `stop(false)` waits
 * for in-flight requests, `stop()` (or `stop(true)`) force-closes. Exposed
 * so `s200/lifecycle`'s duck-typed graceful drain can reach the runtime
 * path — the adapter's own `close()` is the immediate stop.
 */
export type BunServedServer = {
  readonly stop: (closeActiveConnections?: boolean) => void;
};

export type BunServer = {
  url: string;
  port: number;
  close(): Promise<void>;
  /** The raw `Bun.serve` handle — the graceful-stop surface. */
  server: BunServedServer;
};

export type BunServeOptions = {
  port?: number;
  hostname?: string;
  /**
   * WebSocket bridge: `createBunWebSocketBridge(app)` from
   * `s200/websocket/bun`. `upgrade` is consulted inside the fetch handler —
   * matching requests upgrade once the middleware chain approves (a
   * rejecting middleware's `Response` is answered as plain HTTP) instead
   * of hitting the HTTP chain; the `websocket` half carries the
   * per-connection callbacks for Bun.serve.
   */
  websocket?: {
    readonly upgrade: (
      req: Request,
      server: BunUpgrader
    ) => boolean | Response | Promise<boolean | Response>;
    readonly websocket: BunWsHandlers;
  };
};

export function serve(app: App, options: BunServeOptions = {}): BunServer {
  const bridge = options.websocket;
  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: options.hostname,
    fetch: async (request: Request, upgrader: BunUpgrader) => {
      // A matched WebSocket route upgrades in place once the middleware
      // chain approves — the HTTP chain never runs for it. A rejecting
      // middleware's Response is answered as plain HTTP instead; anything
      // else falls through to the normal handler.
      if (bridge !== undefined) {
        const decided = await bridge.upgrade(request, upgrader);
        if (decided === true) {
          // `undefined` (not a bare `return;`) keeps the handler's inferred
          // return inside Bun.serve's Response | Promise<Response | undefined>.
          return undefined;
        }
        if (decided !== false) {
          return decided;
        }
      }
      // The shared edge composition (finish.ts's edgeFetch). Bun.serve
      // does not reliably abort request.signal on client disconnect, so
      // the adapter leans on the body stream instead: with onFinish
      // callbacks registered, trackFinish wraps the response body — its
      // cancel (client gone) or completion runs them exactly once. The
      // request's own signal, when this Bun version provides one, still
      // threads into ctx.signal.
      return edgeFetch(app, request);
    },
    websocket: bridge?.websocket,
  });
  return {
    url: `http://localhost:${server.port}`,
    port: server.port,
    server,
    close: async (): Promise<void> => {
      // stop(true) also drops in-flight connections, so close resolves now
      // instead of after every open response finishes.
      await server.stop(true);
    },
  };
}

/**
 * The Bun flavor of the shared file-service primitives
 * (fs-containment's `FileIo`): sync stat + `Bun.file` bytes/windows. The
 * always-stream precheck runs the shared stat policy — a directory reads
 * as a miss, everything but a genuine miss (`MISSING_FILE_CODES`) throws
 * — then the file streams.
 */
const bunFileIo: FileIo = {
  stat: async (file) => statSync(file),
  readAll: async (file) => new Uint8Array(await Bun.file(file).arrayBuffer()),
  createStream: async (file) => {
    try {
      if (statSync(file).isDirectory()) return null;
    } catch (error) {
      return missOrNull(error);
    }
    return Bun.file(file).stream();
  },
  createStreamUnchecked: (file) => Bun.file(file).stream(),
  createRangeStream: (file, start, end) =>
    Bun.file(file).slice(start, end + 1).stream(),
  createGuard: createRealPathGuard,
};

/**
 * Whole-file reader with safe defaults. Containment first: the resolved
 * real path must stay under `root` (the adapter's own
 * `createRealPathGuard`, on by default — a symlink inside the root
 * pointing elsewhere reads as a miss; `realPath: false` restores the raw
 * filesystem trust). Then no unbounded buffering: files strictly larger
 * than `streamThreshold` (default 16 MiB) stream instead of buffering —
 * pair with `createFileStat`/`createFileRangeReader` so size, validators
 * and ranges ride the injected metadata. With `{ stream: true }` everything
 * streams regardless of size.
 */
export function createFileReader(
  root: string,
  options: {
    readonly stream?: boolean;
    readonly realPath?: boolean;
    readonly streamThreshold?: number;
  } = {}
): (path: string) => Promise<Uint8Array | ReadableStream<Uint8Array> | null> {
  return createFileReaderWith(root, bunFileIo, options);
}

/**
 * File metadata for {@link serveStatic}'s `stat` injection (ETag/304,
 * content-length for streamed responses). Containment and the directory
 * check match {@link createFileReader}: an escaping symlink or a directory
 * reads as missing, so the `Range` path cannot stat its way around the
 * guard.
 */
export function createFileStat(
  root: string
): (path: string) => Promise<StaticFileInfo | null> {
  return createFileStatWith(root, bunFileIo);
}

/**
 * Streamed byte-range reader for {@link serveStatic}'s `readRange`
 * injection: `Bun.file.slice` windows the file without buffering it whole —
 * the memory-safe Range path for large media. Containment and the directory
 * check match {@link createFileReader}: an escaping symlink or a directory
 * reads as missing instead of starting a `206` that then dies mid-stream.
 */
export function createFileRangeReader(
  root: string
): (
  path: string,
  start: number,
  end: number
) => Promise<ReadableStream<Uint8Array> | null> {
  return createFileRangeReaderWith(root, bunFileIo);
}

function bunRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Symlink escape guard for {@link serveStatic}'s `realPath` injection (Bun
 * flavor): identical contract to the node adapter's, because both delegate
 * to the shared `fs-containment` algorithm. It resolves the real path when
 * the entry exists under `root`, returns `null` when it escapes, and
 * reports a missing entry by its resolved (nonexistent) path so
 * `serveStatic`'s SPA fallback still runs — a miss is not an escape.
 * Resolution is synchronous on this runtime; the async wrapper keeps the
 * injected surface uniform. {@link createFileReader},
 * {@link createFileStat} and {@link createFileRangeReader} apply this
 * guard by default.
 */
export function createRealPathGuard(
  root: string
): (path: string) => Promise<string | null> {
  return createRealPathGuardWith(
    root,
    async (path) => bunRealpath(path),
    existsWith(async (path) => lstatSync(path))
  );
}
