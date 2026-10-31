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
  appendQueryPair,
  createDevEventBus,
  createHotApp,
  importFresh,
  watchAndReload,
  withDevOverlay,
  withRouteHints,
} from './dev';
import { serve } from './node';
import { generateClient } from './codegen';
import { parseEnv } from './config';
import { messageOf } from './errors';
import { createRouteTable, formatRouteTable } from './route-table';
import { selfUrlOf } from './self-url';

const USAGE = `usage: s200 <command> [args]

commands:
  dev <entry> [--port N] [--host H] [--watch DIR] [--env-file FILE]
             [--no-hints] [--overlay]                     dev server with hot reload
  routes <entry> [--json]                            print the route table
  codegen <entry> [--out file] [--name X] [--base-url U]
                                                    print a typed client module

dev options:
  entry     app module exporting the app as a named export "app", as
            default, or via a createApp() call (default ./app.ts)
  --port    listen port (default $PORT or 3000; 0 picks a free port)
  --host    listen host (default: all interfaces)
  --watch   extra directory to watch for reloads (repeatable; the entry's
            directory is always watched)
  --env-file  dotenv-style file loaded into process.env before the entry
            loads (repeatable; existing environment variables win, like
            node --env-file)
  --no-hints   disable the 404 route-hints middleware (on by default)
  --overlay    enable the browser error overlay (off by default)

Every command loads its entry with the same convention as the shard executor (a
named export "app", a default export, or a createApp() call; default
./app.ts). TypeScript entries need Node >= 22.18
(or >= 22.6 with --experimental-strip-types).
dev retries imports that fail to resolve as written with a .ts suffix, so
source layouts keep extensionless relative imports.`;

// --- Shared argv grammar -----------------------------------------------------
//
// Every command's parser is the same loop over a flag table — one optional
// positional entry defaulting to ./app.ts, value flags taking both
// `--flag value` and `--flag=value` spellings, repeatable flags collecting
// in argv order — plus the same three errors (unknown option, unexpected
// argument, missing value), each carrying the usage text. The tables below
// ARE each command's grammar; the loop is written once.

/** One row of a command's flag table. `value` keeps the last hit (flags
 * may repeat), `repeat` collects every hit in argv order, `switch` is a
 * bare flag whose presence the caller maps onto its result field. */
type ArgFlag = {
  readonly flag: string;
  readonly kind: 'value' | 'repeat' | 'switch';
  /** Value validation/coercion (`--port` range check); absent = raw string. */
  readonly check?: (raw: string) => unknown;
};

/** What {@link parseCommandArgs} hands back: the entry plus per-flag
 * results keyed by exact flag spelling. */
type ParsedArgs = {
  readonly entry: string;
  readonly values: Record<string, unknown>;
  readonly lists: Record<string, string[]>;
  readonly switches: Record<string, boolean>;
};

/** The one argv loop behind `parseDevArgs`/`parseRoutesArgs`/
 * `parseCodegenArgs`. Throws with the usage text on anything off-grammar,
 * exactly like the per-command parsers it replaced. */
function parseCommandArgs(
  command: string,
  argv: readonly string[],
  flags: readonly ArgFlag[]
): ParsedArgs {
  const values: Record<string, unknown> = {};
  const lists: Record<string, string[]> = {};
  const switches: Record<string, boolean> = {};
  let entry: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    // Switches have no `=` spelling — `--json=x` stays an unknown option.
    const spec = flags.find(
      (flag) =>
        arg === flag.flag ||
        (flag.kind !== 'switch' && arg.startsWith(flag.flag + '='))
    );
    if (spec === undefined) {
      if (arg.startsWith('--')) {
        throw new Error(`s200 ${command}: unknown option "${arg}"\n${USAGE}`);
      }
      if (entry !== undefined) {
        throw new Error(`s200 ${command}: unexpected argument "${arg}"\n${USAGE}`);
      }
      entry = arg;
      continue;
    }
    if (spec.kind === 'switch') {
      switches[spec.flag] = true;
      continue;
    }
    // Both spellings funnel here: the inline `=` value, else the next
    // token — whatever it looks like, the original parsers consumed it.
    const inline = arg.startsWith(spec.flag + '=') ? arg.slice(spec.flag.length + 1) : undefined;
    const raw = inline ?? argv[i + 1];
    if (raw === undefined) {
      throw new Error(`s200 ${command}: ${arg} requires a value\n${USAGE}`);
    }
    if (inline === undefined) {
      i += 1;
    }
    const value = spec.check === undefined ? raw : spec.check(raw);
    if (spec.kind === 'repeat') {
      (lists[spec.flag] ??= []).push(value as string);
    } else {
      values[spec.flag] = value;
    }
  }
  return { entry: entry ?? './app.ts', values, lists, switches };
}

/**
 * The port floor shared by the `--port` flag and the env/opts default:
 * integral, 0–65535 (0 = free port). Without the ceiling here, a
 * `PORT=70000` would reach `server.listen` and die on Node's opaque
 * `ERR_SOCKET_BAD_PORT` instead of this usage error.
 */
