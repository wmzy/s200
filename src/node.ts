import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';

import type { App } from './app';
import type { StaticFileInfo } from './static';

import { once } from 'node:events';
import { constants, createReadStream } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import {
  createSecureServer,
  type Http2SecureServer,
  type Http2ServerRequest,
  type Http2ServerResponse,
  type IncomingHttpHeaders,
} from 'node:http2';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { join } from 'node:path';
import { Readable, type Duplex } from 'node:stream';

import { LightHeaders, LightRequest, LightResponse, setCachedUrl } from './light';

import { handle } from './app';
import { createRealPathGuardWith } from './fs-containment';
import { runFinish } from './finish';


/** Any server the adapter can return: HTTP/1.1, HTTPS, or HTTP/2-over-TLS. */
export type NodeServerKind = HttpServer | HttpsServer | Http2SecureServer;

export type NodeServer = {
  server: NodeServerKind;
  url: string;
  port: number;
  close(): Promise<void>;
};

/** The http server's `'upgrade'` event callback — see `s200/websocket/node`. */
export type NodeUpgradeHandler = (
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer
) => void;

export type NodeHttpsOptions = {
  key: string | Buffer | (string | Buffer)[];
  cert: string | Buffer | (string | Buffer)[];
  ca?: string | Buffer | (string | Buffer)[];
  /** Serve HTTP/2 over TLS instead of HTTP/1.1. Plaintext h2c is not
   * supported — HTTP/2 requires TLS here. HTTP/2 has no `upgrade` event,
   * so this cannot be combined with `NodeServeOptions.upgrade` — WSS
   * needs HTTP/1.1-over-TLS (omit `http2`). */
  http2?: boolean;
};

/**
 * Curated pass-through of `node:http` server knobs — applied at
 * construction on every path (http, https, http2-over-TLS). Only these
 * whitelisted fields travel to the server; nothing else is spread onto
 * node's own constructors.
 */
export type NodeServerTunables = {
  /** Per-request header budget in bytes (node default `16384`). */
  readonly maxHeaderSize?: number;
  /** Whole-request deadline in ms (node default `300_000`; `0` disables). */
  readonly requestTimeout?: number;
  /** Headers-only deadline in ms (node default `60_000`). */
  readonly headersTimeout?: number;
  /** Keep-alive idle window in ms (node default `5_000`). */
  readonly keepAliveTimeout?: number;
  /** Incomplete-request reaping cadence in ms (node default `30_000`). */
  readonly connectionsCheckingInterval?: number;
  /** TCP keep-alive probes on sockets (node default `false`). */
  readonly keepAlive?: boolean;
  /** `socket.setNoDelay` — disable Nagle (node default `true`). */
  readonly noDelay?: boolean;
  /** Per-socket stream buffer size in bytes (node default `16384`). */
  readonly highWaterMark?: number;
};

