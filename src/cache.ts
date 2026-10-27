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

import { newResponse } from './respond';
import { evictOldest } from './map-limit';

export type CacheOptions = {
  /** Entry lifetime in seconds; default 60. */
  readonly ttl?: number;
  /** Maximum entries; oldest evicted beyond it. Default 1000. The
   * in-memory store's concern only — a custom `store` evicts itself. */
  readonly max?: number;
  /** Maximum cached body size in bytes; default 1 MiB. */
  readonly sizeLimit?: number;
  /** Methods served from the cache; default `['GET']`. */
  readonly methods?: readonly string[];
  /** Custom cache key; default `${method} ${pathname}${search}`. */
  readonly key?: (ctx: Ctx) => string;
  /** Extra skip predicate (runs before every lookup and store). */
  readonly skip?: (ctx: Ctx) => boolean;
  /**
   * Storage backend (shared counters across instances, e.g. Redis) behind
   * the same contract as `s200/rate-limit`'s store. Expiry is checked by
   * the middleware on every read — the store may also evict early.
   * The default is a bounded in-memory Map with LRU-ish refresh on hit.
   */
  readonly store?: CacheStore;
};

export type CacheEntry = {
  readonly exp: number;
  readonly status: number;
  readonly headers: [string, string][];
  readonly body: Uint8Array;
};

/** Hit accounting — see {@link CacheOptions.store}. `get`/`delete` may be
 * async (a networked store is); `set` stores the whole entry atomically. */
export type CacheStore = {
  readonly get: (
    key: string
  ) => CacheEntry | undefined | Promise<CacheEntry | undefined>;
  readonly set: (key: string, entry: CacheEntry) => void | Promise<void>;
  readonly delete: (key: string) => void | Promise<void>;
};

const DEFAULT_METHODS = ['GET'];

/** The default store: a bounded Map with refresh-on-hit recency (LRU-ish —
 * Map iteration order is insertion order, eviction drops the oldest). */
function createMemoryStore(max: number) {
  const map = new Map<string, CacheEntry>();
  return {
    get(key: string): CacheEntry | undefined {
      return map.get(key);
    },
    set(key: string, entry: CacheEntry): void {
      map.set(key, entry);
      // evictOldest no-ops on an empty Map, so a max of 0 still terminates.
      while (map.size > max) {
        evictOldest(map);
      }
    },
    delete(key: string): void {
      map.delete(key);
    },
    refresh(key: string, entry: CacheEntry): void {
      map.delete(key);
      map.set(key, entry);
    },
  };
}

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
  const memory = options.store === undefined ? createMemoryStore(max) : undefined;
  const store: CacheStore = options.store ?? (memory as CacheStore);

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
    const entry = await store.get(key);
    if (entry !== undefined) {
      if (entry.exp > now) {
        // Refresh recency (LRU-ish) — the default store's concern only.
        memory?.refresh(key, entry);
        ctx.res = newResponse(ctx, method === 'HEAD' ? null : entry.body, {
          status: entry.status,
          headers: entry.headers,
        });
        return;
      }
      await store.delete(key);
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
    await store.set(key, { exp: now + ttl, status: res.status, headers, body: bytes });
  };
}

/** Directive inputs for {@link cacheControl} — every field optional, at
 * least one required. Seconds fields must be non-negative integers. */
export type CacheControlOptions = {
  /** `max-age=N` — freshness lifetime in seconds, shared and private
   * caches alike. */
  readonly maxAge?: number;
  /** `s-maxage=N` — the shared-cache override of `max-age` (a CDN may
   * serve longer than a browser). */
  readonly sMaxAge?: number;
  /** `stale-while-revalidate=N` — a shared cache may serve stale content
   * while it revalidates in the background for this many seconds past
   * expiry. */
  readonly staleWhileRevalidate?: number;
  /** `no-store` — nothing is stored anywhere, by any cache, ever. */
  readonly noStore?: boolean;
  /** `no-cache` — stored, but every serve revalidates first. */
  readonly noCache?: boolean;
  /** `private` — the response is for one user; shared caches must not
   * store it. */
  readonly private?: boolean;
  /** `immutable` — the body never changes while fresh (fingerprinted
   * assets). */
  readonly immutable?: boolean;
  /** `must-revalidate` — once stale, no serving without a successful
   * revalidation (stale-on-error is off). */
  readonly mustRevalidate?: boolean;
};

/**
 * Builds a `Cache-Control` header value from directives — the one-call
 * shape for stamping freshness on a response:
 *
 * ```ts
 * get(app, '/asset/main.9f3c.js', (ctx) =>
 *   text(ctx, body, {
 *     headers: {
 *       'cache-control': cacheControl({ maxAge: 31_536_000, immutable: true }),
 *     },
 *   })
 * );
 * ```
 *
 * Directives land in a fixed order (`no-cache, private, max-age=N,
 * s-maxage=N, must-revalidate, stale-while-revalidate=N, immutable`) —
 * order carries no meaning per RFC 9111, a stable one just reads and
 * diffs well. `noStore: true` short-circuits to exactly `no-store`:
 * every other directive is meaningless once storage is forbidden.
 * Throws on an empty directive set (a no-op header is a bug) and on
 * negative or non-integer seconds.
 *
 * This is a builder for the header your *clients and CDNs* read — it
 * composes with, but is independent of, the `cache()` middleware: the
 * middleware's own freshness window is `ttl` (it does not serve stale),
 * while `stale-while-revalidate` governs what downstream shared caches
 * do between your server and the user.
 */
export function cacheControl(options: CacheControlOptions): string {
  if (options.noStore === true) return 'no-store';
  const parts: string[] = [];
  const seconds = (name: string, value: number | undefined): void => {
    if (value === undefined) return;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(
        `Invalid cache-control ${name} ${String(value)}: must be a non-negative integer (seconds)`
      );
    }
    parts.push(`${name}=${String(value)}`);
  };
  if (options.noCache === true) parts.push('no-cache');
  if (options.private === true) parts.push('private');
  seconds('max-age', options.maxAge);
  seconds('s-maxage', options.sMaxAge);
  if (options.mustRevalidate === true) parts.push('must-revalidate');
  seconds('stale-while-revalidate', options.staleWhileRevalidate);
  if (options.immutable === true) parts.push('immutable');
  if (parts.length === 0) {
    throw new Error('cacheControl() requires at least one directive');
  }
  return parts.join(', ');
}