function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`s200 dev: invalid port "${String(port)}"\n${USAGE}`);
  }
}

/** The `s200 dev --port` value check: integral, 0–65535 (0 = free port). */
const portOf = (raw: string): number => {
  const parsed = Number(raw);
  assertPort(parsed);
  return parsed;
};

/** The `s200 dev` flag table. */
const DEV_FLAGS: readonly ArgFlag[] = [
  { flag: '--port', kind: 'value', check: portOf },
  { flag: '--no-hints', kind: 'switch' },
  { flag: '--overlay', kind: 'switch' },
  { flag: '--host', kind: 'value' },
  { flag: '--watch', kind: 'repeat' },
  { flag: '--env-file', kind: 'repeat' },
];

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
  const { entry, values, lists, switches } = parseCommandArgs('dev', argv, DEV_FLAGS);
  return {
    entry,
    port: values['--port'] as number | undefined,
    hints: switches['--no-hints'] === true ? false : undefined,
    overlay: switches['--overlay'],
    host: values['--host'] as string | undefined,
    watch: lists['--watch'] ?? [],
    envFiles: lists['--env-file'] ?? [],
  };
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

/** Extracts the app a dev entry exports — the same convention the shard
 * executor's `appFromEntry` speaks (USAGE promises "the same
 * convention"): named `app`, then `default`, then calling `createApp()`.
 * Keep in sync with executor-child.ts's copy (link-time isolation keeps
 * that one local). */
async function appFromModule(entry: string, mod: unknown): Promise<App> {
  const record = mod as { app?: unknown; default?: unknown; createApp?: () => unknown };
  const candidate =
    record.app ??
    record.default ??
    (typeof record.createApp === 'function' ? await record.createApp() : undefined);
  if (isApp(candidate)) {
    return candidate;
  }
  throw new Error(
    `s200 dev: ${entry} exports no app — export it as a named export "app", as default, or via createApp()`
  );
}

/** The default loader: re-imports the entry bypassing the ESM cache and
 * applies the export convention above. */
const loadFromEntry =
  (entry: string) =>
  async (): Promise<App> =>
    await appFromModule(entry, await importFresh(entry));

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
// re-evaluates the whole project graph. The roots and the epoch counter
// live in each `runDev` call's closure: every server registers its own
// resolve hook before its first load and deregisters it on close (or on a
// failed boot), so repeat or concurrent `runDev` calls never share — or
// stomp — stamping state. Older Nodes degrade honestly: entry-only
// reloads plus a one-time warning.

/** Query key carrying the reload epoch through module URLs. */
const EPOCH_KEY = 's200epoch';

/** True when this Node offers `module.registerHooks` (>= 22.15). */
const canBustGraph = typeof nodeModule.registerHooks === 'function';

/**
 * The epoch-stamped URL for one resolved module URL, or `undefined` when
 * it must keep its plain URL. Only file URLs under one of `roots` are
 * re-evaluated; `node_modules` never is — the watcher ignores it, and
 * stamping would re-evaluate (and re-instantiate) every dependency on
 * each reload. An already-stamped URL is left alone so a resolution pass
 * cannot stamp twice. Pure: the caller owns `roots` and `epoch` — no
 * module state is read (each `runDev` call closes over its own pair).
 */
