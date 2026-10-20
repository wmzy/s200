/**
 * `s200 dev` — the dev-server runner. One HTTP server identity for the
 * whole session; reloads swap the app's route table atomically (see
 * {@link createHotApp}), so in-flight requests finish on the old chain
 * while new requests hit the fresh table. No restart, no port churn.
 *
 * This module is pure wiring over two batteries — `s200/dev` (identity +
 * swap + watch) and `s200/node` (`serve`) — plus an argv parser. The
 * `load` and `watch` seams keep the runner testable without a filesystem:
 * tests inject an in-memory app factory and a stub watcher.
 *
 * @module
 */

import type { App } from './app';
import type { HotApp, WatchAndReloadHandle } from './dev';

import * as nodeModule from 'node:module';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createHotApp, importFresh, watchAndReload } from './dev';
import { serve } from './node';

const USAGE = `usage: s200 dev [entry] [--port N]

  entry    app module exporting the app as default or as a named export "app"
           (default ./app.ts)
  --port   listen port (default $PORT or 3000; 0 picks a free port)

TypeScript entries need Node >= 22.18 (or >= 22.6 with --experimental-strip-types).`;

/** Parsed `s200 dev` arguments — `port` is `undefined` when no flag given. */
export type DevArgs = {
  readonly entry: string;
  readonly port: number | undefined;
};

/** The argv grammar of `s200 dev`: `[entry] [--port N]`. Throws on anything
 * else, with the usage text in the message. */
export function parseDevArgs(argv: readonly string[]): DevArgs {
  let entry: string | undefined;
  let port: number | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const flagValue = (): string => {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error(`s200 dev: ${arg} requires a number\n${USAGE}`);
      }
      return value;
    };
    const checkPort = (raw: string): number => {
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
        throw new Error(`s200 dev: invalid port "${raw}"\n${USAGE}`);
      }
      return parsed;
    };
    if (arg === '--port') {
      port = checkPort(flagValue());
      i += 1;
    } else if (arg.startsWith('--port=')) {
      port = checkPort(arg.slice('--port='.length));
    } else if (arg.startsWith('--')) {
      throw new Error(`s200 dev: unknown option "${arg}"\n${USAGE}`);
    } else if (entry !== undefined) {
      throw new Error(`s200 dev: unexpected argument "${arg}"\n${USAGE}`);
    } else {
      entry = arg;
    }
  }
  return { entry: entry ?? './app.ts', port };
}

/** What the watch seam receives: everything `watchAndReload` needs. */
export type WatchOptions = {
  /** Directories to watch — the entry's directory plus `watchDirs`. */
  readonly dirs: readonly string[];
  /** The hot app to swap; already wired to report through `onReload`. */
  readonly hot: HotApp;
  /** Builds the next app from disk (or an injected factory in tests). */
  readonly load: () => Promise<App>;
  /** Where watch/load failures are reported; the previous table stays live. */
  readonly onError: (error: unknown) => void;
};

/** Options for {@link runDev}. */
export type RunDevOptions = {
  /** Builds the app to serve, re-invoked on every reload. Default:
   * `importFresh(entry)` + the default-export / named `app` convention. */
  readonly load?: () => Promise<App>;
  /** Port override — the `--port` flag wins over this, `$PORT` sits last. */
  readonly port?: number;
  /** Extra directories to watch in addition to the entry's directory. */
  readonly watchDirs?: readonly string[];
  /** Reload observer; the default logs one `reloaded (N routes)` line. */
  readonly onReload?: (app: App) => void;
  /** Watch seam — `watchAndReload` in production, a stub in tests. */
  readonly watch?: (options: WatchOptions) => WatchAndReloadHandle;
};

/** The running dev server: where it listens, the adapter's handle, and a
 * full shutdown (watcher first, then the server). */
export type DevServer = {
  readonly url: URL;
  readonly server: unknown;
  close(): Promise<void>;
};

const isApp = (value: unknown): value is App =>
  typeof value === 'object' &&
  value !== null &&
  Array.isArray((value as { routes?: unknown }).routes);