export type NodeServeOptions = {
  port?: number;
  host?: string;
  /**
   * WebSocket upgrade callback, wired to the server's `'upgrade'` event.
   * Pass `createUpgradeHandler(app)` from `s200/websocket/node` (or wire
   * any protocol library of your choice).
   */
  upgrade?: NodeUpgradeHandler;
  /**
   * Fast path: the adapter constructs light-weight `Request`/`Response`
   * objects (see `docs/benchmarks.md` — the platform constructors' cost is
   * the whole gap to the patched class). Opt-in and per-app: nothing
   * global is patched, handlers still see `Request`/`Response` shapes, and
   * the Web Standard contract stays the default. Caveats: response
   * `clone()` works only for byte-backed bodies, and exotic `BodyInit`
   * shapes (Blob/FormData) pay one real `Response` construction.
   */
  light?: boolean;
  /**
   * Cooperative cancellation: abort `ctx.signal` when the client drops
   * the connection before the response finishes. On by default — each
   * request gets a controller whose signal is both `ctx.signal` and the
   * undici request's `signal`; `res` 'close' with `writableEnded` false
   * aborts it with a DOMException `AbortError`. Pass `false` to opt out:
   * the request then rides the shared never-aborted signal and the
   * per-request `AbortController` is skipped entirely.
   */
  abortOnDisconnect?: boolean;
  /**
   * Serve TLS: `node:https` by default, or `node:http2`'s secure server
   * with `http2: true` — the same dispatch pipeline either way, so
   * handlers and middlewares see no difference. WSS works over plain
   * HTTPS: `https` + `upgrade` is the supported WSS setup (the `upgrade`
   * handler runs on the decrypted connection). Only `http2: true` forbids
   * `upgrade` — HTTP/2 has no `upgrade` event, so that combination
   * throws at `serve` time.
   */
  https?: NodeHttpsOptions;
  /**
   * Curated node server tunables (`maxHeaderSize`, `requestTimeout`,
   * `headersTimeout`, `keepAliveTimeout`, `connectionsCheckingInterval`,
   * `keepAlive`, `noDelay`, `highWaterMark`) — applied at construction on
   * every path. See {@link NodeServerTunables}.
   */
  server?: NodeServerTunables;
  /**
   * Graceful close budget in ms (default `10_000`). `close()` stops
   * accepting, destroys idle keep-alive sockets, and lets in-flight
   * responses finish — resolving as soon as the last one lands. When the
   * budget elapses, whatever is still open is hard-killed
   * (`closeAllConnections()`). `0` restores the hard-kill-immediately
   * semantics: in-flight responses die the moment `close()` is called.
   */
  closeGraceMs?: number;
  /**
   * Replaces node's own `'clientError'` behavior for malformed requests
   * (`(err, socket) => void` — e.g. answer a 400 then destroy). Without
   * it, node's default applies: the offending socket is destroyed.
   */
  clientError?: (err: Error, socket: Duplex) => void;
};

/** The request surface the adapter reads — `node:http` and `node:http2`
 * compatibility APIs both satisfy it. */
type RequestLike = {
  readonly headers: IncomingHttpHeaders;
  readonly rawHeaders: string[];
  readonly method?: string;
  readonly url?: string;
};

/** The response surface the adapter writes — both server kinds provide the
 * HTTP/1-style compat API (`writeHead`/`write`/`end`/`drain`). */
type ResponseLike = {
  writeHead(
    statusCode: number,
    statusMessage: string | undefined,
    headers: Record<string, string | string[]>
  ): unknown;
  write(chunk: Uint8Array): boolean;
  end(): unknown;
  /** 'close' fires on normal completion too — `writableEnded` tells the
   * abort wiring of `abortOnDisconnect` a premature close from a finished
   * response. */
  on(event: 'drain' | 'close', listener: () => void): unknown;
  readonly writableEnded: boolean;
  destroy(): unknown;
};

// "Path does not point at a readable file". Anything else (EACCES, EMFILE,
// ...) still rejects so real failures are not masked as 404s.
const MISSING_FILE_CODES = ['ENOENT', 'ENOTDIR', 'EISDIR'];

