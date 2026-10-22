import type { App } from './app';
import type { StaticFileInfo } from './static';

import { lstatSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { handle } from './app';
import { createRealPathGuardWith } from './fs-containment';
import { hasFinishers, trackFinish } from './finish';
import { signalInit } from './signal';

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
    websocket?: BunWebSocketHandlers;
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

/** The server Bun hands its `fetch` handler — the WebSocket upgrade authority. */
type BunUpgrader = {
  upgrade(request: Request, options?: { data?: unknown }): boolean;
};

/** The `websocket` option Bun.serve accepts (per-connection callbacks).
 * Method syntax keeps the assignments bivariant, so bridges typing `ws`
 * narrowly (see `s200/websocket/bun`) stay assignable. */
type BunWebSocketHandlers = {
  open?(ws: unknown): void;
  message?(ws: unknown, data: string | Uint8Array): void;
  close?(ws: unknown, code: number, reason: string): void;
  drain?(ws: unknown): void;
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
    readonly websocket: BunWebSocketHandlers;
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
      // Bun.serve does not reliably abort request.signal on client
      // disconnect, so the adapter leans on the body stream instead: with
      // onFinish callbacks registered, trackFinish wraps the response body
      // — its cancel (client gone) or completion runs them exactly once.
      // The request's own signal, when this Bun version provides one,
      // still threads into ctx.signal.
      return handle(app, request, signalInit(request)).then((response) =>
        hasFinishers(request) ? trackFinish(request, response, app.logError) : response
      );
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

/** Buffered-whole-file ceiling (16 MiB): files strictly larger stream
 * instead — mirrors the node adapter's default. */
const STREAM_THRESHOLD = 16 * 1024 * 1024;

/**
 * Whole-file reader with safe defaults. Containment first: the resolved
 * real path must stay under `root` (the adapter's own
 * `createRealPathGuard`, on by default — a symlink inside the root
 * pointing elsewhere reads as a miss; `realPath: false` restores the raw
 * filesystem trust). Then no unbounded buffering: files strictly larger
 * than `streamThreshold` (default 16 MiB) stream instead of buffering —
 * pair with `createFileStat`/`createFileRangeReader` so size, validators
 * and ranges ride the injected metadata. With `{ stream: true }`
 * everything streams regardless of size.
 */
export function createFileReader(
  root: string,
  options: {
    readonly stream?: boolean;
    readonly realPath?: boolean;
    readonly streamThreshold?: number;
  } = {}
): (path: string) => Promise<Uint8Array | ReadableStream<Uint8Array> | null> {
  const guard = options.realPath === false ? undefined : createRealPathGuard(root);
  const streamThreshold = options.streamThreshold ?? STREAM_THRESHOLD;
  return async (
    path: string
  ): Promise<Uint8Array | ReadableStream<Uint8Array> | null> => {
    if (guard !== undefined && (await guard(path)) === null) return null;
    const filePath = join(root, path);
    let size: number;
    try {
      const info = statSync(filePath);
      // A directory (also via symlink) would start a response that dies
      // mid-stream — read it as a miss, like the node adapter.
      if (info.isDirectory()) return null;
      size = info.size;
    } catch {
      return null;
    }
    const file = Bun.file(filePath);
    if (options.stream === true || size > streamThreshold) return file.stream();
    return new Uint8Array(await file.arrayBuffer());
  };
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
  const guard = createRealPathGuard(root);
  return async (path: string): Promise<StaticFileInfo | null> => {
    if ((await guard(path)) === null) return null;
    try {
      const info = statSync(join(root, path));
      if (info.isDirectory()) return null;
      return { size: info.size, mtimeMs: info.mtimeMs };
    } catch {
      return null;
    }
  };
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
  const guard = createRealPathGuard(root);
  return async (
    path: string,
    start: number,
    end: number
  ): Promise<ReadableStream<Uint8Array> | null> => {
    if ((await guard(path)) === null) return null;
    const filePath = join(root, path);
    try {
      // A directory (or a symlink to one) would start the 206 and then
      // reset the connection when the slice stream fails — miss instead.
      if (statSync(filePath).isDirectory()) return null;
    } catch {
      return null;
    }
    return Bun.file(filePath).slice(start, end + 1).stream();
  };
}

function bunRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Existence probe for the shared containment guard: only a genuinely
 * absent entry answers `'missing'`; a dangling symlink or an unreadable
 * path counts as existing, so the guard fails closed. */
async function bunExists(path: string): Promise<'exists' | 'missing'> {
  try {
    lstatSync(path);
    return 'exists';
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'exists';
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
    bunExists
  );
}