export function stampGraphUrl(
  url: string,
  roots: readonly string[] = [],
  epoch = 0
): string | undefined {
  if (
    !url.startsWith('file:') ||
    url.includes(`${EPOCH_KEY}=`) ||
    url.includes('/node_modules/') ||
    !roots.some((root) => url.startsWith(root))
  ) {
    return undefined;
  }
  return appendQueryPair(url, EPOCH_KEY, epoch);
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
 * Loads `--env-file` files into `process.env` BEFORE the entry module
 * graph is imported — callers place it ahead of the first `load()`. A
 * missing/unreadable file is a hard error naming the path. Parsing is
 * {@link parseEnv} in lenient mode — dotenv files are user-authored, so a
 * malformed line (no `=`, bad key, unterminated quote) skips itself
 * instead of killing the dev server, while the strict syntax (export
 * prefixes, escapes, trailing comments) still applies. Variables already
 * present in `process.env` WIN over the file — the same precedence as
 * `node --env-file` (`--env-file-if-exists` aside): the ambient
 * environment is never overwritten by a dotenv file.
 */
function loadEnvFiles(paths: readonly string[]): void {
  for (const file of paths) {
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      throw new Error(`s200 dev: --env-file: cannot read "${file}"\n${USAGE}`);
    }
    // parseEnv resolves duplicate keys within one file last-wins; across
    // files the first file still wins (the `hasOwn` guard below) — the
    // ambient environment above both.
    for (const [key, value] of Object.entries(parseEnv(source, { lenient: true }))) {
      // Prototype-safe: `Object.hasOwn`, not a truthiness/`in` check.
      if (!Object.hasOwn(process.env, key)) {
        process.env[key] = value;
      }
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
  assertPort(port);
  const host = parsed.host ?? opts.host;
  const hints = parsed.hints ?? opts.hints ?? true;
  const overlay = parsed.overlay ?? opts.overlay ?? false;
  const baseLoader = opts.load ?? loadFromEntry(parsed.entry);
  const watchDirs = [
    dirname(resolve(parsed.entry)),
    ...(opts.watchDirs ?? []),
    ...parsed.watch,
  ];
  // Graph-busting state is THIS call's closure: the server's own roots
  // and its own epoch counter. The resolve hook below is registered per
  // call — before the first load, so even the initial import carries the
  // epoch stamp and reloads re-evaluate every module under these roots,
  // not just the entry — and deregistered in close(); a failed boot
  // deregisters too, because a leaked hook would keep stamping with this
  // call's frozen epoch and shadow later servers' stamps. Repeat or
  // concurrent runDev calls therefore never share stamping state (the
  // old module-level roots/epoch pair was last-writer-wins).
  const watchRoots = canBustGraph
    ? watchDirs.map((dir) => pathToFileURL(`${resolve(dir)}/`).href)
    : [];
  let reloadEpoch = 0;
  const graphHooks = canBustGraph
    ? nodeModule.registerHooks({
        resolve(specifier, context, nextResolve) {
          // Plain resolution first — explicit-extension layouts (the
          // published package) never hit the fallback. Only a specifier
          // that would fail outright is retried with a `.ts` suffix, the
          // same extensionless-relative-import fallback the shard
          // executor's child realms install (`installShardResolution`),
          // so source layouts keep working without explicit extensions
          // everywhere.
          let resolved: nodeModule.ResolveFnOutput;
          try {
            resolved = nextResolve(specifier, context);
          } catch {
            resolved = nextResolve(specifier + '.ts', context);
          }
          const stamped = stampGraphUrl(resolved.url, watchRoots, reloadEpoch);
          return stamped === undefined ? resolved : { ...resolved, url: stamped };
        },
      })
    : undefined;
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

  try {
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
        graphHooks?.deregister();
      },
    };
  } catch (error) {
    // A failed boot must not leave its stamping hook behind: it would keep
    // resolving project modules with this call's frozen epoch and shadow
    // the next runDev call's stamps.
    graphHooks?.deregister();
    throw error;
  }
}

/** Shapes any thrown value into the overlay's `error` event. The message
 * goes through the shared `messageOf` extraction (`./errors` — one policy
 * with health's failure reasons); the `instanceof` arm exists only to
 * carry `stack`, which plain thrown values lack. */
const devErrorOf = (error: unknown): DevEvent =>
  error instanceof Error
    ? { type: 'error', message: messageOf(error), stack: error.stack }
    : { type: 'error', message: messageOf(error) };

/** Parsed `s200 routes` arguments. */
export type RoutesArgs = {
  readonly entry: string;
  readonly json: boolean;
};

/** The `s200 routes` flag table. */
const ROUTES_FLAGS: readonly ArgFlag[] = [{ flag: '--json', kind: 'switch' }];

/** The argv grammar of `s200 routes`: `[entry] [--json]`. Throws on
 * anything else, with the usage text in the message. */
export function parseRoutesArgs(argv: readonly string[]): RoutesArgs {
  const { entry, switches } = parseCommandArgs('routes', argv, ROUTES_FLAGS);
  return { entry, json: switches['--json'] === true };
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

/** The `s200 codegen` flag table. */
const CODEGEN_FLAGS: readonly ArgFlag[] = [
  { flag: '--out', kind: 'value' },
  { flag: '--name', kind: 'value' },
  { flag: '--base-url', kind: 'value' },
];

/** The argv grammar of `s200 codegen`: `[entry] [--out file] [--name X]
 * [--base-url U]` (both spellings, `--flag value` and `--flag=value`).
 * Throws on anything else, with the usage text in the message. */
export function parseCodegenArgs(argv: readonly string[]): CodegenArgs {
  const { entry, values } = parseCommandArgs('codegen', argv, CODEGEN_FLAGS);
  return {
    entry,
    out: values['--out'] as string | undefined,
    name: values['--name'] as string | undefined,
    baseUrl: values['--base-url'] as string | undefined,
  };
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
 * clearer than Node's module error), then the dev loader's exact body —
 * one load path, so dev and non-dev commands can never drift apart. */
const loadAppFromEntry = async (entry: string): Promise<App> => {
  assertTypeScriptEntrySupported(entry);
  return loadFromEntry(entry)();
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

// Self-run when executed as the bin (`s200 dev …`). The dual-format
// self-location guard is self-url.ts's (the canonical shape
// executor-child inlines); argv[1] is realpath'd before comparing
// because npm exposes the bin through a symlink while Node resolves this
// module to its real location.
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

const SELF_URL: string = selfUrlOf(
  typeof __filename === 'string' ? __filename : undefined,
  import.meta.url
);

if (isMainEntry(process.argv[1], SELF_URL)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
