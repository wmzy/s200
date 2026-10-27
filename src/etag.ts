/**
 * ETag middleware for API responses: stamps a content hash (SHA-1, weak
 * by default) on byte-backed responses and answers `If-None-Match` hits
 * with 304 — the cheap revalidation static files get for free.
 *
 * Scope: byte-backed bodies only, detected by an explicit
 * `content-length`. s200's respond helpers (`json`/`text`/`html`/`send`)
 * set it; a bare `new Response('…')` does not (platforms serialize
 * content-length lazily), so stamp it yourself or use the helpers.
 * Chunked/streamed responses (SSE, `s200/streaming`) are skipped —
 * hashing would consume the stream. Range responses (206) manage their
 * own validators and are skipped too.
 *
 * @module
 */

import type { Ctx, Middleware } from './types';

import { LightResponse } from './light';
import { newResponse } from './respond';
import { toHex } from './crypto-util';

export type EtagOptions = {
  /** Emit a strong entity tag instead of the default weak one. */
  readonly strong?: boolean;
};

/** Weak comparison per RFC 9110 §8.8.3: the `W/` prefix is insignificant.
 * Shared with `s200/static`'s `If-None-Match` handling so the two
 * validator implementations cannot drift.
 *
 * @internal */
export function etagMatches(ifNoneMatch: string, tag: string): boolean {
  const expected = tag.startsWith('W/') ? tag.slice(2) : tag;
  return ifNoneMatch.split(',').some((candidate) => {
    const value = candidate.trim();
    if (value === '*') return true;
    return (value.startsWith('W/') ? value.slice(2) : value) === expected;
  });
}

/**
 * ETag stamping middleware (app-level via `use`, or per-route). Runs on
 * the unwind: fallback 404/405/500 responses have no content-length, so
 * they pass through unstamped like any streamed response.
 */
export function etag(options: EtagOptions = {}): Middleware {
  const prefix = options.strong === true ? '' : 'W/';
  return async (ctx: Ctx, next) => {
    await next();
    const res = ctx.res;
    if (res === undefined || res.body === null) return;
    if (res.headers.has('etag')) return;
    if (res.headers.has('content-range')) return;
    if (res.status < 200 || res.status >= 300) return;
    if (res.headers.get('content-length') === null) return;
    // Light fast path: a byte-backed light response hands its bytes over
    // synchronously — no platform body read, no defensive copy. Streamed
    // and lazy light bodies fall through to the async read, exactly like a
    // platform response.
    const source =
      res instanceof LightResponse
        ? (res.bytesSync() as Uint8Array<ArrayBuffer> | null)
        : null;
    const bytes = source ?? new Uint8Array(await res.arrayBuffer());
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
    const tag = `${prefix}"${toHex(digest)}"`;
    const headers = new Headers(res.headers);
    headers.set('etag', tag);
    const ifNoneMatch = ctx.req.headers.get('if-none-match');
    if (ifNoneMatch !== null && etagMatches(ifNoneMatch, tag)) {
      // RFC 9110 §15.4.5: the 304 omits content-length — the copied header
      // carries the would-be size, and s200's contract is omission.
      headers.delete('content-length');
      ctx.res = newResponse(ctx, null, {
        status: 304,
        statusText: 'Not Modified',
        headers,
      });
      return;
    }
    ctx.res = newResponse(ctx, bytes, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  };
}
