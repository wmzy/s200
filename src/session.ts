/**
 * Server-side sessions over a signed cookie: the client carries nothing
 * but an opaque id (HMAC-verified via the cookies battery), the data
 * lives in a pluggable store. Zero dependencies.
 *
 * The middleware restores or mints on the way in and settles up on the
 * unwind: mutated or `touch()`ed sessions persist and (re)issue their
 * cookie, destroyed ones are deleted and expired, and a request that
 * only reads leaves no trace — no store write, no `Set-Cookie`.
 *
 * Cookie signing is imported from `./cookies` (HMAC-SHA256 plus a
 * `name.sig` partner cookie) instead of being reimplemented: one signing
 * convention framework-wide, and the bytes are shared with any bundle
 * that already pulls in both batteries — the allowed packaging cost.
 *
 * @module
 */

import type { Middleware } from './types';

import { getSignedCookie, setSignedCookie, type CookieOptions } from './cookies';

/** Per-session data bag: plain JSON-shaped records, opaque to the store. */
export type SessionData = Record<string, unknown>;

/**
 * Session persistence. Implementations return values or promises — the
 * middleware awaits either. `set` receives the TTL the cookie advertises
 * so a shared store (Redis `SET ... EX`, KV `put { expirationTtl }`)
 * expires data together with its cookie instead of leaking ids past
 * their lifetime.
 */
export type SessionStore = {
  get(id: string): SessionData | undefined | Promise<SessionData | undefined>;
  set(id: string, data: SessionData, ttlSeconds: number): void | Promise<void>;
  delete(id: string): void | Promise<void>;
};

/**
 * One request's session: pure data plus functions, hung on
 * `ctx.state[key]` (default `'session'`). `isNew` is stable for the
 * request — it reports whether a valid cookie + store hit restored data,
 * not whether the unwind is about to mint an id.
 */
export type Session = {
  /** The restored session's id; `undefined` until the unwind mints one. */
  readonly id?: string;
  /** True when no valid cookie/store hit restored data this request. */
  readonly isNew: boolean;
  get(key: string): unknown;
  /** Stores a value; the session persists on the unwind. */
  set(key: string, value: unknown): void;
  /** Removes one key; the session persists on the unwind. */
  delete(key: string): void;
  /** Drops every key; the session persists on the unwind. */
  clear(): void;
  /** Renews the expiry of an existing session — a no-op on a new one. */
  touch(): void;
  /**
   * Deletes the session from the store; the unwind expires the cookie.
   * Terminal: mutations after `destroy()` are discarded.
   */
  destroy(): Promise<void>;
};

/** Cookie face of the session id — forwarded to the cookies battery. */
export type SessionCookieOptions = {
  /** Cookie name; default `'s200.sid'` (signature partner: `.sig`). */
  readonly name?: string;
  /** Cookie and store lifetime in seconds; default 86_400 (one day). */
  readonly maxAge?: number;
  /** Default `true` — a session id is for the server alone. */
  readonly httpOnly?: boolean;
  readonly sameSite?: 'strict' | 'lax' | 'none';
  readonly path?: string;
  readonly secure?: boolean;
  readonly domain?: string;
};

/** Options for {@link createSession}. */
export type SessionOptions = {
  /** HMAC secret — the same key material the cookies battery signs with. */
  readonly secret: string;
  readonly cookie?: SessionCookieOptions;
  /**
   * Session persistence; default: an in-process map with lazy expiry on
   * read and a periodic (unref'd) sweep. Custom stores manage their own
   * lifecycle — the Redis shape:
   *
   * ```ts
   * const store: SessionStore = {
   *   async get(id) {
   *     const raw = await redis.get(`sess:${id}`);
   *     return raw === null ? undefined : (JSON.parse(raw) as SessionData);
   *   },
   *   set(id, data, ttl) {
   *     return redis.set(`sess:${id}`, JSON.stringify(data), 'EX', ttl);
   *   },
   *   delete(id) {
   *     return redis.del(`sess:${id}`);
   *   },
   * };
   * ```
   */
  readonly store?: SessionStore;
  /** `ctx.state` slot for the session object; default `'session'`. */
  readonly key?: string;
  /** Clock override (tests, deterministic replays); default `Date.now`. */
  readonly now?: () => number;
};

/**
 * Sweep cadence of the default store, milliseconds. Reclamation only —
 * every read lazy-checks expiry, so correctness never waits on a tick.
 */
const SWEEP_MS = 60_000;

/**
 * In-process session store: a map of `{ data, expiresAt }` entries.
 * Reads evict lazily (an expired entry dies on sight), the sweeper is an
 * unref'd interval that never holds the process open, and `close()`
 * stops it and drops everything for explicit teardown.
 */
