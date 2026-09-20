import type { App } from './app';
import type { StaticFileInfo } from './static';

import { join } from 'node:path';

import { handle } from './app';

// Module-scoped ambient surface of the global Bun runtime — exactly the
// members used, so tsc needs no @types/bun dependency (the real Bun global
// provides them at runtime).
declare const Bun: {
  serve(options: {
    port?: number;
    hostname?: string;
    fetch: (request: Request) => Response | Promise<Response>;
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

export type BunServer = { url: string; port: number; close(): Promise<void> };

export function serve(app: App, options?: { port?: number; hostname?: string }): BunServer {
  const server = Bun.serve({
    port: options?.port ?? 0,
    hostname: options?.hostname,
    fetch: (request: Request): Promise<Response> => handle(app, request),
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
