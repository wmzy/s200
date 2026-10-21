/**
 * The `s200` CLI: `s200 dev` runs the dev server — one HTTP server identity
 * for the whole session; reloads swap the app's route table atomically (see
 * {@link createHotApp}), so in-flight requests finish on the old chain
 * while new requests hit the fresh table. No restart, no port churn.
 * `s200 routes` and `s200 codegen` are one-shot table inspections.
 *
 * This module is pure wiring over four batteries — `s200/dev` (identity +
 * swap + watch + hints/overlay), `s200/node` (`serve`), `s200/route-table`
 * and `s200/codegen` — plus argv parsers. The `load` and `watch` seams
 * keep the runner testable without a filesystem: tests inject an in-memory
 * app factory and a stub watcher.
 *
 * @module
 */

import type { App } from './app';
import type { DevEvent, DevEventBus, HotApp, WatchAndReloadHandle } from './dev';

import * as nodeModule from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  createDevEventBus,
  createHotApp,
  importFresh,
  watchAndReload,
  withDevOverlay,
  withRouteHints,
} from './dev';
import { serve } from './node';
import { generateClient } from './codegen';
import { createRouteTable, formatRouteTable } from './route-table';

const USAGE = `usage: s200 <command> [args]

commands:
  dev <entry> [--port N] [--host H] [--watch DIR] [--env-file FILE]
             [--no-hints] [--overlay]                     dev server with hot reload
  routes <entry> [--json]                            print the route table
  codegen <entry> [--out file] [--name X] [--base-url U]
                                                    print a typed client module

dev options:
  entry     app module exporting the app as default or as a named export "app"
            (default ./app.ts)
  --port    listen port (default $PORT or 3000; 0 picks a free port)
  --host    listen host (default: all interfaces)
  --watch   extra directory to watch for reloads (repeatable; the entry's
            directory is always watched)
  --env-file  dotenv-style file loaded into process.env before the entry
            loads (repeatable; overrides existing variables, like node
            --env-file)
  --no-hints   disable the 404 route-hints middleware (on by default)
  --overlay    enable the browser error overlay (off by default)

Every command loads its entry with the same convention (default export or a
named export "app"; default ./app.ts). TypeScript entries need Node >= 22.18
(or >= 22.6 with --experimental-strip-types).`;

/** Parsed `s200 dev` arguments — `port`/`hints`/`overlay`/`host` are
 * `undefined` when their flags are absent, so an embedding `runDev` call
 * can supply its own defaults; `watch`/`envFiles` collect their repeatable
 * flags in argv order (empty arrays when absent). */
export type DevArgs = {
  readonly entry: string;
  readonly port: number | undefined;
  readonly hints: boolean | undefined;
  readonly overlay: boolean | undefined;
  readonly host: string | undefined;
  readonly watch: readonly string[];
  readonly envFiles: readonly string[];
};

/** The argv grammar of `s200 dev`: `[entry] [--port N] [--host H]
 * [--watch DIR] [--env-file FILE] [--no-hints] [--overlay]` — value flags
 * take both `--flag value` and `--flag=value`, `--watch`/`--env-file`
 * repeat. Throws on anything else, with the usage text in the message. */
export function parseDevArgs(argv: readonly string[]): DevArgs {
  let entry: string | undefined;
  let port: number | undefined;
  let hints: boolean | undefined;
  let overlay: boolean | undefined;
  let host: string | undefined;
  const watch: string[] = [];
  const envFiles: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const flagValue = (): string => {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error(`s200 dev: ${arg} requires a value\n${USAGE}`);
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
    } else if (arg === '--no-hints') {
      hints = false;
    } else if (arg === '--overlay') {
      overlay = true;
    } else if (arg === '--host') {
      host = flagValue();
      i += 1;
    } else if (arg.startsWith('--host=')) {
      host = arg.slice('--host='.length);
    } else if (arg === '--watch') {
      watch.push(flagValue());
      i += 1;
    } else if (arg.startsWith('--watch=')) {
      watch.push(arg.slice('--watch='.length));
    } else if (arg === '--env-file') {
      envFiles.push(flagValue());
      i += 1;
    } else if (arg.startsWith('--env-file=')) {
      envFiles.push(arg.slice('--env-file='.length));
    } else if (arg.startsWith('--')) {
      throw new Error(`s200 dev: unknown option "${arg}"\n${USAGE}`);
    } else if (entry !== undefined) {
      throw new Error(`s200 dev: unexpected argument "${arg}"\n${USAGE}`);
    } else {
      entry = arg;
    }
  }
  return { entry: entry ?? './app.ts', port, hints, overlay, host, watch, envFiles };
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
  /** Listen host override — the `--host` flag wins over this. */
  readonly host?: string;
  /** Extra directories to watch in addition to the entry's directory. */
  readonly watchDirs?: readonly string[];
  /** Reload observer; the default logs one `reloaded (N routes)` line. */
  readonly onReload?: (app: App) => void;
  /** Watch seam — `watchAndReload` in production, a stub in tests. */
  readonly watch?: (options: WatchOptions) => WatchAndReloadHandle;
  /** 404 route hints on by default; `--no-hints` turns them off. */
  readonly hints?: boolean;
  /** Browser error overlay (`--overlay`), off by default. */
  readonly overlay?: boolean;
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
 * Parses one dotenv-style file body into key/value pairs: `KEY=VALUE`
 * lines with surrounding whitespace trimmed, `#` comments and blank lines
 * skipped, matching single- or double-quoted values unquoted. Lines
 * without a `=` (or with an empty key) are skipped, dotenv-style.
 */
