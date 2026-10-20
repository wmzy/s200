/**
 * Dev-mode battery: swap an app's route table live without restarting the
 * server, and turn 404 misses into hints about what the table does have.
 * Hot reload works because an `App` is a mutable data object — `serve`
 * holds one object identity forever, while `handle` re-reads its fields on
 * every request and the composed-chain caches version on array identity
 * (frozen snapshots, see src/app.ts). Replacing the fields atomically
 * switches every NEW request to the fresh table; requests already in flight
 * keep running their captured chain to completion.
 *
 * Node-only entry (`node:fs` / `node:url`); pure functions + data, no state
 * beyond the caller's own objects.
 *
 * @module
 */

import type { App } from './app';
import type { Ctx, Middleware, Next, Route, Segment, State } from './types';

import { watch, type FSWatcher } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { newResponse } from './respond';

/** A stable app identity whose table can be swapped via `reload`. */
export type HotApp<S extends State = State> = {
  /** The live app object — same identity for its whole lifetime. */
  readonly app: App<S>;
  /**
   * Atomically replaces every field of the live app with `next`'s. The
   * frozen `routes`/`middlewares` arrays are moved by reference (never
   * copied or unfrozen), so the dispatch caches invalidate exactly when
   * content changed — and a reload passing identical references is a no-op.
   * In-flight requests are untouched: they hold the old chain in their
   * closure and finish on the old behavior.
   */
  reload(next: App<S>): void;
};

/**
 * Wraps `initial` as a hot-reloadable app: `serve(hot.app, …)` keeps one
 * object identity, and `hot.reload(nextApp)` swaps the live table in place —
 * routes, middlewares, matcher, and the error/404/logError policies.
 */
export function createHotApp<S extends State = State>(initial: App<S>): HotApp<S> {
  const app = initial;
  return {
    app,
    reload(next: App<S>): void {
      // Field-by-field assignment over the complete App surface (keep in
      // sync with src/app.ts when fields are added).
      app.routes = next.routes;
      app.middlewares = next.middlewares;
      app.match = next.match;
      app.onError = next.onError;
      app.onNotFound = next.onNotFound;
      app.logError = next.logError;
    },
  };
}

// Millisecond timestamps alone collide for back-to-back imports; the
// sequence guarantees a fresh cache key on every call.
let freshSeq = 0;

/**
 * Imports a module bypassing the ESM cache by stamping a `?t=` query onto
 * its file URL. Relative specifiers resolve against `process.cwd()`. This
 * is the loader half of hot reload: `await importFresh('./app.mjs')` on
 * every file change re-evaluates the module and returns a fresh instance.
 */
export async function importFresh(specifier: string): Promise<unknown> {
  // pathToFileURL resolves the path absolutely (cwd-relative) and
  // percent-encodes characters that would corrupt the query we append.
  const href = pathToFileURL(specifier).href;
  return import(/* @vite-ignore */ `${href}${href.includes('?') ? '&' : '?'}t=${Date.now()}-${++freshSeq}`);
}

/** Options for {@link watchAndReload}. */
export type WatchAndReloadOptions<S extends State = State> = {
  /** Directories to watch — only source files inside trigger reloads. */
  readonly dirs: readonly string[];
  /** Builds the next app from disk; called after the debounce window. */
  readonly load: () => Promise<App<S>>;
  /** The hot app to swap (see `createHotApp`). */
  readonly hot: HotApp<S>;
  /** Debounce window in ms (editors fire bursts of events); default 50. */
  readonly debounceMs?: number;
  /**
   * Called when `load` throws — the previous table stays live. Defaults to
   * `console.error`, mirroring the app's own error sink policy.
   */
  readonly onError?: (error: unknown) => void;
};

/** Handle returned by `watchAndReload`; `close()` stops all watchers. */
export type WatchAndReloadHandle = {
  close(): Promise<void>;
};

/** Extensions whose changes can alter the module graph — everything Node
 * can import as source. */
const SOURCE_EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'];

/**
 * True when a watch event's filename names a source file worth reloading
 * for: a `.ts`/`.js`/`.json` extension, outside `node_modules` and
 * dot-directories. Anything else — logs, SQLite databases, editor temp
 * files — must not trigger reloads: an app (or a `tee` of this server's
 * own output) writing into its watched directory would otherwise feed
 * reload events back into itself. Events without a filename stay
 * reloadable — losing an edit is worse than a stray reload.
 */