function memoryStore(now: () => number): SessionStore & { close(): void } {
  const entries = new Map<string, { data: SessionData; expiresAt: number }>();
  let sweeper: ReturnType<typeof setInterval> | undefined;
  return {
    get(id) {
      const entry = entries.get(id);
      if (entry === undefined) return undefined;
      if (entry.expiresAt <= now()) {
        entries.delete(id);
        return undefined;
      }
      return entry.data;
    },
    set(id, data, ttlSeconds) {
      // Copy in: post-response mutations of the session must not leak
      // into the store without a persist.
      entries.set(id, { data: { ...data }, expiresAt: now() + ttlSeconds * 1000 });
      if (sweeper === undefined) {
        sweeper = setInterval(() => {
          const t = now();
          for (const [staleId, entry] of entries) {
            if (entry.expiresAt <= t) entries.delete(staleId);
          }
        }, SWEEP_MS);
        // Node keeps the event loop alive for a live interval; Deno hands
        // back a plain number. The optional call covers both.
        (sweeper as { unref?: () => void }).unref?.();
      }
    },
    delete(id) {
      entries.delete(id);
    },
    close() {
      if (sweeper !== undefined) clearInterval(sweeper);
      sweeper = undefined;
      entries.clear();
    },
  };
}

/**
 * Builds the session middleware. Register once per app:
 *
 * ```ts
 * const { middleware } = createSession({ secret: process.env.SECRET });
 * use(app, middleware);
 * get(app, '/', (ctx) => {
 *   const session = ctx.state.session as Session;
 *   session.set('user', 'alice');
 *   return new Response('ok');
 * });
 * ```
 *
 * Returns `{ middleware, close }`. `close()` stops the default store's
 * sweep timer and drops its entries — tests and hot reloads want that;
 * production rarely does (the timer is unref'd either way). With an
 * injected store it is a no-op: custom stores own their lifecycle.
 *
 * Throws on an empty secret (an HMAC over nothing guards nothing) and on
 * a non-positive `maxAge` (a cookie and its store entry that die at
 * birth).
 */
export function createSession(options: SessionOptions): {
  readonly middleware: Middleware;
  readonly close: () => void;
} {
  if (options.secret === '') {
    throw new Error('Invalid session secret: must be a non-empty string');
  }
  const maxAge = options.cookie?.maxAge ?? 86_400;
  if (maxAge <= 0) {
    throw new Error(`Invalid session cookie maxAge ${String(maxAge)}: must be positive`);
  }
  const cookieName = options.cookie?.name ?? 's200.sid';
  const cookieAttributes: CookieOptions = {
    maxAge,
    httpOnly: options.cookie?.httpOnly ?? true,
    sameSite: options.cookie?.sameSite,
    path: options.cookie?.path,
    secure: options.cookie?.secure,
    domain: options.cookie?.domain,
  };
  const stateKey = options.key ?? 'session';
  const now = options.now ?? Date.now;
  const ownStore = memoryStore(now);
  const store = options.store ?? ownStore;

  const middleware: Middleware = async (ctx, next) => {
    // IN — verify and restore, or start empty. A tampered, expired or
    // unknown id looks exactly like a missing cookie: the client gets a
    // fresh session, never an error.
    let id = await getSignedCookie(ctx, cookieName, options.secret);
    if (id === '') id = undefined;
    let data: SessionData = {};
    if (id !== undefined) {
      const stored = await store.get(id);
      if (stored === undefined) {
        id = undefined;
      } else {
        // Copy on restore so handler mutations can't alias store
        // internals; the unwind persists what actually changed.
        data = { ...stored };
      }
    }
    let dirty = false; // data changed — persists, creating when new
    let renewed = false; // touch() — refreshes an existing entry's TTL
    let destroyed = false;
    let deleted = false;

    const session: Session = {
      id,
      isNew: id === undefined,
      get: (key) => data[key],
      set: (key, value) => {
        data[key] = value;
        dirty = true;
      },
      delete: (key) => {
        // Session data is caller-keyed — a dynamic delete is the point here.
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete data[key];
        dirty = true;
      },
      clear: () => {
        data = {};
        dirty = true;
      },
      touch: () => {
        if (id !== undefined) renewed = true;
      },
      destroy: async () => {
        destroyed = true;
        if (id !== undefined && !deleted) {
          deleted = true;
          await store.delete(id);
        }
      },
    };
    ctx.state[stateKey] = session;
    await next();

    // UNWIND — destroy beats persist beats silence. ctx.res exists by
    // now (the chain materializes 404/405/500 fallbacks in-chain), so
    // the cookie writes below always have a response to ride on.
    if (destroyed) {
      if (id !== undefined && !deleted) {
        deleted = true;
        await store.delete(id);
      }
      // Same attributes, Max-Age=0: a browser only deletes the cookie
      // the original attributes match (path/domain).
      await setSignedCookie(ctx, cookieName, '', options.secret, {
        ...cookieAttributes,
        maxAge: 0,
      });
      return;
    }
    if (dirty || renewed) {
      const sid = id ?? crypto.randomUUID();
      if (id === undefined) {
        id = sid;
        // `id` is readonly to readers; the unwind's mint is its single
        // writer — every handler has already observed the session.
        (session as { id?: string }).id = sid;
      }
      await store.set(sid, data, maxAge);
      await setSignedCookie(ctx, cookieName, sid, options.secret, cookieAttributes);
    }
  };

  const close = (): void => {
    // Only the internal default needs stopping; an injected store owns
    // its connections and its lifecycle.
    if (store === ownStore) ownStore.close();
  };

  return { middleware, close };
}
