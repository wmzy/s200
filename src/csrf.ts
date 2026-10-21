/**
 * CSRF protection as an opt-in battery — a session-less synchronizer token
 * over the double-submit pattern, hardened in three ways: every token is an
 * HMAC-signed capability (`nonce` + expiry) that only this server's secret
 * can mint, unsafe requests are also checked against their `Origin` header
 * (falling back to `Sec-Fetch-Site: cross-site` when Origin is absent), and
 * an optional `bind` option folds a request-scoped value (e.g. the session
 * id) into the HMAC, so a cookie injected from an attacker-controlled
 * subdomain cannot authenticate a forged form and a token minted for
 * another session/user no longer verifies.
 *
 * The token rides in a cookie on safe responses; a page obtains it by
 * reading the request cookie server-side (`await csrf.token(ctx)` echoes it
 * into a hidden form field), or via an endpoint returning it for SPAs.
 * Unsafe requests present it in a header or form field and are answered
 * 403 when it is missing, expired, or forged — the chain below never runs.
 *
 * Pair with `s200/cors` (a credentialed CORS setup should keep its origin
 * allowlist tight) and `s200/trust-proxy` behind a reverse proxy (the
 * origin check compares against `ctx.url`, which trust-proxy corrects).
 *
 * @module
 */

import type { Ctx, Middleware } from './types';

import { getCookie, setCookie } from './cookies';
import { readForm } from './body';
import { httpError } from './errors';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type CsrfOptions = {
  /** HMAC secret — keep it out of version control. */
  readonly secret: string | Uint8Array;
  /** Cookie name carrying the token; default `csrf_token`. */
  readonly cookie?: string;
  /** Request header presenting the token; default `x-csrf-token`. */
  readonly header?: string;
  /** Form field name presenting the token; default `_csrf`. */
  readonly form?: string;
  /** Token lifetime in seconds; default 7 days. */
  readonly ttl?: number;
  /** Cookie path; default `/`. */
  readonly path?: string;
  /** Cookie sameSite; default `lax`. */
  readonly sameSite?: 'strict' | 'lax' | 'none';
  /** Cookie httpOnly — keep `true` and deliver the token via an endpoint
   * or server-rendered form; SPAs reading the cookie need `false`. */
  readonly httpOnly?: boolean;
  /** Cookie secure — set behind TLS. */
  readonly secure?: boolean;
  /** Binds tokens to a request-scoped value (e.g. the session id): the
   * HMAC covers it at mint time and verification recomputes it with the
   * current value, so a token minted for another session/user no longer
   * verifies. Off by default — tokens are unbound. */
  readonly bind?: (ctx: Ctx) => string | Promise<string>;
};

/** Base64url alphabet and its decode table (hoisted: token verification
 * runs per unsafe request, so the tables allocate once at import). */
const B64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_DECODE = new Int8Array(128).fill(-1);
for (let i = 0; i < B64_ALPHABET.length; i += 1) {
  B64_DECODE[B64_ALPHABET.charCodeAt(i)] = i;
}

/** Base64url encode, no padding: 3 bytes → 4 alphabet chars. */
function b64url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    const rest = bytes.length - i;
    out += B64_ALPHABET[(n >> 18) & 63];
    out += B64_ALPHABET[(n >> 12) & 63];
    if (rest >= 2) {
      out += B64_ALPHABET[(n >> 6) & 63];
    }
    if (rest >= 3) {
      out += B64_ALPHABET[n & 63];
    }
  }
  return out;
}

/** Base64url decode, no padding; `null` on any out-of-alphabet char. */
function b64urlDecode(text: string): Uint8Array | null {
  const out = new Uint8Array(Math.floor((text.length * 6) / 8));
  let acc = 0;
  let accBits = 0;
  let outIndex = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code > 127 || B64_DECODE[code] === -1) {
      return null;
    }
    acc = (acc << 6) | (B64_DECODE[code] ?? 0);
    accBits += 6;
    if (accBits >= 8) {
      accBits -= 8;
      out[outIndex] = (acc >> accBits) & 0xff;
      outIndex += 1;
    }
  }
  return out;
}