function isSourceFileEvent(filename: string | Buffer | null): boolean {
  if (typeof filename !== 'string') {
    return true;
  }
  const segments = filename.split(/[\\/]/);
  const leaf = segments[segments.length - 1] ?? '';
  const dot = leaf.lastIndexOf('.');
  return (
    dot > 0 &&
    SOURCE_EXTENSIONS.includes(leaf.slice(dot)) &&
    segments.every((segment) => segment !== 'node_modules' && !segment.startsWith('.'))
  );
}

/**
 * Watches `dirs` (recursively where the platform supports it, otherwise per
 * directory non-recursively) and reloads the hot app through `load` after a
 * debounce window. Only source files (`.ts`/`.mts`/`.cts`/`.js`/`.mjs`/
 * `.cjs`/`.json`) outside `node_modules` and dot-directories trigger
 * reloads, so an app writing logs or data files into its own watched
 * directory cannot feed reload events back into itself. A failing `load`
 * keeps the previous table and reports through `onError`. Loads are
 * serialized: changes landing mid-load re-arm the debounce instead of
 * racing two reloads.
 */
export function watchAndReload<S extends State = State>(
  options: WatchAndReloadOptions<S>
): WatchAndReloadHandle {
  const { dirs, load, hot, debounceMs = 50, onError = console.error } = options;
  const watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let queued = false;
  let closed = false;

  const run = async (): Promise<void> => {
    if (closed || running) {
      return;
    }
    running = true;
    try {
      hot.reload(await load());
    } catch (error) {
      onError(error);
    } finally {
      running = false;
      // Changes that arrived while loading get their own debounce cycle.
      if (queued && !closed) {
        queued = false;
        schedule();
      }
    }
  };

  function schedule(): void {
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, debounceMs);
  }

  const trigger = (): void => {
    if (closed) {
      return;
    }
    if (running) {
      queued = true;
      return;
    }
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    schedule();
  };

  const onEvent = (_event: string, filename: string | Buffer | null): void => {
    if (isSourceFileEvent(filename)) {
      trigger();
    }
  };

  for (const dir of dirs) {
    try {
      watchers.push(watch(dir, { recursive: true }, onEvent));
    } catch {
      // The platform rejects recursive watching (some filesystems): degrade
      // to a plain per-directory watcher rather than failing to watch at all.
      watchers.push(watch(dir, onEvent));
    }
  }
  // A dead watcher (directory deleted, fs errors) must not crash the
  // process — surface it through the same error sink as load failures.
  for (const watcher of watchers) {
    watcher.on('error', (error) => onError(error));
  }

  return {
    async close(): Promise<void> {
      closed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      for (const watcher of watchers) {
        watcher.close();
      }
    },
  };
}

/** Options for {@link routeHints}. */
export type RouteHintsOptions = {
  /**
   * Maximum entries in the all-methods `routes` fallback list. Default 3.
   */
  readonly limit?: number;
};

/**
 * The response body {@link routeHints} decorates: the framework-default 404
 * envelope plus at most one hints field (which one depends on the ranking
 * below — never both).
 */
export type RouteHintsBody = {
  readonly error: 'Not Found';
  readonly hint?: string;
  readonly routes?: string[];
};

/** Would this route have served `method` had the path matched? Mirrors the
 * router's own compat rule (`methodCompatible` in src/router.ts): exact,
 * `'ALL'`, and `GET` routes for `HEAD` requests. */
function servesMethod(routeMethod: string, method: string): boolean {
  return (
    routeMethod === method ||
    routeMethod === 'ALL' ||
    (method === 'HEAD' && routeMethod === 'GET')
  );
}

/** Splits a pathname into comparable segments: the leading `/` and one
 * trailing `/` (trailing-slash tolerance, as with `strict: false`) drop
 * out; the root pathname yields an empty list. */
function pathSegments(pathname: string): string[] {
  const parts = pathname.split('/');
  const end =
    parts.length > 1 && parts[parts.length - 1] === '' ? parts.length - 1 : parts.length;
  return parts.slice(1, end);
}

/** Positional static-segment overlap between a pattern and a request path:
 * +1 per index where the pattern's segment is static and equals the
 * request's. Params, optional params and wildcards never score — only
 * literal agreement counts. */