/** Extracts the app a dev entry exports — default export or named `app`. */
function appFromModule(entry: string, mod: unknown): App {
  const candidate = (mod as { default?: unknown; app?: unknown }).default;
  const named = (mod as { app?: unknown }).app;
  const app = candidate ?? named;
  if (isApp(app)) {
    return app;
  }
  throw new Error(
    `s200 dev: ${entry} exports no app — export it as default or as a named export "app"`
  );
}

/** The default loader: re-imports the entry bypassing the ESM cache and
 * applies the export convention above. */
const loadFromEntry =
  (entry: string) =>
  async (): Promise<App> =>
    appFromModule(entry, await importFresh(entry));

/** The default reload report — one line, honest route count. */
const defaultOnReload = (app: App): void => {
  console.log(`s200 dev: reloaded (${app.routes.length} routes)`);
};

/** The default watch seam: `s200/dev`'s own watcher. */
const watchDefault = (options: WatchOptions): WatchAndReloadHandle =>
  watchAndReload(options);

// --- Whole-graph reloads ----------------------------------------------------
//
// `importFresh` alone only re-evaluates the *entry*: its static imports
// keep their original URLs, so Node's ESM cache hands back the old
// dependency instances — editing a module the entry imports would report
// "reloaded" while still serving stale code. When `module.registerHooks`
// (Node >= 22.15) is available, every module resolved under the watched
// roots gets an epoch query stamped onto its URL, so one reload
// re-evaluates the whole project graph. Older Nodes degrade honestly:
// entry-only reloads plus a one-time warning.

/** Query key carrying the reload epoch through module URLs. */
const EPOCH_KEY = 's200epoch';

/** File-URL prefixes (trailing slash included) of the watched directories. */
const watchRoots: string[] = [];

/** Bumped once per load; modules under {@link watchRoots} cache per epoch. */
let reloadEpoch = 0;

/** True when this Node offers `module.registerHooks` (>= 22.15). */
const canBustGraph = typeof nodeModule.registerHooks === 'function';

if (canBustGraph) {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      const url = resolved?.url;
      if (
        typeof url === 'string' &&
        url.startsWith('file:') &&
        !url.includes(`${EPOCH_KEY}=`) &&
        watchRoots.some((root) => url.startsWith(root))
      ) {
        return {
          ...resolved,
          url: `${url}${url.includes('?') ? '&' : '?'}${EPOCH_KEY}=${reloadEpoch}`,
        };
      }
      return resolved;
    },
  });
}

/** One-time-honest flag for the entry-only fallback on old Nodes. */
let warnedEntryOnly = false;

/** TypeScript extensions Node can only import with type stripping. */
const TYPE_SCRIPT_EXT = /\.(?:mts|cts|ts)$/;

/** The flags that turn type stripping on where it is not the default. */
const STRIP_FLAGS = ['--experimental-strip-types', '--experimental-transform-types'];

/**
 * True when this Node imports `.ts`/`.mts`/`.cts` modules natively:
 * unflagged since 23.6 and 22.18, flag-gated from 22.6. Unparseable or
 * future version strings pass — Node's own error is clearer than ours.
 */
export function supportsTypeStripping(
  nodeVersion: string,
  execArgv: readonly string[] = [],
  nodeOptions: string = process.env.NODE_OPTIONS ?? ''
): boolean {
  const match = /^v?(\d+)\.(\d+)/.exec(nodeVersion);
  if (match === null) {
    return true;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major >= 24 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18)) {
    return true;
  }
  if ((major === 22 && minor < 6) || major < 22) {
    return false;
  }
  // 22.6–22.17 and 23.0–23.5: type stripping exists behind a flag.
  return [...execArgv, ...nodeOptions.split(/\s+/)].some((flag) =>
    STRIP_FLAGS.includes(flag)
  );
}

