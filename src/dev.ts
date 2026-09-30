/**
 * Hot-reload battery: swap an app's route table live without restarting the
 * server. This works because an `App` is a mutable data object — `serve`
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
import type { State } from './types';

import { watch, type FSWatcher } from 'node:fs';
import { pathToFileURL } from 'node:url';

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

/** Options for `watchAndReload`. */
export type WatchAndReloadOptions<S extends State = State> = {
  /** Directories to watch. */
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

/**
 * Watches `dirs` (recursively where the platform supports it, otherwise per
 * directory non-recursively) and reloads the hot app through `load` after a
 * debounce window. A failing `load` keeps the previous table and reports
 * through `onError`. Loads are serialized: changes landing mid-load re-arm
 * the debounce instead of racing two reloads.
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

  for (const dir of dirs) {
    try {
      watchers.push(watch(dir, { recursive: true }, trigger));
    } catch {
      // The platform rejects recursive watching (some filesystems): degrade
      // to a plain per-directory watcher rather than failing to watch at all.
      watchers.push(watch(dir, trigger));
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