function parseEnvSource(source: string): readonly (readonly [string, string])[] {
  const pairs: [string, string][] = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    pairs.push([key, value]);
  }
  return pairs;
}

/**
 * Loads `--env-file` files into `process.env` BEFORE the entry module
 * graph is imported — callers place it ahead of the first `load()`. A
 * missing/unreadable file is a hard error naming the path. Loaded values
 * OVERRIDE variables already present in `process.env` — the same
 * precedence as `node --env-file`.
 */
function loadEnvFiles(paths: readonly string[]): void {
  for (const file of paths) {
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      throw new Error(`s200 dev: --env-file: cannot read "${file}"\n${USAGE}`);
    }
    for (const [key, value] of parseEnvSource(source)) {
      process.env[key] = value;
    }
  }
}

/**
 * Runs the dev server for one entry: loads the app, serves the hot app
 * on one server identity, and reloads the table on watch events — all dev
 * extras (hints, overlay) as derived copies, so the user's app data is
 * never mutated. Returns the listening URL, the adapter's server handle,
 * and a `close()` that stops watcher then server.
 */
export async function runDev(
  argv: readonly string[],
  opts: RunDevOptions = {}
): Promise<DevServer> {
  const parsed = parseDevArgs(argv);
  // Env files first: they must be populated before ANY entry code runs —
  // the graph below (loader, watchers) imports the entry afterwards.
  loadEnvFiles(parsed.envFiles);
  assertTypeScriptEntrySupported(parsed.entry);
  const port = parsed.port ?? opts.port ?? Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0) {
    throw new Error(`s200 dev: invalid port "${String(port)}"\n${USAGE}`);
  }
  const host = parsed.host ?? opts.host;
  const hints = parsed.hints ?? opts.hints ?? true;
  const overlay = parsed.overlay ?? opts.overlay ?? false;
  const baseLoader = opts.load ?? loadFromEntry(parsed.entry);
  const watchDirs = [
    dirname(resolve(parsed.entry)),
    ...(opts.watchDirs ?? []),
    ...parsed.watch,
  ];
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

  const first = await loader();
  const hot = createHotApp(first);
  // Startup report: the aligned table (registration order) after a count
  // line — reloads keep the one-line count (see defaultOnReload).
  const table = createRouteTable(first);
  console.log(`s200 dev: ${table.routes.length} routes`);
  if (table.routes.length > 0) {
    console.log(formatRouteTable(table));
  }
  // Dev extras wrap every loaded table WITHOUT touching the user's app
  // data: each load yields a derived copy (see withRouteHints and
  // withDevOverlay), and the live hot identity stays the only object the
  // runner mutates — through hot.reload, as before. routeHints closes over
  // the live app, so reloads need no re-registration of anything.
  const bus: DevEventBus | undefined = overlay ? createDevEventBus() : undefined;
  const decorate = (userApp: App): App => {
    let decorated = userApp;
    if (hints) {
      decorated = withRouteHints(decorated, hot.app);
    }
    if (bus !== undefined) {
      decorated = withDevOverlay(decorated, bus);
    }
    return decorated;
  };
  const decoratedFirst = decorate(first);
  if (decoratedFirst !== first) {
    hot.reload(decoratedFirst);
  }

  const onReload = opts.onReload ?? defaultOnReload;
  const reportError = (error: unknown): void => {
    console.error(error);
    bus?.publish(devErrorOf(error));
  };
  // watchAndReload only knows `hot.reload` — hand it a wrapper so every
  // successful swap also reports through onReload (default: the log line)
  // and tells the overlay's browsers to reload.
  const reporting: HotApp = {
    app: hot.app,
    reload(next: App): void {
      hot.reload(decorate(next));
      onReload(next);
      bus?.publish({ type: 'reload' });
    },
  };

  const server = await serve(hot.app, { port, host });
  const watcher = (opts.watch ?? watchDefault)({
    dirs: watchDirs,
    hot: reporting,
    load: loader,
    onError: reportError,
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

/** Shapes any thrown value into the overlay's `error` event. */
const devErrorOf = (error: unknown): DevEvent =>
  error instanceof Error
    ? { type: 'error', message: error.message, stack: error.stack }
    : { type: 'error', message: String(error) };

/** Parsed `s200 routes` arguments. */
export type RoutesArgs = {
  readonly entry: string;
  readonly json: boolean;
};

/** The argv grammar of `s200 routes`: `[entry] [--json]`. Throws on
 * anything else, with the usage text in the message. */
export function parseRoutesArgs(argv: readonly string[]): RoutesArgs {
  let entry: string | undefined;
  let json = false;
  for (const arg of argv) {
    if (arg === '--json') {
      json = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`s200 routes: unknown option "${arg}"\n${USAGE}`);
    } else if (entry !== undefined) {
      throw new Error(`s200 routes: unexpected argument "${arg}"\n${USAGE}`);
    } else {
      entry = arg;
    }
  }
  return { entry: entry ?? './app.ts', json };
}

/**
 * `s200 routes [entry] [--json]`: loads the entry once (the same loader
 * and TypeScript floor as `s200 dev`) and prints the route table — aligned
 * `METHOD  PATTERN` lines in registration order, or the full serializable
 * table with `--json`.
 */
export async function runRoutes(argv: readonly string[]): Promise<void> {
  const args = parseRoutesArgs(argv);
  const app = await loadAppFromEntry(args.entry);
  const table = createRouteTable(app);
  if (args.json) {
    console.log(JSON.stringify(table, null, 2));
    return;
  }
  console.log(table.routes.length > 0 ? formatRouteTable(table) : '(no routes)');
}

/** Parsed `s200 codegen` arguments — `undefined` means the flag was absent. */
export type CodegenArgs = {
  readonly entry: string;
  readonly out: string | undefined;
  readonly name: string | undefined;
  readonly baseUrl: string | undefined;
};

/** The argv grammar of `s200 codegen`: `[entry] [--out file] [--name X]
 * [--base-url U]` (both spellings, `--flag value` and `--flag=value`).
 * Throws on anything else, with the usage text in the message. */
export function parseCodegenArgs(argv: readonly string[]): CodegenArgs {
  let entry: string | undefined;
  let out: string | undefined;
  let name: string | undefined;
  let baseUrl: string | undefined;
  const flagValue = (flag: string, raw: string | undefined): string => {
    if (raw === undefined) {
      throw new Error(`s200 codegen: ${flag} requires a value\n${USAGE}`);
    }
    return raw;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--out') {
      out = flagValue(arg, argv[++i]);
    } else if (arg.startsWith('--out=')) {
      out = arg.slice('--out='.length);
    } else if (arg === '--name') {
      name = flagValue(arg, argv[++i]);
    } else if (arg.startsWith('--name=')) {
      name = arg.slice('--name='.length);
    } else if (arg === '--base-url') {
      baseUrl = flagValue(arg, argv[++i]);
    } else if (arg.startsWith('--base-url=')) {
      baseUrl = arg.slice('--base-url='.length);
    } else if (arg.startsWith('--')) {
      throw new Error(`s200 codegen: unknown option "${arg}"\n${USAGE}`);
    } else if (entry !== undefined) {
      throw new Error(`s200 codegen: unexpected argument "${arg}"\n${USAGE}`);
    } else {
      entry = arg;
    }
  }
  return { entry: entry ?? './app.ts', out, name, baseUrl };
}

