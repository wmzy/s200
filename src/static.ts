import type { Ctx, Middleware } from './types';

import { send } from './respond';
import { contentTypeFor } from './mime';

export type ServeStaticOptions = {
  read: (path: string) => Promise<Uint8Array | null>; // null = missing
  root?: string; // '' default; joined with the request path POSIX-style
  prefix?: string; // e.g. '/static' — stripped before lookup
  index?: string; // default 'index.html', appended to directory lookups
  spa?: boolean | string; // true → 'index.html'; GET+text/html fallback file
  /**
   * Dotfile policy for request paths (`.env`, `.git/…`): `'deny'` (default)
   * falls through to next() so no hidden file is ever served; `'allow'`
   * serves them like any other path. The `root`/`spa` paths are user
   * configuration, not request input, and are exempt.
   */
  dotfiles?: 'deny' | 'allow';
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

/**
 * Detects dotfile segments in a request path: any percent-decoded segment
 * starting with '.' (`.env`, `.git/…`). '.'/'..' segments are traversal,
 * handled by {@link resolveUnderRoot}; a malformed escape is reported as a
 * dotfile so the deny policy fails closed even before resolution.
 */
function hasDotfileSegment(path: string): boolean {
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return true;
    }
    if (decoded.startsWith('.')) return true;
  }
  return false;
}

/** A parsed single byte-range, or `null` when unsatisfiable. */
type ByteRange = { start: number; end: number };

/**
 * Parses a single `bytes=start-end` Range header against a representation
 * length. Returns `undefined` when the header is absent, malformed, or
 * multi-range (the caller serves the full body — RFC 9110 permits ignoring
 * Range); `null` when syntactically valid but unsatisfiable (the caller
 * answers 416); otherwise the clamped `[start, end]` window.
 */
function parseByteRange(header: string, length: number): ByteRange | null | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return undefined;
  const startText = match[1];
  const endText = match[2];
  if (startText === undefined || endText === undefined) return undefined;
  if (startText === '' && endText === '') return undefined;
  if (startText === '') {
    // Suffix range: the last N bytes. 0 asks for nothing (unsatisfiable);
    // an over-long suffix degrades to the whole representation.
    const suffix = Number(endText);
    if (suffix === 0) return null;
    if (length === 0) return null;
    const start = Math.max(0, length - suffix);
    return { start, end: length - 1 };
  }
  const start = Number(startText);
  if (!Number.isSafeInteger(start)) return undefined;
  if (endText === '') {
    if (start >= length) return null;
    return { start, end: length - 1 };
  }
  const end = Number(endText);
  if (!Number.isSafeInteger(end)) return undefined;
  if (start > end) return undefined; // inverted window: treat as no Range
  if (start >= length) return null;
  return { start, end: Math.min(end, length - 1) };
}

/**
 * Sends file bytes, honoring a single `Range` request with 206/416 — video
 * seeking works, and HEAD stays bodyless with `accept-ranges` advertised.
 */
function serveBytes(
  ctx: Ctx,
  method: string,
  bytes: Uint8Array,
  path: string,
  rangeHeader: string | null
): void {
  const contentType = contentTypeFor(path);
  if (method === 'HEAD') {
    send(ctx, bytes, { headers: { 'content-type': contentType, 'accept-ranges': 'bytes' } });
    return;
  }
  const range =
    rangeHeader === null ? undefined : parseByteRange(rangeHeader, bytes.byteLength);
  if (range === undefined) {
    send(ctx, bytes, { headers: { 'content-type': contentType, 'accept-ranges': 'bytes' } });
    return;
  }
  if (range === null) {
    send(ctx, null, {
      status: 416,
      headers: { 'content-range': `bytes */${bytes.byteLength}` },
    });
    return;
  }
  send(ctx, bytes.subarray(range.start, range.end + 1), {
    status: 206,
    headers: {
      'content-type': contentType,
      'content-range': `bytes ${range.start}-${range.end}/${bytes.byteLength}`,
      'accept-ranges': 'bytes',
    },
  });
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

    // Hidden files are refused by default — the request path is the only
    // input that decides, so '.env' or '.git/config' can never leave the
    // process even when they sit inside the served root.
    if (options.dotfiles !== 'allow' && hasDotfileSegment(rest)) return next();

    let lookup = resolveUnderRoot(root, rest);
    if (lookup === undefined) return next();
    if (rest.endsWith('/')) lookup = lookup === '' ? index : `${lookup}/${index}`;

    const bytes = await read(lookup);
    if (bytes !== null) {
      serveBytes(ctx, method, bytes, lookup, ctx.req.headers.get('range'));
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