function staticOverlap(segments: readonly Segment[], path: readonly string[]): number {
  const count = Math.min(segments.length, path.length);
  let score = 0;
  for (let i = 0; i < count; i++) {
    const segment = segments[i];
    if (segment !== undefined && segment._tag === 'static' && segment.value === path[i]) {
      score++;
    }
  }
  return score;
}

/** Is this exactly the framework-default 404 body (`{"error":"Not Found"}`,
 * the `createApp` fallback)? A custom `onNotFound`, an `httpError(404)`
 * (`{"error":"HTTP 404 Not Found"}`) or any middleware-rewritten body must
 * parse to something else. */
function isDefaultNotFoundBody(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      Object.keys(parsed).length === 1 &&
      (parsed as { error?: unknown }).error === 'Not Found'
    );
  } catch {
    return false;
  }
}

/**
 * Dev-mode 404 route hints: a middleware that decorates the
 * framework-default 404 with what the route table knows, turning a miss
 * into a "did you mean" for the developer. The route table is data, so a
 * miss can say what exists.
 *
 * Takes the app as data — middlewares only receive `(ctx, next)`, and
 * `createRouteTable`/`createClient` are the precedent for app-consuming
 * batteries. The middleware closes over the live app object and reads
 * `app.routes` per request, so hot-reload swaps are picked up without
 * re-registration.
 *
 * Never-clobber rule: only a 404 whose body parses to exactly
 * `{"error":"Not Found"}` is decorated. Anything else — a custom
 * `onNotFound`, a thrown or returned `httpError(404)`, a body another
 * middleware already rewrote — passes through byte-for-byte, and the
 * decoration keeps the 404 status plus the response's existing headers.
 *
 * Ranking (boring and deterministic): same-method routes (router compat —
 * exact, `'ALL'`, `GET` for `HEAD`) by positional static-segment overlap,
 * ties by registration order. Then:
 *
 * - top same-method candidate overlaps at least half the request's
 *   segments → `{ error, hint: 'did you mean GET /users/:id?' }`;
 * - no same-method route overlaps at all, but some route does →
 *   `{ error, routes }` listing the top `limit` (default 3)
 *   `METHOD pattern` strings across ALL methods, same ranking;
 * - otherwise (weak same-method candidates only, or nothing overlaps) →
 *   the default body is left untouched.
 *
 * Dev battery, not hot path: it clones and parses every default-404 body,
 * which is cheap in development and pointless overhead in production.
 */
export function routeHints(app: App, options: RouteHintsOptions = {}): Middleware {
  const { limit = 3 } = options;
  return async (ctx: Ctx, next: Next): Promise<void> => {
    await next();
    const res = ctx.res;
    if (res === undefined || res.status !== 404) {
      return;
    }
    // Read through a clone so a body we decide not to touch stays intact.
    let bodyText: string;
    try {
      bodyText = await res.clone().text();
    } catch {
      return; // Uncloneable (streamed light body): leave the 404 as-is.
    }
    if (!isDefaultNotFoundBody(bodyText)) {
      return;
    }
    const path = pathSegments(ctx.url.pathname);
    const method = ctx.req.method;
    let best: { route: Route; score: number } | undefined;
    const overlapping: { route: Route; score: number }[] = [];
    for (const route of app.routes) {
      const score = staticOverlap(route.segments, path);
      if (score === 0) {
        continue;
      }
      overlapping.push({ route, score });
      // Strict `>` keeps the first registrant on a tie.
      if (servesMethod(route.method, method) && (best === undefined || score > best.score)) {
        best = { route, score };
      }
    }
    let decorated: RouteHintsBody | undefined;
    if (best !== undefined && best.score * 2 >= path.length) {
      decorated = {
        error: 'Not Found',
        hint: `did you mean ${best.route.method} ${best.route.pattern}?`,
      };
    } else if (best === undefined && overlapping.length > 0) {
      // Array.prototype.sort is stable: equal scores keep registration order.
      overlapping.sort((a, b) => b.score - a.score);
      const routes = overlapping
        .slice(0, limit)
        .map((entry) => `${entry.route.method} ${entry.route.pattern}`);
      if (routes.length > 0) {
        decorated = { error: 'Not Found', routes };
      }
    }
    if (decorated !== undefined) {
      ctx.res = newResponse(ctx, JSON.stringify(decorated), {
        status: 404,
        headers: res.headers,
      });
    }
  };
}