/**
 * `s200 codegen [entry] [--out file] [--name X] [--base-url U]`: loads the
 * entry once (the same loader and TypeScript floor as `s200 dev`) and
 * writes the `generateClient` module to stdout, or to `--out` (with a
 * trailing newline).
 */
export async function runCodegen(argv: readonly string[]): Promise<void> {
  const args = parseCodegenArgs(argv);
  const app = await loadAppFromEntry(args.entry);
  const source = generateClient(app, {
    ...(args.name === undefined ? {} : { name: args.name }),
    ...(args.baseUrl === undefined ? {} : { baseUrl: args.baseUrl }),
  });
  if (args.out === undefined) {
    console.log(source);
    return;
  }
  const file = resolve(args.out);
  await writeFile(file, `${source}${source.endsWith('\n') ? '' : '\n'}`, 'utf8');
  console.log(`s200 codegen: wrote ${file}`);
}

/** One fresh load of an entry: the TypeScript floor first (the remedy is
 * clearer than Node's module error), then `importFresh` + the export
 * convention. Shared by every non-dev command. */
const loadAppFromEntry = async (entry: string): Promise<App> => {
  assertTypeScriptEntrySupported(entry);
  return appFromModule(entry, await importFresh(entry));
};

/**
 * CLI entry point: `s200 dev`, `s200 routes`, `s200 codegen`. Rejects on
 * an unknown command (listing every command) and on bad argv (usage text
 * rides along in the message); the self-run guard below maps rejections
 * to a non-zero exit.
 */
export async function main(argv: readonly string[]): Promise<void> {
  const command = argv[0];
  if (command === 'dev') {
    const dev = await runDev(argv.slice(1));
    console.log(`s200 dev: listening on ${dev.url.href}`);
    return;
  }
  if (command === 'routes') {
    await runRoutes(argv.slice(1));
    return;
  }
  if (command === 'codegen') {
    await runCodegen(argv.slice(1));
    return;
  }
  throw new Error(
    `s200: unknown command "${command ?? '(none)'}" — available commands: dev, routes, codegen\n${USAGE}`
  );
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
