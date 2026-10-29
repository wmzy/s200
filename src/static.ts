import type { Ctx, Middleware } from './types';

import { redirect, send } from './respond';
import { contentTypeFor } from './mime';
import { etagMatches } from './etag';

/** File metadata the static layer needs for conditional requests/ranges. */
export type StaticFileInfo = {
  readonly size: number;
  readonly mtimeMs: number;
};

export type ServeStaticOptions = {
  /**
   * Reads a whole file: bytes, a stream, or `null` when missing. Streams
   * are served as-is (no buffering); byte readers additionally support
   * ranges via subarray.
   */
  read: (
    path: string
  ) => Promise<Uint8Array | ReadableStream<Uint8Array> | null>;
  /**
   * File metadata. Supplying it turns on conditional requests
   * (ETag/Last-Modified → 304) and content-length for streamed responses;
   * without it the layer cannot know either and skips them.
   */
  stat?: (path: string) => Promise<StaticFileInfo | null>;
  /**
   * Streams `[start, end]` (inclusive) of a file — the memory-safe Range
   * path for large files. Without it, range requests against byte readers
   * fall back to read + subarray.
   */
  readRange?: (
    path: string,
    start: number,
    end: number
  ) => Promise<ReadableStream<Uint8Array> | null>;
  /**
   * Path prefix embedded into every lookup path handed to `read`/`stat`/
   * `readRange`/`realPath` (`''` default: request paths as-is). Set it when
   * the injected functions expect root-prefixed keys (e.g. an in-memory
   * map); leave it unset when they are already rooted at a directory
   * (`createFileReader('public')` + `root: 'public'` would double the
   * prefix and never find a file).
   */
  root?: string; // '' default; joined with the request path POSIX-style
  prefix?: string; // e.g. '/static' — stripped before lookup
  index?: string; // default 'index.html', appended to directory lookups
  spa?: boolean | string; // true → 'index.html'; GET+text/html fallback file
  /**
   * `Cache-Control` value stamped on 200/206/304 responses when set.
   * Default: none — pick a policy that fits your content (sirv-style
   * `no-cache` or long-lived immutable hashes).
   */
  cacheControl?: string;
  /**
   * A request for a directory path without the trailing slash gets a 301
   * to `<path>/` when the directory index exists (serve-static behavior).
   * Default true; disable to let misses fall through to other routes.
   */
  redirectToSlash?: boolean;
  /**
   * Dotfile policy for request paths (`.env`, `.git/…`): `'deny'` (default)
   * falls through to next() so no hidden file is ever served; `'allow'`
   * serves them like any other path. The `root`/`spa` paths are user
   * configuration, not request input, and are exempt.
   */
  dotfiles?: 'deny' | 'allow';
  /**
   * Symlink escape guard: when supplied, called with each resolved lookup
   * path before any read/stat. Returning `null` means the lookup escapes
   * the served root (a real path outside it — a symlink pointing
   * elsewhere), so the request falls through to next() instead of being
   * served or answered with the SPA shell. A path that merely does not
   * exist is NOT an escape: the guard must return a value for it, letting
   * the ordinary miss flow (directory redirect, SPA fallback) still run —
   * the adapter's `createRealPathGuard` reports misses that way. Without
   * the guard, `..` traversal is still blocked but a symlink inside the
   * root can point outside it — inject the adapter's
   * `createRealPathGuard(root)` to close that hole for a custom reader.
   * The adapters' own `createFileReader`/`createFileStat`/
   * `createFileRangeReader` apply that guard internally by default, so the
   * standard filesystem setup needs no injection here. Best-effort by
   * nature: the check and the read are separate operations.
   */
  realPath?: (path: string) => Promise<string | null>;
};

const DEFAULT_INDEX = 'index.html';

/**
 * Percent-decodes one path segment and re-splits the decoded text on both
 * separators: a decoded segment can pack a '/' (from `..%2F`) or a '\' in
 * one URL segment, so literal checks on the raw path cannot see them —
 * callers judge every decoded piece instead. Returns undefined when the
 * segment carries a malformed escape: there is no safely decoded text to
 * inspect (callers fail closed on it).
 */
