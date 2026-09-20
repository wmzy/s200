/**
 * Response compression middleware over the Web Standard
 * `CompressionStream` — zero dependencies and every supported runtime
 * (Node 18+, Bun, Deno, workers) provides it. gzip/deflate only: Node's
 * CompressionStream has no brotli, so the Accept-Encoding negotiation never
 * offers it.
 *
 * @module
 */

import type { Ctx, Middleware } from './types';

export type CompressOptions = {
  /**
   * Minimum uncompressed size in bytes before a response is compressed;
   * default 1024. Only consulted when the response carries a
   * content-length — streamed responses (no length) compress regardless,
   * like a proxy would.
   */
  readonly minBytes?: number;
};

const DEFAULT_MIN_BYTES = 1024;

/**
 * Picks the best supported encoding from Accept-Encoding. Returns undefined
 * when nothing acceptable is offered. gzip wins ties; `*` counts as gzip;
 * q=0 (or q=0.0) disqualifies.
 */
function pickEncoding(header: string): 'gzip' | 'deflate' | undefined {
  let gzip = 0;
  let deflate = 0;
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
    else if (name === '*') star = q;
  }
  if (gzip > 0) return 'gzip';
  if (deflate > 0) return 'deflate';
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
    const encoding = pickEncoding(ctx.req.headers.get('accept-encoding') ?? '');
    if (encoding === undefined) return;
    const compressed = res.body.pipeThrough(new CompressionStream(encoding));
    const headers = new Headers(res.headers);
    headers.set('content-encoding', encoding);
    headers.delete('content-length');
    withVary(headers, 'accept-encoding');
    ctx.res = new Response(compressed, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  };
}
