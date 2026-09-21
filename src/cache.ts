/**
 * In-memory response cache as an opt-in middleware — bounded entries, TTL
 * expiry, LRU-ish refresh on hit. Read-through: on a miss the chain below
 * runs and a cacheable response is stored; on a hit the handler never runs.
 *
 * Safe-by-default: only `GET` responses with status 200 and a body are
 * stored; responses carrying `Set-Cookie` are never cached (a cached
 * session cookie is a session leak), requests carrying `Authorization`
 * are never served from cache, and request `Cache-Control: no-cache`
 * forces a revalidation pass. The body is cloned before storing, so the
 * response delivered to the client on the storing request is untouched.
 *
 * @module
 */

import type { Ctx, Middleware } from './types';

export type CacheOptions = {
  /** Entry lifetime in seconds; default 60. */
  readonly ttl?: number;
  /** Maximum entries; oldest evicted beyond it. Default 1000. */
  readonly max?: number;
  /** Maximum cached body size in bytes; default 1 MiB. */
  readonly sizeLimit?: number;
  /** Methods served from the cache; default `['GET']`. */
  readonly methods?: readonly string[];
  /** Custom cache key; default `${method} ${pathname}${search}`. */
  readonly key?: (ctx: Ctx) => string;
  /** Extra skip predicate (runs before every lookup and store). */
  readonly skip?: (ctx: Ctx) => boolean;
};

type CacheEntry = {
  readonly exp: number;
  readonly status: number;
  readonly headers: [string, string][];
  readonly body: Uint8Array;
};

const DEFAULT_METHODS = ['GET'];

/**
 * The response-cache middleware. Store semantics are deliberately
 * conservative — see the module docs. `HEAD` requests served from a `GET`
 * entry answer headers only (content-length included when it was cached).
 */
export function cache(options: CacheOptions = {}): Middleware {
  const ttl = (options.ttl ?? 60) * 1000;
  const max = options.max ?? 1000;
  const sizeLimit = options.sizeLimit ?? 1024 * 1024;
  const methods = new Set(options.methods ?? DEFAULT_METHODS);
  const store = new Map<string, CacheEntry>();

  const shouldSkip = (ctx: Ctx): boolean => {
    if (options.skip?.(ctx) === true) {
      return true;
    }
    // Authenticated responses are private — never serve them from a
    // shared store, and never store them either.
    return ctx.req.headers.has('authorization');
  };

  return async (ctx, next) => {
    const method = ctx.req.method.toUpperCase();
    if (!methods.has(method)) {
      return next();
    }
    if (shouldSkip(ctx)) {
      return next();
    }
    if (ctx.req.headers.get('cache-control')?.includes('no-cache') === true) {
      return next();
    }
    const key = options.key?.(ctx) ?? `${method} ${ctx.url.pathname}${ctx.url.search}`;
    const now = Date.now();
    const entry = store.get(key);
    if (entry !== undefined) {
      if (entry.exp > now) {
        // Refresh recency (LRU-ish): Map order is insertion order and
        // eviction removes the oldest.
        store.delete(key);
        store.set(key, entry);
        ctx.res =
          method === 'HEAD'
            ? new Response(null, { status: entry.status, headers: entry.headers })
            : new Response(entry.body as BodyInit, {
                status: entry.status,
                headers: entry.headers,
              });
        return;
      }
      store.delete(key);
    }
    await next();
    const res = ctx.res;
    if (res === undefined || res.status !== 200) {
      return;
    }
    if (res.headers.getSetCookie().length > 0) {
      return;
    }
    if (res.headers.get('cache-control')?.includes('no-store') === true) {
      return;
    }
    // A response that varies by request headers (compress's
    // Accept-Encoding, i18n Accept-Language) cannot be stored under a
    // path-only key — a hit would hand the wrong variant to the next
    // client. RFC 9111: skip storage, don't guess at the key.
    if (res.headers.get('vary') !== null) {
      return;
    }
    const declared = res.headers.get('content-length');
    if (declared !== null && Number(declared) > sizeLimit) {
      return;
    }
    if (res.body === null) {
      return;
    }
    // Clone before consuming: the original response must still stream to
    // the client that triggered the store.
    const bytes = new Uint8Array(await res.clone().arrayBuffer());
    if (bytes.byteLength > sizeLimit) {
      return;
    }
    const headers: [string, string][] = [];
    res.headers.forEach((value, name) => {
      headers.push([name, value]);
    });
    if (res.headers.get('content-length') === null) {
      // The store reconstructs Responses from bytes; advertise the size
      // explicitly so HEAD/etag/compress see it (respond helpers already
      // set it — this covers bare `new Response(...)` bodies).
      headers.push(['content-length', String(bytes.byteLength)]);
    }
    store.set(key, { exp: now + ttl, status: res.status, headers, body: bytes });
    while (store.size > max) {
      const oldest = store.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      store.delete(oldest);
    }
  };
}