/** Fails fast with the remedy when a TypeScript entry can't run on this Node. */
function assertTypeScriptEntrySupported(entry: string): void {
  if (!TYPE_SCRIPT_EXT.test(entry)) {
    return;
  }
  if (supportsTypeStripping(process.version, process.execArgv)) {
    return;
  }
  throw new Error(
    `s200 dev: ${entry} is TypeScript, but Node ${process.version} can't import .ts files.\n` +
      `Use Node >= 22.18 (type stripping is on by default), or Node >= 22.6 launched with --experimental-strip-types.`
  );
}

/**
 * Runs the dev server for one entry: loads the app, serves the hot app
 * identity (one server for the whole session), and wires the watcher whose
 * reloads swap the route table in place. Returns the listening URL, the
 * adapter's server handle, and a `close()` that stops watcher then server.
 */
export async function runDev(
  argv: readonly string[],
  opts: RunDevOptions = {}
): Promise<DevServer> {
  const parsed = parseDevArgs(argv);
  assertTypeScriptEntrySupported(parsed.entry);
  const port = parsed.port ?? opts.port ?? Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0) {
    throw new Error(`s200 dev: invalid port "${String(port)}"\n${USAGE}`);
  }
  const baseLoader = opts.load ?? loadFromEntry(parsed.entry);
  const watchDirs = [dirname(resolve(parsed.entry)), ...(opts.watchDirs ?? [])];
  // Populate the graph roots before the first load so even the initial
  // import carries the epoch stamp — reloads then re-evaluate every module
  // under these roots, not just the entry.
  if (canBustGraph) {
    watchRoots.length = 0;
    for (const dir of watchDirs) {
      watchRoots.push(pathToFileURL(`${resolve(dir)}/`).href);
    }
  }
  const loader = async (): Promise<App> => {
    if (canBustGraph) {
      reloadEpoch += 1;
    } else if (!warnedEntryOnly) {
      warnedEntryOnly = true;
      console.error(
        `s200 dev: Node ${process.version} has no module.registerHooks — only the entry re-loads; restart s200 dev after editing modules it imports`
      );
    }
    return baseLoader();
  };

  const hot = createHotApp(await loader());
  const onReload = opts.onReload ?? defaultOnReload;
  // watchAndReload only knows `hot.reload` — hand it a wrapper so every
  // successful swap also reports through onReload (default: the log line).
  const reporting: HotApp = {
    app: hot.app,
    reload(next: App): void {
      hot.reload(next);
      onReload(next);
    },
  };

  const server = await serve(hot.app, { port });
  const watcher = (opts.watch ?? watchDefault)({
    dirs: watchDirs,
    hot: reporting,
    load: loader,
    onError: console.error,
  });

  return {
    url: new URL(server.url),
    server,
    async close(): Promise<void> {
      await watcher.close();
      await server.close();
    },
  };
}

/**
 * CLI entry point: `s200 dev [entry] [--port N]`. Rejects on bad argv
 * (usage text rides along in the message) and on a failing first load —
 * the self-run guard below maps rejections to a non-zero exit.
 */
export async function main(argv: readonly string[]): Promise<void> {
  const command = argv[0];
  if (command !== 'dev') {
    throw new Error(`s200 dev: unknown command "${command ?? '(none)'}"\n${USAGE}`);
  }
  const dev = await runDev(argv.slice(1));
  console.log(`s200 dev: listening on ${dev.url.href}`);
}

// Self-run when executed as the bin (`s200 dev …`). Same dual-format
// guard as executor-child: the CJS bundle replaces `import.meta` with
// `{}`, so fall back to `__filename` there. argv[1] is realpath'd before
// comparing because npm exposes the bin through a symlink while Node
// resolves this module to its real location.
declare const __filename: string | undefined;

/** True when this module is the process entry — the bin-execute guard. */
export function isMainEntry(argv1: string | undefined, selfUrl: string): boolean {
  if (argv1 === undefined) {
    return false;
  }
  let real: string;
  try {
    real = realpathSync(argv1);
  } catch {
    return false;
  }
  return pathToFileURL(real).href === selfUrl;
}

const SELF_URL: string =
  typeof __filename === 'string' ? pathToFileURL(__filename).href : import.meta.url;

if (isMainEntry(process.argv[1], SELF_URL)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
