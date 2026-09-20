import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';

import type { App } from './app';
import type { StaticFileInfo } from './static';

import { once } from 'node:events';
import { constants, createReadStream } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Readable, type Duplex } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { handle } from './app';


export type NodeServer = { server: Server; url: string; port: number; close(): Promise<void> };

/** The http server's `'upgrade'` event callback — see `s200/websocket/node`. */
export type NodeUpgradeHandler = (
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer
) => void;

export type NodeServeOptions = {
  port?: number;
  host?: string;
  /**
   * WebSocket upgrade callback, wired to the server's `'upgrade'` event.
   * Pass `createUpgradeHandler(app)` from `s200/websocket/node` (or wire
   * any protocol library of your choice).
   */
  upgrade?: NodeUpgradeHandler;
};

// "Path does not point at a readable file". Anything else (EACCES, EMFILE,
// ...) still rejects so real failures are not masked as 404s.
const MISSING_FILE_CODES = ['ENOENT', 'ENOTDIR', 'EISDIR'];

export async function serve(
  app: App,
  options: NodeServeOptions = {}
): Promise<NodeServer> {
  const server = createServer((req, res) => {
    void dispatch(app, req, res);
  });
  if (options.upgrade !== undefined) {
    server.on('upgrade', options.upgrade);
  }
  server.listen(options.port ?? 0, options.host);
  // once() also rejects when the server emits 'error' before 'listening'
  // (e.g. EADDRINUSE), so no separate error wiring is needed.
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : (options?.port ?? 0);
  return { server, url: `http://127.0.0.1:${port}`, port, close: () => closeServer(server) };
}

function closeServer(server: Server): Promise<void> {
  // closeAllConnections() first: idle keep-alive sockets would otherwise hold
  // server.close()'s callback open until their own timeout fires.
  server.closeAllConnections?.();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function dispatch(app: App, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    // handle() maps every error to a Response, so only the socket write can
    // throw here (client gone mid-response) — nothing left to answer.
    const response = await handle(app, toRequest(req));
    await writeResponse(res, response);
  } catch {
    res.destroy();
  }
}

function toRequest(req: IncomingMessage): Request {
  const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;
  const headerPairs: [string, string][] = [];
  // rawHeaders keeps the wire order, so duplicated headers survive as pairs
  // instead of being pre-merged by node's parsed view.
  const raw = req.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i];
    const value = raw[i + 1];
    if (name !== undefined && value !== undefined) headerPairs.push([name, value]);
  }
  const method = req.method ?? 'GET';
  const init: RequestInit & { duplex?: 'half' } = {
    method,
    headers: headerPairs,
    redirect: 'manual',
  };
  if (method !== 'GET' && method !== 'HEAD') {
    // A streaming body needs duplex: 'half'; GET/HEAD must stay bodyless —
    // the platform rejects a request body there.
    init.body = Readable.toWeb(req) as unknown as ReadableStream;
    init.duplex = 'half';
  }
  return new Request(url, init);
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  // forEach would collapse repeated set-cookie into one comma-joined value,
  // which is not a legal cookie list — keep them as an array.
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length > 0) headers['set-cookie'] = setCookies;
  res.writeHead(response.status, response.statusText, headers);
  if (response.body === null) {
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(response.body as unknown as NodeWebReadableStream<Uint8Array>), res);
}

/**
 * Buffered whole-file reader (the default — Buffer is a Uint8Array, so
 * returning it directly avoids a copy). With `{ stream: true }`, returns a
 * web stream instead: memory-safe for large files, but without `stat` the
 * static layer cannot know sizes for HEAD/ranges. A missing file returns
 * `null` after an existence check — a createReadStream error would surface
 * mid-response and reset the connection.
 */
export function createFileReader(
  root: string,
  options: { stream?: boolean } = {}
): (path: string) => Promise<Uint8Array | ReadableStream<Uint8Array> | null> {
  const stream = options.stream === true;
  return async (
    path: string
  ): Promise<Uint8Array | ReadableStream<Uint8Array> | null> => {
    const file = join(root, path);
    if (stream) {
      try {
        await access(file, constants.R_OK);
      } catch {
        return null;
      }
      return Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>;
    }
    try {
      return await readFile(file);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'string' && MISSING_FILE_CODES.includes(code)) {
        return null;
      }
      throw error;
    }
  };
}

/**
 * File metadata for {@link serveStatic}'s `stat` injection: size + mtimeMs
 * (powers ETag/Last-Modified/304 and content-length for streamed
 * responses). Directories read as missing — the static layer handles them
 * via its directory-index/redirect logic instead.
 */
export function createFileStat(
  root: string
): (path: string) => Promise<StaticFileInfo | null> {
  return async (path: string): Promise<StaticFileInfo | null> => {
    try {
      const info = await stat(join(root, path));
      if (info.isDirectory()) {
        return null;
      }
      return { size: info.size, mtimeMs: info.mtimeMs };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'string' && MISSING_FILE_CODES.includes(code)) {
        return null;
      }
      throw error;
    }
  };
}

/**
 * Streamed byte-range reader for {@link serveStatic}'s `readRange`
 * injection: `createReadStream` slices `[start, end]` without buffering the
 * whole file — the memory-safe Range path for large media.
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
    const file = join(root, path);
    try {
      await access(file, constants.R_OK);
    } catch {
      return null;
    }
    return Readable.toWeb(
      createReadStream(file, { start, end })
    ) as ReadableStream<Uint8Array>;
  };
}

/**
 * Symlink escape guard for {@link serveStatic}'s `realPath` injection:
 * resolves the file's real path and returns `null` whenever it does not
 * exist or lands outside `root` — so a symlink inside the root pointing
 * elsewhere falls through instead of being served. The root's own real
 * path is resolved once and cached; each request still costs one realpath
 * syscall (the guard is opt-in). Lexical `..` checks hold without it, but
 * symlinks inside the root are trusted.
 */
export function createRealPathGuard(
  root: string
): (path: string) => Promise<string | null> {
  const resolvedRoot = resolve(root);
  let realRoot: Promise<string | null> | undefined;
  const getRealRoot = (): Promise<string | null> => {
    realRoot ??= realpath(resolvedRoot).catch(() => null);
    return realRoot;
  };
  return async (path: string): Promise<string | null> => {
    const rootReal = await getRealRoot();
    if (rootReal === null) return null;
    let real: string;
    try {
      real = await realpath(join(resolvedRoot, path));
    } catch {
      return null; // missing files fall through like an ordinary miss
    }
    // relative(rootReal, real) climbs with '..'/'../…' exactly; a sibling
    // name like '..x' cannot climb and stays a legitimate in-root file.
    const rel = relative(rootReal, real);
    const within =
      rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel));
    return within ? real : null;
  };
}
