import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';

import type { App } from './app';

import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { Readable } from 'node:stream';


import { pipeline } from 'node:stream/promises';

import { handle } from './app';


export type NodeServer = { server: Server; url: string; port: number; close(): Promise<void> };

// "Path does not point at a readable file". Anything else (EACCES, EMFILE,
// ...) still rejects so real failures are not masked as 404s.
const MISSING_FILE_CODES = ['ENOENT', 'ENOTDIR', 'EISDIR'];

export async function serve(
  app: App,
  options?: { port?: number; host?: string }
): Promise<NodeServer> {
  const server = createServer((req, res) => {
    void dispatch(app, req, res);
  });
  server.listen(options?.port ?? 0, options?.host);
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

export function createFileReader(root: string): (path: string) => Promise<Uint8Array | null> {
  return async (path: string): Promise<Uint8Array | null> => {
    try {
      // Buffer is a Uint8Array — returning it directly avoids a copy.
      return await readFile(join(root, path));
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'string' && MISSING_FILE_CODES.includes(code)) return null;
      throw error;
    }
  };
}