function decodedPieces(segment: string): string[] | undefined {
  try {
    return decodeURIComponent(segment).split(/[/\\]/);
  } catch {
    return undefined;
  }
}

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
    const pieces = decodedPieces(segment);
    if (pieces === undefined) return undefined; // malformed escape — no safe file name
    for (const piece of pieces) {
      if (piece === '' || piece === '.') continue;
      if (piece === '..') {
        if (stack.length === 0) return undefined;
        stack.pop();
      } else {
        stack.push(piece);
      }
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
    const pieces = decodedPieces(segment);
    // A malformed escape fails closed — reported as a dotfile so the deny
    // policy blocks it before resolution ever runs.
    if (pieces === undefined) return true;
    for (const piece of pieces) {
      // '.'/'..' pieces are traversal, not dotfiles — resolveUnderRoot
      // decides them; the policy here only vetoes hidden names.
      if (piece === '' || piece === '.' || piece === '..') continue;
      if (piece.startsWith('.')) return true;
    }
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
function parseByteRange(
  header: string | null,
  length: number
): ByteRange | null | undefined {
  if (header === null) return undefined;
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
 * Weak entity tag in the `W/"size-mtime"` convention (nginx/sirv style):
 * both quantities are cheap to compute from a stat and change exactly when
 * the content plausibly did.
 */
function etagFor(info: StaticFileInfo): string {
  return `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
}

/**
 * RFC 9110 §13.1.5: `If-Range` gates whether a `Range` header may be
 * honored. Only a strong entity-tag matching the current validator exactly,
 * or an HTTP-date matching `Last-Modified` exactly, lets the range through;
 * anything else (weak tag, mismatch, no known validator) means the client's
 * copy may be stale — the range is ignored and the full body is served.
 * The static layer's own tag is weak (`W/"size-mtime"`), and strong
 * comparison requires strength on both sides, so an entity-tag `If-Range`
 * can never authorize a range here — the date form is the one that matches.
 */
function ifRangeAllows(
  req: Request,
  info: StaticFileInfo | undefined
): boolean {
  const ifRange = req.headers.get('if-range');
  if (ifRange === null) return true;
  if (info === undefined) return false;
  const validator = ifRange.trim();
  if (validator.startsWith('"') || validator.startsWith('W/')) return false;
  const when = Date.parse(validator);
  return (
    !Number.isNaN(when) && when === Math.floor(info.mtimeMs / 1000) * 1000
  );
}

/**
 * The range request actually in effect: `If-Range` first (no authorization
 * means the full body), then {@link parseByteRange} against the
 * representation length. The bytes path and the streamed `readRange` path
 * gate identically, so the pair lives here.
 */
function effectiveRange(
  req: Request,
  info: StaticFileInfo | undefined,
  length: number
): ByteRange | null | undefined {
  if (!ifRangeAllows(req, info)) return undefined;
  return parseByteRange(req.headers.get('range'), length);
}

/**
 * RFC 9110 §13.2.2: a validator match answers 304. `If-None-Match` takes
 * precedence over `If-Modified-Since`; the comparison is weak; `*` matches
 * any current representation. `If-Modified-Since` compares at the second
 * granularity the header format carries.
 */
function isNotModified(req: Request, info: StaticFileInfo): boolean {
  const inm = req.headers.get('if-none-match');
  if (inm !== null) {
    // The weak compare lives in s200/etag — one RFC 9110 §8.8.3
    // implementation shared by both validator surfaces.
    return etagMatches(inm, etagFor(info));
  }
  const ims = req.headers.get('if-modified-since');
  if (ims !== null) {
    const since = Date.parse(ims);
    return !Number.isNaN(since) && Math.floor(info.mtimeMs / 1000) * 1000 <= since;
  }
  return false;
}

/** Adds ETag/Last-Modified when file metadata is available, plus the
 * configured `cache-control` when set — every 200/206/304 response stamps
 * the same pair, so the fold lives here rather than at each call site. */
function withValidators(
  headers: Record<string, string>,
  info: StaticFileInfo | undefined,
  cacheControl: string | undefined
): Record<string, string> {
  if (info !== undefined) {
    headers.etag = etagFor(info);
    headers['last-modified'] = new Date(info.mtimeMs).toUTCString();
  }
  if (cacheControl !== undefined) {
    headers['cache-control'] = cacheControl;
  }
  return headers;
}

/**
 * The unsatisfiable-range answer: 416 with the resource's current size in
 * `content-range` — shared by the bytes path and the streamed
 * `readRange` path.
 */
function unsatisfiable(ctx: Ctx, size: number): void {
  send(ctx, null, {
    status: 416,
    headers: { 'content-range': `bytes */${size}` },
  });
}

/**
 * Sends byte-backed content, honoring a single `Range` request with
 * 206/416 — video seeking works — and HEAD stays bodyless with
 * `accept-ranges` advertised. With `info`, validators ride along so clients
 * can conditionally revalidate (the 200 must advertise what the 304 checks).
 */
function serveBytes(
  ctx: Ctx,
  method: string,
  bytes: Uint8Array,
  path: string,
  cacheControl: string | undefined,
  info?: StaticFileInfo
): void {
  const headers = withValidators(
    {
      'content-type': contentTypeFor(path),
      'accept-ranges': 'bytes',
      // Platforms set content-length lazily at serialization (undici), so
      // HEAD — which never serializes a body — would ship without one.
      // The length is known here; advertise it.
      'content-length': String(bytes.byteLength),
    },
    info,
    cacheControl
  );
  if (method === 'HEAD') {
    send(ctx, bytes, { headers });
    return;
  }
  const range = effectiveRange(ctx.req, info, bytes.byteLength);
  if (range === undefined) {
    send(ctx, bytes, { headers });
    return;
  }
  if (range === null) {
    unsatisfiable(ctx, bytes.byteLength);
    return;
  }
  send(ctx, bytes.subarray(range.start, range.end + 1), {
    status: 206,
    headers: {
      ...headers,
      'content-length': String(range.end - range.start + 1),
      'content-range': `bytes ${range.start}-${range.end}/${bytes.byteLength}`,
    },
  });
}

/**
 * Sends a streamed file: the stream rides along even for HEAD — `handle`
 * rewrites HEAD to a bodyless response afterward, and passing `null` here
 * would make `send` advertise content-length 0, clobbering the size a GET
 * would stream. Streams cannot subarray, so ranges are not offered here —
 * readers that want them provide `readRange`.
 */
function serveStream(
  ctx: Ctx,
  stream: ReadableStream<Uint8Array>,
  path: string,
  info: StaticFileInfo | undefined,
  cacheControl: string | undefined
): void {
  const headers = withValidators(
    {
      'content-type': contentTypeFor(path),
    },
    info,
    cacheControl
  );
  if (info !== undefined) {
    headers['content-length'] = String(info.size);
  }
  send(ctx, stream, { headers });
}

/**
 * Sends a streamed byte range: 206 with content-range/content-length.
 */
function serveRange(
  ctx: Ctx,
  stream: ReadableStream<Uint8Array>,
  range: ByteRange,
  info: StaticFileInfo,
  path: string,
  cacheControl: string | undefined
): void {
  const headers = withValidators(
    {
      'content-type': contentTypeFor(path),
      'content-range': `bytes ${range.start}-${range.end}/${info.size}`,
      'content-length': String(range.end - range.start + 1),
      'accept-ranges': 'bytes',
    },
    info,
    cacheControl
  );
  send(ctx, stream, { status: 206, headers });
}

export function serveStatic(options: ServeStaticOptions): Middleware {
  const read = options.read;
  const stat = options.stat;
  const readRange = options.readRange;
  const root = options.root ?? '';
  const rawPrefix = options.prefix;
  const prefix =
    rawPrefix === undefined || rawPrefix === ''
      ? undefined
      : rawPrefix.startsWith('/')
        ? rawPrefix
        : `/${rawPrefix}`;
  const index = options.index ?? DEFAULT_INDEX;
  const spaPath =
    options.spa === undefined
      ? undefined
      : options.spa === true
        ? index
        : options.spa;
  const cacheControl = options.cacheControl;
  const redirectToSlash = options.redirectToSlash !== false;
  const realPath = options.realPath;

  return async (ctx: Ctx, next) => {
    const method = ctx.req.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return next();

    const pathname = ctx.url.pathname;
    const rest = prefix === undefined ? pathname : stripPrefix(pathname, prefix);
    if (rest === undefined) return next();

    // Hidden files are refused by default — the request path is the only
    // input that decides, so '.env' or '.git/config' can never leave the
    // process even when they sit inside the served root.
    if (options.dotfiles !== 'allow' && hasDotfileSegment(rest)) return next();

    let lookup = resolveUnderRoot(root, rest);
    if (lookup === undefined) return next();
    const directoryPath = rest.endsWith('/');
    if (directoryPath) lookup = lookup === '' ? index : `${lookup}/${index}`;

    // Symlink guard: the path checks above are lexical; a symlink inside
    // the root can still resolve outside it. When the guard is injected,
    // the lookup is gated on its real path staying under root. A `null`
    // answer means an escape, not a mere miss — so this early exit never
    // takes the miss flow below (redirect probe/SPA shell) away from a
    // lookup that simply has no file.
    if (realPath !== undefined && (await realPath(lookup)) === null) {
      return next();
    }

    // Conditional requests and streamed ranges need file metadata; when the
    // injector provides `stat`, it runs first and a miss short-circuits.
    const info = stat === undefined ? undefined : await stat(lookup);
    if (info !== undefined && info !== null) {
      if (isNotModified(ctx.req, info)) {
        send(ctx, null, {
          status: 304,
          headers: withValidators({}, info, cacheControl),
        });
        return;
      }
      if (method === 'GET' && readRange !== undefined) {
        const range = effectiveRange(ctx.req, info, info.size);
        if (range === null) {
          unsatisfiable(ctx, info.size);
          return;
        }
        if (range !== undefined) {
          const slice = await readRange(lookup, range.start, range.end);
          if (slice !== null) {
            serveRange(ctx, slice, range, info, lookup, cacheControl);
            return;
          }
          // The slice reader disagreed with stat (deleted under us) — fall
          // through to the plain read below, which reports the miss itself.
        }
      }
    }

    const result = await read(lookup);
    if (result !== null) {
      if (result instanceof Uint8Array) {
        serveBytes(ctx, method, result, lookup, cacheControl, info ?? undefined);
      } else {
        serveStream(ctx, result, lookup, info ?? undefined, cacheControl);
      }
      return;
    }

    // Directory without a trailing slash: relative links inside the index
    // page resolve against '/dir/file', not '/dir/'. When the directory
    // index exists, redirect the browser (serve-static behavior).
    if (!directoryPath && redirectToSlash) {
      const dirIndex = resolveUnderRoot(root, `${rest}/${index}`);
      if (dirIndex !== undefined) {
        const probe =
          stat !== undefined
            ? await stat(dirIndex)
            : (await read(dirIndex)) === null
              ? undefined
              : {};
        if (probe !== undefined && probe !== null) {
          const url = new URL(ctx.url.href);
          url.pathname = `${pathname}/`;
          redirect(ctx, url.href, 301);
          return;
        }
      }
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
        const shellResult = await read(shell);
        if (shellResult !== null) {
          if (shellResult instanceof Uint8Array) {
            serveBytes(ctx, method, shellResult, shell, cacheControl);
          } else {
            serveStream(ctx, shellResult, shell, undefined, cacheControl);
          }
          return;
        }
      }
    }

    return next();
  };
}
