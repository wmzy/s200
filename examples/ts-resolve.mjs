/**
 * Smoke-test module resolution hook (node only).
 *
 * The examples' `app.ts` imports the public entry names (`s200`,
 * `s200/node`, `s200/jwt`, …) per the published package map — the honest
 * deliverable. Those names resolve to `dist/` which only exists after a
 * root build, so the smoke scripts register this hook first: it redirects
 * the public names to the workspace `src/` TypeScript entries and maps
 * extension-less relative imports (src's internal convention) to `.ts`
 * files. Node ≥ 22.15/23+ strips the types natively; Bun needs no hook.
 */
import { registerHooks } from 'node:module';

const SRC = new URL('../src/', import.meta.url);

const PKG_MAP = {
  s200: 'index.ts',
  's200/node': 'node.ts',
  's200/bun': 'bun.ts',
  's200/jwt': 'jwt.ts',
  's200/validate': 'validate.ts',
  's200/upload': 'upload.ts',
  's200/streaming': 'streaming.ts',
  's200/websocket': 'websocket.ts',
  's200/websocket/node': 'websocket-node.ts',
  's200/websocket/bun': 'websocket-bun.ts',
};

export function resolve(specifier, context, nextResolve) {
  const mapped = PKG_MAP[specifier];
  if (mapped !== undefined) {
    return { url: new URL(mapped, SRC).href, shortCircuit: true };
  }
  const relative = specifier.startsWith('./') || specifier.startsWith('../');
  if (relative && !/\.[cm]?[jt]s$/.test(specifier)) {
    try {
      return nextResolve(`${specifier}.ts`, context);
    } catch {
      /* fall through to the default resolution (and its error) */
    }
  }
  return nextResolve(specifier, context);
}

// registerHooks (node ≥ 22.15) runs the hook in-process. Smoke scripts call
// this module for its side effect — an `import '../ts-resolve.mjs'` before
// the first s200 import wires the redirection for the whole process.
registerHooks({ resolve });
