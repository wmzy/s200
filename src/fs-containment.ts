/**
 * Internal symlink-escape containment shared by the filesystem adapters'
 * `createRealPathGuard`s (node's async `realpath`, Bun's sync
 * `realpathSync`). NOT a public entry — the barrel does not re-export this
 * module; import it relatively from within src.
 *
 * @internal
 */

import { isAbsolute, join, relative, resolve } from 'node:path';

/**
 * Builds the {@link serveStatic} `realPath` injection around the caller's
 * realpath primitive (which MUST map missing paths to `null`, never
 * reject): resolves the file's real path and returns `null` whenever it
 * does not exist or lands outside `root` — so a symlink inside the root
 * pointing elsewhere falls through instead of being served. The root's own
 * real path is resolved once and cached; each request still costs one
 * realpath call (the guard is opt-in). Lexical `..` checks hold without
 * it, but symlinks inside the root are trusted.
 */
export function createRealPathGuardWith(
  root: string,
  realpath: (path: string) => Promise<string | null>
): (path: string) => Promise<string | null> {
  const resolvedRoot = resolve(root);
  let rootReal: Promise<string | null> | undefined;
  return async (path: string): Promise<string | null> => {
    rootReal ??= realpath(resolvedRoot);
    const realRoot = await rootReal;
    if (realRoot === null) return null;
    const real = await realpath(join(resolvedRoot, path));
    if (real === null) return null;
    // relative(realRoot, real) climbs with '..'/'../…' exactly; a sibling
    // name like '..x' cannot climb and stays a legitimate in-root file.
    const rel = relative(realRoot, real);
    const within =
      rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel));
    return within ? real : null;
  };
}
