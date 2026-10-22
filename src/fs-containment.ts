/**
 * Internal symlink-escape containment shared by the filesystem adapters'
 * `createRealPathGuard`s (node's async `realpath`, Bun's sync
 * `realpathSync`). NOT a public entry — the barrel does not re-export this
 * module; import it relatively from within src.
 *
 * @internal
 */

import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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
