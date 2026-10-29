/**
 * Response compression middleware over the Web Standard
 * `CompressionStream` — zero dependencies and every supported runtime
 * (Node 18+, Bun, workers) provides it. gzip/deflate stream the body;
 * brotli is opt-in via an injected encoder (Node's CompressionStream has no
 * brotli — the node adapter ships one, see `brotliCompress` in `s200/node`).
 *
 * @module
 */

import type { Ctx, Middleware } from './types';

import { parseRanges } from './accepts';
import { collectStream } from './bytes';
import { byteBodyOf } from './light';
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
 * Picks the best supported encoding from Accept-Encoding per RFC 9110
 * §12.5.3: the highest-q coding wins, an explicit coding's q beats the
 * `*` catch-all regardless of list order, and an explicit q=0 bans that
 * coding even when `*` is acceptable. Ties break by server preference
 * br > gzip > deflate (brotli is the densest). `*` alone means br when a
 * brotli encoder is injected, else gzip. Returns undefined when nothing
 * acceptable is offered. The q grammar is shared with the accepts
 * family (`parseRanges`): q is clamped to [0, 1] and an unparseable q
 * parameter is ignored (q stays 1). Later occurrences of a name win —
 * pickEncoding's own rule, a plain per-name assignment.
 */
function pickEncoding(
  header: string,
  brotli: boolean
): 'gzip' | 'deflate' | 'br' | undefined {
  let gzip: number | undefined;
  let deflate: number | undefined;
  let br: number | undefined;
  let star: number | undefined;
  for (const { value, q } of parseRanges(header)) {
    // Later occurrences win — ranges arrive in header order, so a plain
    // per-name assignment implements the rule (`gzip;q=0.5, gzip;q=0.8`
    // leaves gzip at 0.8). Names outside the supported set (identity,
    // x-gzip, …) fall through: never candidates here.
    if (value === 'gzip') gzip = q;
    else if (value === 'deflate') deflate = q;
    else if (value === 'br') br = q;
    else if (value === '*') star = q;
  }

  // Effective q: an explicit listing overrides the `*` catch-all, so a
  // q=0 ban holds even when `*` is acceptable.
  const effBr = brotli ? br ?? star : undefined;
  const effGzip = gzip ?? star;
  const effDeflate = deflate ?? star;
  let best: 'br' | 'gzip' | 'deflate' | undefined;
  let bestQ = 0;
  const consider = (name: 'br' | 'gzip' | 'deflate', q: number | undefined) => {
    if (q === undefined || q <= bestQ) return;
    best = name;
    bestQ = q;
  };
  consider('br', effBr);
  consider('gzip', effGzip);
  consider('deflate', effDeflate);
  return best;
}

/**
 * Appends `value` to the Vary header without duplicating it. The
 * comparison lowercases both sides — the entry already in Vary may be
 * any case (`Vary: X-Api-Version` vs the appended `x-api-version`), and
 * a cache-varying header listed twice is still just one key. Shared by
 * compress (`accept-encoding`) and the version gate's negotiated header.
 *
 * @internal
 */
export function withVary(headers: Headers, value: string): void {
  const vary = headers.get('vary');
  if (vary === null) {
    headers.set('vary', value);
    return;
  }
  const lowered = value.toLowerCase();
  if (
    !vary.split(',').some((entry) => entry.trim().toLowerCase() === lowered)
  ) {
    headers.set('vary', `${vary}, ${value}`);
  }
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
  // A single chunk (the common small response) comes back without a
  // copy — collectStream's copySingle:false fast path.
  const collected = collectStream(through.readable, { copySingle: false });
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
    const fastBytes = byteBodyOf(res);
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