export async function serve(
  app: App,
  options: NodeServeOptions = {}
): Promise<NodeServer> {
  if (options.https?.http2 === true && options.upgrade !== undefined) {
    throw new Error(
      'serve: WebSocket upgrade is HTTP/1.1-only — cannot combine it with http2 (HTTP/2 has no upgrade event); use https without http2 for WSS'
    );
  }
  const handler = (req: IncomingMessage | Http2ServerRequest, res: ServerResponse | Http2ServerResponse) => {
    void dispatch(app, req, res, options.light === true, options.abortOnDisconnect !== false);
  };
  // Whitelisted node constructor options — never a blind spread of a
  // foreign options object. Each field is picked explicitly so unknown
  // keys cannot reach node's constructors.
  const tunables: { -readonly [K in keyof NodeServerTunables]: NodeServerTunables[K] } = {};
  const requested = options.server;
  if (requested !== undefined) {
    if (requested.maxHeaderSize !== undefined) tunables.maxHeaderSize = requested.maxHeaderSize;
    if (requested.requestTimeout !== undefined) tunables.requestTimeout = requested.requestTimeout;
    if (requested.headersTimeout !== undefined) tunables.headersTimeout = requested.headersTimeout;
    if (requested.keepAliveTimeout !== undefined) {
      tunables.keepAliveTimeout = requested.keepAliveTimeout;
    }
    if (requested.connectionsCheckingInterval !== undefined) {
      tunables.connectionsCheckingInterval = requested.connectionsCheckingInterval;
    }
    if (requested.keepAlive !== undefined) tunables.keepAlive = requested.keepAlive;
    if (requested.noDelay !== undefined) tunables.noDelay = requested.noDelay;
    if (requested.highWaterMark !== undefined) {
      tunables.highWaterMark = requested.highWaterMark;
    }
  }
  const server: NodeServerKind =
    options.https !== undefined
      ? options.https.http2 === true
        ? // http2's constructor reads its own subset of the whitelist
          // (highWaterMark, ...); node ignores what it does not know.
          createSecureServer({ ...tunables, ...options.https }, handler)
        : createHttpsServer({ ...tunables, ...options.https }, handler)
      : createServer(tunables, handler);
  const upgraded = options.upgrade !== undefined ? new Set<Duplex>() : undefined;
  if (options.upgrade !== undefined) {
    const userUpgrade = options.upgrade;
    const wrappedUpgrade: NodeUpgradeHandler = (req, socket, head) => {
      // Sockets taken over by 'upgrade' (websockets) are detached from the
      // server's connection bookkeeping: neither closeIdleConnections()
      // nor closeAllConnections() reaches them, and server.close()'s
      // callback waits on them — the grace hard-kill needs its own
      // registry to be a real bound.
      upgraded?.add(socket);
      socket.once('close', () => upgraded?.delete(socket));
      userUpgrade(req, socket, head);
    };
    server.on('upgrade', wrappedUpgrade);
  }
  if (options.clientError !== undefined) {
    // Without a listener node's own default applies (the offending
    // socket is destroyed). http2 never emits 'clientError' — wiring it
    // there is inert, not an error.
    server.on('clientError', options.clientError);
  }
  server.listen(options.port ?? 0, options.host);
  // once() also rejects when the server emits 'error' before 'listening'
  // (e.g. EADDRINUSE), so no separate error wiring is needed.
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : (options?.port ?? 0);
  const scheme = options.https !== undefined ? 'https' : 'http';
  const closeGraceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
  return {
    server,
    url: `${scheme}://127.0.0.1:${port}`,
    port,
    close: () => closeServer(server, upgraded, closeGraceMs),
  };
}

/** Graceful-close budget when `closeGraceMs` is omitted. */
const DEFAULT_CLOSE_GRACE_MS = 10_000;

/** Idle-socket reap cadence while draining — the same clamp `s200/lifecycle`
 * uses: fast enough that a response finishing mid-drain does not wait the
 * whole budget for its keep-alive socket to be noticed, slow enough to be
 * free. */
const reapCadenceMs = (graceMs: number): number =>
  Math.max(1, Math.min(250, Math.floor(graceMs / 20)));

