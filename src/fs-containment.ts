/**
 * Internal filesystem layer shared by the adapters (`s200/node`,
 * `s200/bun`): the symlink-escape containment their
 * `createRealPathGuard`s run on (node's async `realpath`, Bun's sync
 * `realpathSync`), the miss-vs-failure error policy their file readers
 * share (`MISSING_FILE_CODES`, `missOrNull`), and the file-service
 * skeletons (`createFileReaderWith`/`createFileStatWith`/
 * `createFileRangeReaderWith`) the adapters' public factories delegate to
 * over injected runtime primitives (`FileIo`). NOT a public entry — the
 * barrel does not re-export this module; import it relatively from
 * within src.
 *
 * @internal
 */

import type { StaticFileInfo } from './static';

import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** fs error codes that mean "the path does not point at a readable file"
 * (missing entry, a non-directory segment, a directory itself) — the only
 * failures the adapters' file readers may translate into a miss (`null`).
 * Everything else (EACCES, EMFILE, …) still rejects so a real IO failure
 * is not masked as a 404.
 *
 * @internal
 */
export const MISSING_FILE_CODES: readonly string[] = [
  'ENOENT',
  'ENOTDIR',
  'EISDIR',
];

/** Lexical containment: is `absolute` `root` itself or below it? */
function isUnderRoot(root: string, absolute: string): boolean {
  const rel = relative(root, absolute);
  // `relative` climbs with '..'/'../…' exactly; a sibling name like '..x'
  // cannot climb and stays a legitimate in-root path.
  return (
    rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

/** The exact entry the adapter factories open: `join(root, path)` with an
 * absolute `path` appended (not re-rooted), made absolute for containment. */
function resolvedEntry(root: string, path: string): string {
  const joined = join(root, path);
  return isAbsolute(joined) ? joined : resolve(joined);
}

/**
 * Builds the {@link serveStatic} `realPath` injection around the caller's
 * realpath primitive (which MUST map unresolvable paths to `null`, never
 * reject) and an existence probe. The contract implemented here is shared
 * verbatim by `s200/node` and `s200/bun`:
 *
 * - the resolved real path when the entry exists and stays inside `root`;
 * - `null` when the entry exists but resolves outside `root` (a symlink
 *   pointing elsewhere) or when `root` itself is unresolvable;
 * - the resolved (possibly nonexistent) entry path when the entry is
 *   missing but its nearest existing ancestor is inside `root` — a miss is
 *   NOT an escape, so `serveStatic`'s directory-redirect/SPA fallbacks
 *   still run for it.
 *
 * The existence walk stops at an existing ancestor that resolves outside
 * the root, so an escaping symlinked directory cannot be re-authorized by
 * climbing past it. `exists` MUST answer `'missing'` only for a genuinely
 * absent entry (`ENOENT`/`ENOTDIR`) and `'exists'` for everything else —
 * dangling symlinks, permission errors, races — so the guard fails closed.
 * The root's own real path is resolved once and cached; an existing lookup
 * still costs one realpath call (the guard is opt-in).
 */
export function createRealPathGuardWith(
  root: string,
  realpath: (path: string) => Promise<string | null>,
  exists: (path: string) => Promise<'exists' | 'missing'>
): (path: string) => Promise<string | null> {
  const resolvedRoot = resolve(root);
  let rootReal: Promise<string | null> | undefined;
  return async (path: string): Promise<string | null> => {
    rootReal ??= realpath(resolvedRoot);
    const realRoot = await rootReal;
    if (realRoot === null) return null;
    // A target outside the root lexically is refused outright — never a
    // "miss" (an ancestor walk above the root must not authorize it).
    const absolute = resolvedEntry(root, path);
    if (!isUnderRoot(resolvedRoot, absolute)) return null;
    const real = await realpath(absolute);
    if (real !== null) return isUnderRoot(realRoot, real) ? real : null;
    // realpath refused the entry: if it exists at all, it is a symlink out
    // of the root (or one that cannot be resolved) — fail closed.
    if ((await exists(absolute)) === 'exists') return null;
    // Nothing at the target: walk to the nearest existing ancestor. An
    // in-root ancestor means a plain miss; one that exists but resolves
    // outside the root is an escape and stops the walk.
    for (let ancestor = dirname(absolute); ; ancestor = dirname(ancestor)) {
      if (!isUnderRoot(resolvedRoot, ancestor)) return null;
      if ((await exists(ancestor)) === 'missing') {
        if (dirname(ancestor) === ancestor) return null;
        continue;
      }
      const ancestorReal = await realpath(ancestor);
      return ancestorReal !== null && isUnderRoot(realRoot, ancestorReal)
        ? absolute
        : null;
    }
  };
}

/**
 * "Miss or throw": only the shared {@link MISSING_FILE_CODES} read as a
 * miss — anything else (EACCES, EMFILE, …) rethrows so a real IO failure
 * is not masked as a 404. The miss-vs-failure policy every adapter file
 * reader runs.
 *
 * @internal
 */
export const missOrNull = (error: unknown): null => {
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && MISSING_FILE_CODES.includes(code)) {
    return null;
  }
  throw error;
};

/**
 * Builds the containment guard's existence probe around the runtime's
 * lstat (node: async `lstat`; Bun: sync `lstatSync` wrapped in a
 * promise): only a genuinely absent entry (`ENOENT`/`ENOTDIR`) answers
 * `'missing'`; a dangling symlink or an unreadable path counts as
 * existing, so the guard fails closed instead of authorizing a miss.
 *
 * @internal
 */
export function existsWith(
  lstat: (path: string) => Promise<unknown>
): (path: string) => Promise<'exists' | 'missing'> {
  return async (path) => {
    try {
      await lstat(path);
      return 'exists';
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'exists';
    }
  };
}

/** Buffered-whole-file ceiling (16 MiB): files strictly larger stream
 * instead, so a huge asset cannot balloon memory by default — the shared
 * default of both adapters' readers, matching `serveStatic`'s streamed
 * path (with `stat` injected the response still carries
 * content-length/validators). */
const STREAM_THRESHOLD = 16 * 1024 * 1024;

/** The stat surface the shared readers need: response metadata plus the
 * directory test. Both runtimes' `Stats` satisfy it structurally. */
type FileStat = {
  readonly size: number;
  readonly mtimeMs: number;
  isDirectory(): boolean;
};

/**
 * The runtime primitives the shared file-service factories run on: an
 * adapter injects its own flavor (node's `node:fs/promises` reads,
 * Bun's `Bun.file` windows) and keeps its public factories as thin
 * wrappers. `createStream` owns the `{ stream: true }` precheck — the one
 * place the runtimes genuinely differ (node re-stats and rejects
 * unreadable files via `access(R_OK)`, reading every precheck failure as
 * a miss; Bun runs the shared stat policy and streams) — while
 * `createStreamUnchecked`/`createRangeStream` open blind, called only
 * after the skeleton's own `stat` already cleared the entry.
 *
 * @internal
 */
export type FileIo = {
  /** Stats an entry — size, mtimeMs, directory test — or throws. */
  readonly stat: (path: string) => Promise<FileStat>;
  /** Reads the whole file as bytes, or throws. */
  readonly readAll: (path: string) => Promise<Uint8Array>;
  /** Opens the always-stream route: the runtime's own precheck decides
   * the miss (`null`) — see the type docblock for the two flavors. */
  readonly createStream: (
    path: string
  ) => Promise<ReadableStream<Uint8Array> | null>;
  /** Opens a stream with no precheck — the size-threshold route. */
  readonly createStreamUnchecked: (path: string) => ReadableStream<Uint8Array>;
  /** Opens the `[start, end]` byte window — the Range route. */
  readonly createRangeStream: (
    path: string,
    start: number,
    end: number
  ) => ReadableStream<Uint8Array>;
  /** The adapter's symlink-escape guard (its public
   * `createRealPathGuard`). */
  readonly createGuard: (
    root: string
  ) => (path: string) => Promise<string | null>;
};

/**
 * The whole-file reader skeleton `s200/node` and `s200/bun` share:
 * containment first (the injected guard, skippable via
 * `realPath: false`), then stat — a directory reads as a miss, and only
 * {@link MISSING_FILE_CODES} miss while real IO failures rethrow
 * ({@link missOrNull}) — then buffered bytes below `streamThreshold`
 * (default 16 MiB) and a stream above it. `{ stream: true }` routes
 * through the injected {@link FileIo.createStream} instead, so each
 * runtime keeps its own always-stream precheck.
 *
 * @internal
 */
export function createFileReaderWith(
  root: string,
  io: FileIo,
  options: {
    readonly stream?: boolean;
    readonly realPath?: boolean;
    readonly streamThreshold?: number;
  } = {}
): (path: string) => Promise<Uint8Array | ReadableStream<Uint8Array> | null> {
  const stream = options.stream === true;
  const guard = options.realPath === false ? undefined : io.createGuard(root);
  const streamThreshold = options.streamThreshold ?? STREAM_THRESHOLD;
  return async (
    path: string
  ): Promise<Uint8Array | ReadableStream<Uint8Array> | null> => {
    if (guard !== undefined && (await guard(path)) === null) return null;
    const file = join(root, path);
    if (stream) return io.createStream(file);
    // Stat before reading: the size decides buffered vs streamed, and a
    // directory (or a race-deleted path) reads as a plain miss.
    let size: number;
    try {
      const info = await io.stat(file);
      if (info.isDirectory()) return null;
      size = info.size;
    } catch (error) {
      return missOrNull(error);
    }
    if (size > streamThreshold) return io.createStreamUnchecked(file);
    try {
      return await io.readAll(file);
    } catch (error) {
      return missOrNull(error);
    }
  };
}

/**
 * The `stat` injection skeleton both adapters share: containment guard →
 * size + mtimeMs metadata (powers ETag/Last-Modified/304 and
 * content-length for streamed responses). Directories read as missing —
 * the static layer handles them via its directory-index/redirect logic —
 * and a real path outside `root` (a symlink pointing elsewhere) reads as
 * missing too, so the `Range` path cannot stat its way around the guard.
 *
 * @internal
 */
export function createFileStatWith(
  root: string,
  io: FileIo
): (path: string) => Promise<StaticFileInfo | null> {
  const guard = io.createGuard(root);
  return async (path: string): Promise<StaticFileInfo | null> => {
    if ((await guard(path)) === null) return null;
    try {
      const info = await io.stat(join(root, path));
      if (info.isDirectory()) return null;
      return { size: info.size, mtimeMs: info.mtimeMs };
    } catch (error) {
      return missOrNull(error);
    }
  };
}

/**
 * The streamed byte-range skeleton both adapters share: containment
 * guard → directory check (a miss-or-throw stat) → the runtime's
 * `[start, end]` byte window, sliced without buffering the whole file —
 * the memory-safe Range path for large media. An escaping symlink or a
 * directory reads as missing instead of starting a `206` that then dies
 * mid-stream and resets the connection.
 *
 * @internal
 */
export function createFileRangeReaderWith(
  root: string,
  io: FileIo
): (
  path: string,
  start: number,
  end: number
) => Promise<ReadableStream<Uint8Array> | null> {
  const guard = io.createGuard(root);
  return async (
    path: string,
    start: number,
    end: number
  ): Promise<ReadableStream<Uint8Array> | null> => {
    if ((await guard(path)) === null) return null;
    const file = join(root, path);
    try {
      if ((await io.stat(file)).isDirectory()) return null;
    } catch (error) {
      return missOrNull(error);
    }
    return io.createRangeStream(file, start, end);
  };
}
