import type { App } from './app';
import type { StaticFileInfo } from './static';

import { realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { handle } from './app';

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
    ) => Response | Promise<Response> | void;
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

export type BunServer = { url: string; port: number; close(): Promise<void> };

export type BunServeOptions = {
  port?: number;
  hostname?: string;
  /**
   * WebSocket bridge: `createBunWebSocketBridge(app)` from
   * `s200/websocket/bun`. `upgrade` is consulted inside the fetch handler —
   * matching requests upgrade instead of hitting the HTTP chain; the
   * `websocket` half carries the per-connection callbacks for Bun.serve.
   */
  websocket?: {
    readonly upgrade: (req: Request, server: BunUpgrader) => boolean;
    readonly websocket: BunWebSocketHandlers;
  };
};

export function serve(app: App, options: BunServeOptions = {}): BunServer {
  const bridge = options.websocket;
  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: options.hostname,
    fetch: (request: Request, upgrader: BunUpgrader) => {
      // A matched WebSocket route upgrades in place — the HTTP chain never
      // runs for it. Otherwise fall through to the normal handler.
      if (bridge !== undefined && bridge.upgrade(request, upgrader)) {
        return;
      }
      // No disconnect wiring: Bun.serve does not reliably abort request.signal on client disconnect.
      return handle(app, request);
    },
    websocket: bridge?.websocket,
  });
  return {
    url: `http://localhost:${server.port}`,
    port: server.port,
    close: async (): Promise<void> => {
      // stop(true) also drops in-flight connections, so close resolves now
      // instead of after every open response finishes.
      await server.stop(true);
    },
  };
}

/**
 * Buffered whole-file reader (the default). With `{ stream: true }`,
 * returns the file as a stream instead — memory-safe for large files, but
 * without `stat` the static layer cannot know sizes for HEAD/ranges.
 */
export function createFileReader(
  root: string,
  options: { stream?: boolean } = {}
): (path: string) => Promise<Uint8Array | ReadableStream<Uint8Array> | null> {
  return async (
    path: string
  ): Promise<Uint8Array | ReadableStream<Uint8Array> | null> => {
    const file = Bun.file(join(root, path));
    if (!(await file.exists())) return null;
    if (options.stream === true) return file.stream();
    return new Uint8Array(await file.arrayBuffer());
  };
}

/**
 * File metadata for {@link serveStatic}'s `stat` injection (ETag/304,
 * content-length for streamed responses).
 */
export function createFileStat(
  root: string
): (path: string) => Promise<StaticFileInfo | null> {
  return async (path: string): Promise<StaticFileInfo | null> => {
    const file = Bun.file(join(root, path));
    if (!(await file.exists())) return null;
    return { size: file.size, mtimeMs: file.lastModified };
  };
}

/**
 * Streamed byte-range reader for {@link serveStatic}'s `readRange`
 * injection: `Bun.file.slice` windows the file without buffering it whole —
 * the memory-safe Range path for large media.
 */
export function createFileRangeReader(
  root: string
): (
  path: string,
  start: number,
  end: number
) => Promise<ReadableStream<Uint8Array> | null> {
  return async (
    path: string,
    start: number,
    end: number
  ): Promise<ReadableStream<Uint8Array> | null> => {
    const file = Bun.file(join(root, path));
    if (!(await file.exists())) return null;
    return file.slice(start, end + 1).stream();
  };
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
 * flavor): identical contract to the node adapter's — `null` for missing
 * files or real paths outside `root`. Resolution is synchronous on this
 * runtime; the async wrapper keeps the injected surface uniform.
 */
export function createRealPathGuard(
  root: string
): (path: string) => Promise<string | null> {
  const resolvedRoot = resolve(root);
  let rootReal: string | null | undefined;
  return async (path: string): Promise<string | null> => {
    rootReal ??= bunRealpath(resolvedRoot);
    if (rootReal === null) return null;
    const real = bunRealpath(join(resolvedRoot, path));
    if (real === null) return null;
    const rel = relative(rootReal, real);
    const within =
      rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel));
    return within ? real : null;
  };
}