function closeServer(
  server: NodeServerKind,
  upgraded: Set<Duplex> | undefined,
  graceMs: number
): Promise<void> {
  // closeAllConnections() cannot reach sockets taken over by 'upgrade'
  // (websockets) — destroy them from the registry. HTTP/2 servers close
  // their sessions via close() — no such method there.
  const hardKill = (): void => {
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    if (upgraded !== undefined) {
      for (const socket of upgraded) {
        socket.destroy();
      }
    }
  };
  // 0 = hard-kill immediately: in-flight responses die.
  if (graceMs <= 0) {
    hardKill();
    return new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  // The node drain pattern shared with s200/lifecycle and the shard
  // executor: stop accepting, destroy idle keep-alive sockets now and
  // whenever they go idle mid-drain, hard-kill on the grace deadline.
  // server.close()'s callback fires once every connection has ended, so
  // the last in-flight response landing resolves the promise early.
  return new Promise((resolve, reject) => {
    let settled = false;
    let reaper: ReturnType<typeof setInterval> | undefined;
    const closeIdle = (): void => {
      (server as { closeIdleConnections?: () => void }).closeIdleConnections?.();
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
      if (error !== undefined && error !== null) {
        reject(error);
      } else {
        resolve();
      }
    };
    const deadline = setTimeout(hardKill, graceMs);
    try {
      server.close((error) => finish(error));
    } catch (error) {
      // A server refusing a second close() is already drained.
      finish(error as Error);
    }
    if (!settled) {
      closeIdle();
      reaper = setInterval(closeIdle, reapCadenceMs(graceMs));
    }
  });
}

async function dispatch(
  app: App,
  req: RequestLike,
  res: ResponseLike,
  light: boolean,
  abortOnDisconnect: boolean
): Promise<void> {
  // The disconnect signal is also the write-side cancellation channel of
  // writeResponse — omitted only under abortOnDisconnect: false.
  const controller = abortOnDisconnect ? new AbortController() : undefined;
  const signal = controller?.signal;
  try {
    const request = toRequest(req, light, signal);
    // 'close' also fires after a normally finished response (keep-alive
    // socket teardown included) — only a premature close aborts and
    // finishes as aborted. The listener stays registered even under
    // abortOnDisconnect: false: onFinish is its own feature, only the
    // signal abort is optional.
    res.on('close', () => {
      if (res.writableEnded) {
        return;
      }
      controller?.abort(new DOMException('client disconnected', 'AbortError'));
      runFinish(request, { aborted: true }, app.logError);
    });
    // handle() maps every error to a Response, so only the socket write can
    // throw below (client gone mid-response) — nothing left to answer.
    const response = await handle(
      app,
      request,
      signal === undefined ? undefined : { signal }
    );
    await writeResponse(res, response, signal);
    runFinish(request, { aborted: false }, app.logError);
  } catch {
    // The write failed mid-flight (or the request never parsed): nothing
    // left to answer. destroy() emits 'close' with writableEnded false, so
    // the listener above finishes as aborted — first trigger wins when a
    // premature 'close' already ran the callbacks.
    res.destroy();
  }
}

/** Host(-like) header characters that are legal inside an `http://`
 * authority: alphanumerics, `.`, `-`, `:` (port), `[`/`]` (IPv6 literals).
 * A crafted Host — `evil.com/a`, `a b`, `u@h`, `x#y`, percent-escapes, or
 * an empty value — must not flow into the request URL: it could pollute
 * the parsed pathname or make the URL unparseable. Anything outside the
 * set falls back to `localhost`. */
const SAFE_HOST = /^[A-Za-z0-9.[\]:-]+$/;

function toRequest(req: RequestLike, light: boolean, signal?: AbortSignal): Request {
  // http2 compat requests expose `:authority` where http1 exposes `host`.
  const authority = (req.headers as Record<string, string | string[] | undefined>)[
    ':authority'
  ];
  const candidate =
    req.headers.host ?? (typeof authority === 'string' ? authority : undefined);
  const host =
    candidate !== undefined && SAFE_HOST.test(candidate) ? candidate : 'localhost';
  const url = `http://${host}${req.url ?? '/'}`;
  const method = req.method ?? 'GET';
  if (light) {
    const request = new LightRequest({
      method,
      url,
      // The flat rawHeaders view is wrapped by reference: LightHeaders
      // builds its slot/index store only on the first structural access,
      // so the hot paths that never read request headers pay nothing for
      // header parsing (pseudo-header dropping happens there too).
      headers: LightHeaders.fromRaw(req.rawHeaders),
      body:
        method !== 'GET' && method !== 'HEAD'
          ? (Readable.toWeb(
              req as unknown as import('node:stream').Readable
            ) as unknown as ReadableStream<Uint8Array>)
          : null,
      signal,
    });
    setCachedUrl(request as unknown as Request, new URL(url));
    return request as unknown as Request;
  }
  // rawHeaders keeps the wire order, so duplicated headers survive as pairs
  // instead of being pre-merged by node's parsed view. http2 compat
  // requests surface ':method'/':path'/... pseudo-headers here too — the
  // Request constructor rejects them as header names, so they are dropped.
  const headerPairs: [string, string][] = [];
  const raw = req.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i];
    const value = raw[i + 1];
    if (name === undefined || value === undefined || name.startsWith(':')) {
      continue;
    }
    headerPairs.push([name, value]);
  }
  const init: RequestInit & { duplex?: 'half' } = {
    method,
    headers: headerPairs,
    redirect: 'manual',
  };
  if (signal !== undefined) {
    // Mirrors the disconnect signal onto request.signal, exactly like a
    // fetch caller's init.signal — undici keeps the very object.
    init.signal = signal;
  }
  if (method !== 'GET' && method !== 'HEAD') {
    // A streaming body needs duplex: 'half'; GET/HEAD must stay bodyless —
    // the platform rejects a request body there. Both server kinds hand
    // out node Readables for the request.
    init.body = Readable.toWeb(
      req as unknown as import('node:stream').Readable
    ) as unknown as ReadableStream;
    init.duplex = 'half';
  }
  const request = new Request(url, init);
  setCachedUrl(request, new URL(url));
  return request;
}