/** Constant-time digest equality: XOR-folds the bytes, no early exit. */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Parses a token and verifies its signature + expiry against the secret.
 * `bind` is the current bind value for a bound instance (`undefined` for
 * an unbound one — the signed message stays exactly `exp.nonce`).
 * Returns the remaining lifetime in ms, or `null` for any malformed,
 * forged, or expired input.
 */
async function verifyToken(
  token: string,
  hmacKey: CryptoKey,
  now: number,
  bind: string | undefined
): Promise<number | null> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part === '')) {
    return null;
  }
  const [expPart, nonce, sig] = parts;
  const exp = Number(expPart);
  if (
    !Number.isFinite(exp) ||
    exp <= now ||
    nonce === undefined ||
    sig === undefined
  ) {
    return null;
  }
  // Appending the bind value is unambiguous: `expPart` is digits and the
  // nonce is base64url, so neither segment can contain the separator.
  const message = new TextEncoder().encode(
    bind === undefined ? `${expPart}.${nonce}` : `${expPart}.${nonce}.${bind}`
  );
  const expected = new Uint8Array(
    await crypto.subtle.sign('HMAC', hmacKey, message)
  );
  const given = b64urlDecode(sig);
  if (given === null || !equalBytes(expected, given)) {
    return null;
  }
  return exp - now;
}

export type Csrf = {
  /**
   * The CSRF middleware: on safe requests it guarantees a valid token in
   * `ctx.state.csrfToken` and refreshes the cookie when needed; on unsafe
   * requests it verifies `Origin` (when sent) and the presented token,
   * answering 403 before anything below the chain runs.
   */
  readonly middleware: Middleware;
  /**
   * The token to embed in a form or return to an SPA: the request's valid
   * cookie token when one exists, a fresh token otherwise. The middleware
   * stores its per-request token under the same key, so the token a handler
   * embeds is always the one the middleware sets as the cookie.
   */
  readonly token: (ctx: Ctx) => Promise<string>;
  /**
   * Mints a fresh token for the current request context — new nonce,
   * full TTL, the current `bind` value — and stores it as the request's
   * token; the middleware persists it as the response cookie on the
   * unwind, unsafe requests included. The rotate-on-login primitive:
   * minting is stateless, so the previous token stays valid until its
   * own expiry — pairing `bind` with a fresh session id is what retires
   * it.
   */
  readonly issueToken: (ctx: Ctx) => Promise<string>;
};

/**
 * Builds the CSRF pair. Token state lives on `ctx.state.csrfToken` (a
 * `string`) — augment your `State` interface with it to read it typed.
 */
