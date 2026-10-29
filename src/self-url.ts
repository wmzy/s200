/**
 * Internal dual-format self-location helpers shared by the CLI bin
 * (`cli.ts`) and — as the canonical shape it inlines — the executor's
 * child-realms module (`executor-child.ts`), so no second copy of the
 * guard's rationale grows. `import.meta.url` survives the ESM bundle,
 * but the CJS output replaces `import.meta` with `{}` (its `.url` is
 * undefined — and an eager `fileURLToPath(undefined)` would throw on
 * `require`). In CJS, `__filename` is real at runtime and the typeof
 * guard means the ESM branch never evaluates; in ESM, `__filename` is
 * an undeclared global and `import.meta.url` is preserved. Either
 * format resolves the calling module.
 *
 * Callers keep their own `declare const __filename` and pass the
 * typeof-guarded value in — the location being resolved is the CALLING
 * module's: a shared chunk's own `__filename`/`import.meta.url` would
 * name the chunk instead (executor-child is merged into the
 * `s200/executor` entry in the published bundle, and child realms
 * re-import THAT URL as their runtime). For the same reason
 * executor-child cannot import this module at all: it must evaluate
 * under plain node as a forked shim main without touching relative
 * imports at link time, so it inlines the identical two-branch shape
 * with this comment as the canonical home. NOT a public entry — the
 * barrel does not re-export this module; import it relatively from
 * within src.
 *
 * @internal
 */

import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The calling module's own URL: its CJS filename as a file URL when the
 * caller was emitted as CJS (`cjsFilename` provided), its ESM module URL
 * otherwise.
 */
export function selfUrlOf(cjsFilename: string | undefined, esmUrl: string): string {
  return cjsFilename === undefined ? esmUrl : pathToFileURL(cjsFilename).href;
}

/**
 * The calling module's own path: its CJS filename when the caller was
 * emitted as CJS (`cjsFilename` provided), the flattened self URL
 * otherwise.
 */
export function selfPathOf(cjsFilename: string | undefined, selfUrl: string): string {
  return cjsFilename === undefined ? fileURLToPath(selfUrl) : cjsFilename;
}