async function writeResponse(
  res: ResponseLike,
  response: Response,
  signal: AbortSignal | undefined
): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  if (
    response instanceof LightResponse &&
    response.headers instanceof LightHeaders
  ) {
    // Direct slot fill — merged values plus the set-cookie array in one
    // loop, skipping the generator + callback machinery of forEach.
    response.headers.fillRecord(headers);
  } else {
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    // forEach would collapse repeated set-cookie into one comma-joined
    // value, which is not a legal cookie list — keep them as an array.
    const setCookies = response.headers.getSetCookie();
    if (setCookies.length > 0) headers['set-cookie'] = setCookies;
  }
  if (response instanceof LightResponse) {
    // Light fast path: byte-backed bodies skip the reader loop entirely —
    // write the bytes straight to the socket.
    const bytes = response.bytesSync();
    if (bytes !== null) {
      res.writeHead(response.status, response.statusText, headers);
      if (!res.write(bytes)) {
        await once(
          res as unknown as import('node:events').EventEmitter,
          'drain',
          signal === undefined ? undefined : { signal }
        );
      }
      res.end();
      return;
    }
    if (response.body === null) {
      res.writeHead(response.status, response.statusText, headers);
      res.end();
      return;
    }
  }
  if (response.body === null) {
    res.writeHead(response.status, response.statusText, headers);
    res.end();
    return;
  }
  // Direct reader loop instead of Readable.fromWeb + pipeline: the
  // stream-to-node-stream conversion costs a real per-request allocation
  // and two event loops — at keep-alive throughput it is measurable
  // (hono's node adapter does the same reader loop). Backpressure is
  // honored through the drain event; a socket death mid-write rejects and
  // dispatch() destroys the response.
  const reader = response.body.getReader();
  // Disconnect propagation (signal = abortOnDisconnect's per-request
  // signal): cancel the reader when the client vanishes — a pending read
  // then resolves {done: true} and the source's cancel runs, so a
  // handler-side generator receives its finally and a stalled body cannot
  // outlive the socket. The drain waits below take the same signal: an
  // abort rejects them instead of hanging on a dead socket. Without a
  // signal (abortOnDisconnect: false) the loop rides plain backpressure.
  const cancelOnAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  if (signal !== undefined) {
    signal.addEventListener('abort', cancelOnAbort, { once: true });
  }
  res.writeHead(response.status, response.statusText, headers);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      // done also follows an abort-driven cancel — res.end() on a closed
      // socket is a tolerated no-op (OutgoingMessage drops writes after
      // destroy), and dispatch's 'close' trigger already finished as
      // aborted.
      res.end();
      signal?.removeEventListener('abort', cancelOnAbort);
      return;
    }
    if (!res.write(value)) {
      await once(
        res as unknown as import('node:events').EventEmitter,
        'drain',
        signal === undefined ? undefined : { signal }
      );
    }
  }
}

