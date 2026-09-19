import type { Ctx, Middleware } from './types';

import { send } from './respond';
import { contentTypeFor } from './mime';

export type ServeStaticOptions = {
  read: (path: string) => Promise<Uint8Array | null>; // null = missing
  root?: string; // '' default; joined with the request path POSIX-style
  prefix?: string; // e.g. '/static' — stripped before lookup
  index?: string; // default 'index.html', appended to directory lookups
  spa?: boolean | string; // true → 'index.html'; GET+text/html fallback file
};

const DEFAULT_INDEX = 'index.html';

/**
 * Normalizes `path` (percent-decoding each segment so '%2e%2e' cannot sneak
 * past the guard) and joins it under `root` POSIX-style. Returns undefined
 * when a '..' segment would climb out of root — callers fall through to
 * next() instead of serving anything. Clients normally pre-normalize '..'
 * away, so a literal climb attempt is always crafted.
 */
function resolveUnderRoot(root: string, path: string): string | undefined {
  const stack: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    let part: string;
    try {
      part = decodeURIComponent(segment);
    } catch {
      return undefined; // malformed escape — no safe file name to look up
    }
    if (part === '..') {
      if (stack.length === 0) return undefined;
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  const base = root === '' ? [] : root.split('/').filter(Boolean);
  return [...base, ...stack].join('/');
}

function stripPrefix(pathname: string, prefix: string): string | undefined {
  if (prefix === '/' || prefix === '') return pathname;
  const withSlash = prefix.endsWith('/') ? prefix : `${prefix}/`;
  if (pathname === prefix) return '/';
  if (!pathname.startsWith(withSlash)) return undefined;
  const rest = pathname.slice(prefix.length);
  return rest.startsWith('/') ? rest : `/${rest}`;
}

export function serveStatic(options: ServeStaticOptions): Middleware {
  const read = options.read;
  const root = options.root ?? '';
  const rawPrefix = options.prefix;
  const prefix =
    rawPrefix === undefined || rawPrefix === ''
      ? undefined
      : rawPrefix.startsWith('/')
        ? rawPrefix
        : `/${rawPrefix}`;
  const index = options.index ?? DEFAULT_INDEX;
  const spaPath = options.spa === undefined ? undefined : options.spa === true ? index : options.spa;

  return async (ctx: Ctx, next) => {
    const method = ctx.req.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return next();

    const pathname = new URL(ctx.req.url).pathname;
    const rest = prefix === undefined ? pathname : stripPrefix(pathname, prefix);
    if (rest === undefined) return next();

    let lookup = resolveUnderRoot(root, rest);
    if (lookup === undefined) return next();
    if (rest.endsWith('/')) lookup = lookup === '' ? index : `${lookup}/${index}`;

    const bytes = await read(lookup);
    if (bytes !== null) {
      send(ctx, bytes, { headers: { 'content-type': contentTypeFor(lookup) } });
      return;
    }

    // SPA navigation fallback: a missing page + browser navigation (GET
    // accepting text/html) gets the app shell instead of a 404. API/asset
    // clients (json accept, HEAD) keep falling through.
    if (
      method === 'GET' &&
      spaPath !== undefined &&
      (ctx.req.headers.get('accept') ?? '').includes('text/html')
    ) {
      const shell = resolveUnderRoot(root, `/${spaPath}`);
      if (shell !== undefined) {
        const shellBytes = await read(shell);
        if (shellBytes !== null) {
          send(ctx, shellBytes, { headers: { 'content-type': contentTypeFor(shell) } });
          return;
        }
      }
    }

    return next();
  };
}