export function createCsrf(options: CsrfOptions): Csrf {
  const cookieName = options.cookie ?? 'csrf_token';
  const headerName = options.header ?? 'x-csrf-token';
  const formField = options.form ?? '_csrf';
  const ttl = (options.ttl ?? 7 * 24 * 3600) * 1000;
  const secretBytes =
    typeof options.secret === 'string'
      ? new TextEncoder().encode(options.secret)
      : options.secret;
  const secret = secretBytes.slice();
  // `undefined` means unbound (no `bind` option) and keeps the signed
  // message byte-identical to an unbound instance.
  const bindOf = options.bind;
  const currentBind = async (ctx: Ctx): Promise<string | undefined> =>
    bindOf === undefined ? undefined : await bindOf(ctx);
  const cookieOptions = {
    path: options.path ?? '/',
    sameSite: options.sameSite ?? 'lax',
    httpOnly: options.httpOnly ?? true,
    secure: options.secure,
    maxAge: options.ttl ?? 7 * 24 * 3600,
  };

  // Imported once per instance — importing a CryptoKey per request is a
  // real per-request cost; HMAC is stateless so one key serves all.
  let keyPromise: Promise<CryptoKey> | undefined;
  const getKey = (): Promise<CryptoKey> => {
    keyPromise ??= crypto.subtle.importKey(
      'raw',
      secret,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    return keyPromise;
  };

  const createToken = async (bind: string | undefined): Promise<string> => {
    const key = await getKey();
    const now = Date.now();
    const exp = now + ttl;
    const nonce = new Uint8Array(16);
    crypto.getRandomValues(nonce);
    const nonceText = b64url(nonce);
    // Bound instances append the bind value after a second dot —
    // unambiguous, since `exp` is digits and the nonce is base64url.
    const message = new TextEncoder().encode(
      bind === undefined ? `${exp}.${nonceText}` : `${exp}.${nonceText}.${bind}`
    );
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
    return `${exp}.${nonceText}.${b64url(sig)}`;
  };

  const token = async (ctx: Ctx): Promise<string> => {
    const existing = ctx.state.csrfToken;
    if (typeof existing === 'string') {
      return existing;
    }
    const fresh = await createToken(await currentBind(ctx));
    ctx.state.csrfToken = fresh;
    return fresh;
  };

  const issueToken = async (ctx: Ctx): Promise<string> => {
    const fresh = await createToken(await currentBind(ctx));
    ctx.state.csrfToken = fresh;
    return fresh;
  };

  const middleware: Middleware = async (ctx, next) => {
    // A valid request cookie is reused (no rotation churn); a missing,
    // forged, or expired one — or, with `bind`, one minted for another
    // bind value — is replaced by a fresh token.
    const bind = await currentBind(ctx);
    const cookieToken = getCookie(ctx, cookieName);
    const remaining =
      cookieToken === undefined
        ? null
        : await verifyToken(cookieToken, await getKey(), Date.now(), bind);
    const installed =
      remaining !== null ? cookieToken : await createToken(bind);
    ctx.state.csrfToken = installed;

    if (SAFE_METHODS.has(ctx.req.method.toUpperCase())) {
      await next();
      if (ctx.res !== undefined && ctx.state.csrfToken !== cookieToken) {
        setCookie(
          ctx,
          cookieName,
          ctx.state.csrfToken as string,
          cookieOptions
        );
      }
      return;
    }

    // Unsafe: the Origin header, when present, must match the request's
    // own origin — a cross-site form cannot fake it. Behind a proxy the
    // comparison only works on the corrected URL (see s200/trust-proxy).
    // When Origin is absent (same-origin form posts often omit it), the
    // Sec-Fetch-Site metadata header is the fallback: `cross-site` is
    // rejected outright, `same-origin`/`same-site`/`none` fall through
    // to the token check.
    const originHeader = ctx.req.headers.get('origin');
    if (originHeader !== null) {
      try {
        if (new URL(originHeader).origin !== ctx.url.origin) {
          throw httpError(403, 'CSRF check failed: Origin mismatch');
        }
      } catch {
        throw httpError(403, 'CSRF check failed: malformed Origin');
      }
    } else if (ctx.req.headers.get('sec-fetch-site') === 'cross-site') {
      throw httpError(403, 'CSRF check failed: cross-site request');
    }

    let presented = ctx.req.headers.get(headerName);
    if (presented === null || presented === '') {
      const contentType = ctx.req.headers.get('content-type') ?? '';
      if (
        contentType.startsWith('application/x-www-form-urlencoded') ||
        contentType.startsWith('multipart/form-data')
      ) {
        // readForm caches the parse per request, so a later handler read
        // replays the same body instead of hitting "already consumed".
        const field = (await readForm(ctx)).get(formField);
        if (typeof field === 'string' && field !== '') {
          presented = field;
        }
      }
    }
    if (presented === null || presented === '') {
      throw httpError(403, 'CSRF token missing');
    }
    if (
      (await verifyToken(presented, await getKey(), Date.now(), bind)) === null
    ) {
      throw httpError(403, 'CSRF token invalid or expired');
    }
    await next();
    // A handler that rotated the token (`issueToken`) gets the fresh one
    // persisted as the response cookie — unsafe requests included, which
    // is the rotate-on-login path.
    if (ctx.res !== undefined && ctx.state.csrfToken !== installed) {
      setCookie(ctx, cookieName, ctx.state.csrfToken as string, cookieOptions);
    }
  };

  return { middleware, token, issueToken };
}