/**
 * Brotli encoder for {@link compress} (`s200/compress`): the platform
 * `CompressionStream` has no brotli, `node:zlib` does. Loaded lazily so
 * non-brotli apps never pay the import.
 */
export async function brotliCompress(bytes: Uint8Array): Promise<Uint8Array> {
  const zlib = await import('node:zlib');
  return new Promise<Uint8Array>((resolve, reject) => {
    zlib.brotliCompress(bytes, (error, out) =>
      error === null ? resolve(out) : reject(error)
    );
  });
}

/**
 * Buffered-whole-file ceiling (16 MiB): files strictly larger stream
 * instead, so a huge asset cannot balloon memory by default. The
 * threshold matches `serveStatic`'s streamed path — with `stat` injected
 * the response still carries content-length/validators.
 */
const STREAM_THRESHOLD = 16 * 1024 * 1024;

/**
 * Whole-file reader with safe defaults. Containment first: the resolved
 * real path must stay under `root` (the adapter's own
 * `createRealPathGuard`, on by default — a symlink inside the root
 * pointing elsewhere reads as a miss; `realPath: false` restores the raw
 * filesystem trust). Then no unbounded buffering: the file is stat'ed and
 * anything strictly larger than `streamThreshold` (default 16 MiB) is
 * returned as a web stream instead of a buffered whole file — pair with
 * `createFileStat`/`createFileRangeReader` so size, validators and ranges
 * ride the injected metadata. With `{ stream: true }` everything streams
 * regardless of size. A missing file returns `null` — a createReadStream
 * error would surface mid-response and reset the connection.
 */
export function createFileReader(
  root: string,
  options: {
    readonly stream?: boolean;
    readonly realPath?: boolean;
    readonly streamThreshold?: number;
  } = {}
): (path: string) => Promise<Uint8Array | ReadableStream<Uint8Array> | null> {
  const stream = options.stream === true;
  const guard = options.realPath === false ? undefined : createRealPathGuard(root);
  const streamThreshold = options.streamThreshold ?? STREAM_THRESHOLD;
  return async (
    path: string
  ): Promise<Uint8Array | ReadableStream<Uint8Array> | null> => {
    if (guard !== undefined && (await guard(path)) === null) return null;
    const file = join(root, path);
    if (stream) {
      try {
        await access(file, constants.R_OK);
      } catch {
        return null;
      }
      return Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>;
    }
    // Stat before reading: the size decides buffered vs streamed, and a
    // directory (or a race-deleted path) reads as a plain miss.
    let size: number;
    try {
      const info = await stat(file);
      if (info.isDirectory()) return null;
      size = info.size;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'string' && MISSING_FILE_CODES.includes(code)) {
        return null;
      }
      throw error;
    }
    if (size > streamThreshold) {
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
 * syscall. Lexical `..` checks hold without it, but symlinks inside the
 * root are trusted. {@link createFileReader} applies this guard by
 * default; inject this directly only when composing a custom reader (or
 * adapter surfaces) that cannot go through it.
 */
export function createRealPathGuard(
  root: string
): (path: string) => Promise<string | null> {
  return createRealPathGuardWith(root, (path) =>
    realpath(path).catch(() => null)
  );
}
