/**
 * Response compression middleware over the Web Standard
 * `CompressionStream` — zero dependencies and every supported runtime
 * (Node 18+, Bun, Deno, workers) provides it. gzip/deflate stream the body;
 * brotli is opt-in via an injected encoder (Node's CompressionStream has no
 * brotli — the node adapter ships one, see `brotliCompress` in `s200/node`).
 *
 * @module
 */

import type { Ctx, Middleware } from './types';

import { LightResponse } from './light';
import { newResponse } from './respond';

export type CompressOptions = {
  /**
   * Minimum uncompressed size in bytes before a response is compressed;
   * default 1024. Only consulted when the response carries a
   * content-length — streamed responses (no length) compress regardless,
   * like a proxy would.
   */
  readonly minBytes?: number;
  /**
   * Brotli encoder — the platform `CompressionStream` has no brotli, so
   * `br` is only negotiated when one is injected. Brotli is a buffered
   * path: it applies to byte-backed responses only (a declared
   * content-length); streamed responses fall back to gzip/deflate.
   */
  readonly brotli?: {
    readonly compress: (bytes: Uint8Array) => Promise<Uint8Array>;
  };
};

const DEFAULT_MIN_BYTES = 1024;

/**
 * Picks the best supported encoding from Accept-Encoding. Returns undefined
 * when nothing acceptable is offered. gzip wins ties; `*` counts as gzip;
 * q=0 (or q=0.0) disqualifies; `br` is only offered when `brotli` is
 * injected (and loses ties to gzip for spec simplicity).
 */
function pickEncoding(
  header: string,
  brotli: boolean
): 'gzip' | 'deflate' | 'br' | undefined {
  let gzip = 0;
  let deflate = 0;
  let br = 0;
  let star = 0;
  for (const part of header.split(',')) {
    const [rawName, ...params] = part.trim().split(';');
    const name = (rawName ?? '').trim().toLowerCase();
    let q = 1;
    for (const param of params) {
      const eq = param.indexOf('=');
      if (eq < 0) continue;
      const key = param.slice(0, eq).trim().toLowerCase();
      if (key !== 'q') continue;
      const value = Number(param.slice(eq + 1).trim());
      if (!Number.isNaN(value)) q = value;
    }
    if (q <= 0) continue;
    if (name === 'gzip') gzip = q;
    else if (name === 'deflate') deflate = q;
    else if (name === 'br') br = q;
    else if (name === '*') star = q;
  }
  if (gzip > 0) return 'gzip';
  if (deflate > 0) return 'deflate';
  if (brotli && br > 0) return 'br';
  if (star > 0) return 'gzip';
  return undefined;
}

/** Appends a value to the Vary header without duplicating it. */
function withVary(headers: Headers, value: string): void {
  const vary = headers.get('vary');
  if (vary === null) {
    headers.set('vary', value);
    return;
  }
  if (!vary.split(',').some((entry) => entry.trim().toLowerCase() === value)) {
    headers.set('vary', `${vary}, ${value}`);
  }
}

/** Collects a stream into one buffer — a single chunk (the common small
 * response) is returned without a copy. */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  const single = chunks.length === 1 ? chunks[0] : undefined;
  if (single !== undefined) return single;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** One-shot compression of buffered bytes through the platform
 * `CompressionStream` — the light write path wants bytes, not a stream,
 * so the rebuilt response stays byte-backed and the node adapter can
 * write it straight to the socket. The reader parks before the write, so
 * there is no backpressure interplay for the single buffered chunk. */
async function deflateBytes(
  encoding: 'gzip' | 'deflate',
  bytes: Uint8Array
): Promise<Uint8Array> {
  const through = new CompressionStream(encoding);
  const writer = through.writable.getWriter();
  const collected = readAll(through.readable);
  // ArrayBuffer-backed by construction (bytesSync / arrayBuffer paths) —
  // the bare `Uint8Array` alias carries ArrayBufferLike, which TS 6's
  // BufferSource no longer accepts.
  await writer.write(bytes as Uint8Array<ArrayBuffer>);
  await writer.close();
  return collected;
}

/**
 * Compression middleware (app-level, after the logger/cors slot in `use`
 * order — it rewrites the response on the unwind). Streams the body through
 * `CompressionStream`, drops the now-wrong content-length and records
 * `Vary: Accept-Encoding`.
 *
 * Skips: bodyless responses (204/304/HEAD), already-encoded responses,
 * partial content (206), and `cache-control: no-transform`.
 */
export function compress(options: CompressOptions = {}): Middleware {
  const minBytes = options.minBytes ?? DEFAULT_MIN_BYTES;
  const brotli = options.brotli?.compress;
  return async (ctx: Ctx, next) => {
    await next();
    const res = ctx.res;
    if (res === undefined || res.body === null) return;
    if (res.headers.has('content-encoding')) return;
    if (res.headers.has('content-range')) return;
    if ((res.headers.get('cache-control') ?? '').includes('no-transform')) {
      return;
    }
    const length = res.headers.get('content-length');
    if (length !== null && Number(length) < minBytes) return;
    // Brotli buffers whole bytes — byte-backed responses only, so a
    // streamed body never sits in memory for the injected encoder.
    const brotliAllowed = brotli !== undefined && length !== null;
    const encoding = pickEncoding(
      ctx.req.headers.get('accept-encoding') ?? '',
      brotliAllowed
    );
    if (encoding === undefined) return;
    const headers = new Headers(res.headers);
    headers.set('content-encoding', encoding);
    headers.delete('content-length');
    withVary(headers, 'accept-encoding');
    // Light fast path: a byte-backed light body compresses to bytes in one
    // shot, so the rebuilt response stays byte-backed and the adapter
    // writes it straight to the socket — no reader loop, no stream-wrapped
    // source. Brotli always buffers (whole bytes); streamed light bodies
    // and platform responses take the pipeThrough path below unchanged.
    const fastBytes = res instanceof LightResponse ? res.bytesSync() : null;
    const buffered =
      encoding === 'br' || fastBytes !== null
        ? (fastBytes ?? new Uint8Array(await res.arrayBuffer()))
        : null;
    if (buffered !== null) {
      const compressed =
        encoding === 'br'
          ? await brotli!(buffered)
          : await deflateBytes(encoding, buffered);
      ctx.res = newResponse(ctx, compressed, {
        status: res.status,
        statusText: res.statusText,
        headers,
      });
      return;
    }
    // Streamed path: `buffered === null` implies encoding is not 'br' (br
    // requires byte-backed bodies above), but the narrowing is data-flow,
    // not type-flow — assert the two stream formats.
    const compressed = res.body.pipeThrough(
      new CompressionStream(encoding as 'gzip' | 'deflate')
    );
    ctx.res = newResponse(ctx, compressed, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  };
}
