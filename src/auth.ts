/**
 * Authentication gates: `basicAuth` and `bearerAuth` — zero-dependency
 * header verification middleware. The `verify` function decides; a failed
 * or missing credential throws an `HttpError` 401 tagged with the
 * `WWW-Authenticate` challenge into the app's error boundary — the default
 * mapping answers exactly `401 {"error":"Unauthorized"}` + challenge, and
 * a configured `onError` takes over — and the rest of the chain never runs.
 *
 * Note: credential comparison inside `verify` is yours — use the
 * exported `timingSafeEqual(a, b)` from `s200/cookies` for secrets
 * (constant-time, `false` on a length mismatch).
 *
 * @module
 */

import type { Ctx, Middleware } from './types';

import { httpError } from './errors';
import { b64Decode } from './crypto-util';

// Module-level singleton — Basic-credential decode reuses one decoder
// instead of a fresh allocation per request.
const decoder = new TextDecoder();

/**
 * Decodes `Basic base64(user:pass)`. The standard-alphabet payload
 * decodes as UTF-8 so non-ASCII credentials round-trip; an undecodable
 * encoding reads `null` → `undefined` (→ 401, never a throw).
 */
function decodeBasic(header: string): [string, string] | undefined {
  const match = /^Basic\s+(.+)$/i.exec(header);
  const payload = match?.[1];
  if (payload === undefined) return undefined;
  const bytes = b64Decode(payload);
  if (bytes === null) return undefined;
  const text = decoder.decode(bytes);
  const colon = text.indexOf(':');
  if (colon < 0) return undefined;
  return [text.slice(0, colon), text.slice(colon + 1)];
}

/** The gates' shared 401: the body is fixed, only the
 * `www-authenticate` challenge differs — thrown into the error
 * boundary. */
function unauthorized(challenge: string): never {
  throw httpError(
    401,
    'Unauthorized',
    { error: 'Unauthorized' },
    { 'www-authenticate': challenge }
  );
}

export type BasicAuthOptions = {
  /** Realm advertised in the 401 challenge; default `'s200'`. */
  readonly realm?: string;
};

/**
 * Basic-auth gate: `verify(username, password, ctx)` decides. Truthy →
 * `next()`; otherwise a 401 with a `Basic` challenge is thrown into the
 * error boundary.
 */
export function basicAuth(
  verify: (username: string, password: string, ctx: Ctx) => boolean | Promise<boolean>,
  options: BasicAuthOptions = {}
): Middleware {
  const challenge = `Basic realm="${options.realm ?? 's200'}"`;
  return async (ctx, next) => {
    const header = ctx.req.headers.get('authorization');
    const creds = header === null ? undefined : decodeBasic(header);
    if (creds === undefined || !(await verify(creds[0], creds[1], ctx))) {
      unauthorized(challenge);
    }
    return next();
  };
}

/**
 * Extracts the token from an `Authorization`-style header value: a
 * case-insensitive `scheme` (default `Bearer`, as RFC 9110 §11.1
 * requires schemes be matched case-insensitively) followed by one or
 * more whitespace separators, then the credentials. `undefined` for a
 * missing header or a non-matching value — the one extraction shared by
 * `bearerAuth` and `jwtAuth` so the two gates cannot drift apart on
 * casing or separator width. A custom `scheme` is regex-escaped, so any
 * literal prefix works.
 */
export function extractBearer(
  header: string | null,
  scheme = 'Bearer'
): string | undefined {
  if (header === null) return undefined;
  if (scheme === 'Bearer') {
    return BEARER_TOKEN_RE.exec(header)?.[1];
  }
  return schemePattern(scheme).exec(header)?.[1];
}

/** Custom schemes compile once per scheme, not once per request — the
 * cache is keyed by the small, stable scheme set an app configures, and
 * the `i`-only pattern carries no `lastIndex` state, so sharing one
 * instance across requests is safe. */
const schemePatterns = new Map<string, RegExp>();
const schemePattern = (scheme: string): RegExp => {
  let pattern = schemePatterns.get(scheme);
  if (pattern === undefined) {
    const escaped = scheme.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    pattern = new RegExp(`^${escaped}\\s+(.+)$`, 'i');
    schemePatterns.set(scheme, pattern);
  }
  return pattern;
};

/** The default-scheme matcher — a literal regex compiles once, keeping
 * the `Bearer` fast path allocation-identical to a hand-written gate. */
const BEARER_TOKEN_RE = /^Bearer\s+(.+)$/i;

export type BearerAuthOptions = {
  /** Realm advertised in the 401 challenge; default `'s200'`. */
  readonly realm?: string;
};

/**
 * Bearer-token gate: `verify(token, ctx)` decides. Truthy → `next()`;
 * otherwise a 401 with a `Bearer` challenge is thrown into the error
 * boundary.
 */
export function bearerAuth(
  verify: (token: string, ctx: Ctx) => boolean | Promise<boolean>,
  options: BearerAuthOptions = {}
): Middleware {
  const challenge = `Bearer realm="${options.realm ?? 's200'}"`;
  return async (ctx, next) => {
    const token = extractBearer(ctx.req.headers.get('authorization'));
    if (token === undefined || !(await verify(token, ctx))) {
      unauthorized(challenge);
    }
    return next();
  };
}
