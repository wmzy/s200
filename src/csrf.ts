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
import { getHmacKey, hmacSign, hmacVerify, randomToken } from './crypto-util';
import { mediaTypeOf } from './raw-headers';

/** One process-wide encoder — `encode()` still allocates a fresh output
 * buffer per call, so mint/verify pays no encoder allocation (respond.ts
 * precedent). */
const encoder = new TextEncoder();

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
  /** Clock override (tests, deterministic replays); default `Date.now`.
   * Milliseconds epoch — drives token expiry at mint and verify. */
  readonly now?: () => number;
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

/**
 * The signed message shared by mint and verify: `exp.nonce` unbound,
 * `exp.nonce.bind` when bound — unambiguous, since `exp` is digits and
 * the nonce is base64url, so neither segment can contain the separator.
 */
function tokenMessage(
  exp: string,
  nonce: string,
  bind: string | undefined
): Uint8Array<ArrayBuffer> {
  return encoder.encode(
    bind === undefined ? `${exp}.${nonce}` : `${exp}.${nonce}.${bind}`
  );
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
  const [expPart = '', nonce = '', sig = ''] = parts;
  const exp = Number(expPart);
  if (!Number.isFinite(exp) || exp <= now) {
    return null;
  }
  // Appending the bind value is unambiguous — see {@link tokenMessage}.
  // hmacVerify re-signs and compares constant-time; a malformed
  // signature encoding reads false, the same answer as a forged one.
  const message = tokenMessage(expPart, nonce, bind);
  if (!(await hmacVerify(message, sig, hmacKey))) {
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
  // One seconds figure drives both the token expiry math and the cookie
  // Max-Age — they must agree, so derive them from a single constant.
  const ttlSeconds = options.ttl ?? 604_800;
  const ttl = ttlSeconds * 1000;
  // A byte secret is copied — the shared key cache digests the material
  // on every use, so a caller mutating their array after createCsrf must
  // not change what verifies. `encoder.encode` is already fresh.
  const secret =
    typeof options.secret === 'string'
      ? encoder.encode(options.secret)
      : options.secret.slice();
  // One key import per instance, resolved once at creation: every mint
  // and verify below awaits this same promise, so an unsafe request pays
  // the (memoized) digest + import once instead of three times. The
  // shared digest-keyed cache underneath keeps distinct secrets on
  // distinct imports — importing a CryptoKey per request is a real
  // per-request cost; HMAC is stateless, so one key serves all.
  const keyPromise = getHmacKey(secret, 'SHA-256', ['sign']);
  // `undefined` means unbound (no `bind` option) and keeps the signed
  // message byte-identical to an unbound instance.
  const bindOf = options.bind;
  const now = options.now ?? Date.now;
  const currentBind = async (ctx: Ctx): Promise<string | undefined> =>
    bindOf === undefined ? undefined : await bindOf(ctx);
  const cookieOptions = {
    path: options.path ?? '/',
    sameSite: options.sameSite ?? 'lax',
    httpOnly: options.httpOnly ?? true,
    secure: options.secure,
    maxAge: ttlSeconds,
  };

  const createToken = async (bind: string | undefined): Promise<string> => {
    const exp = now() + ttl;
    const nonceText = randomToken(16);
    const message = tokenMessage(String(exp), nonceText, bind);
    // The instance's resolved key — no import, no cache hop.
    const sig = await hmacSign(message, await keyPromise);
    return `${exp}.${nonceText}.${sig}`;
  };

  const issueToken = async (ctx: Ctx): Promise<string> => {
    const fresh = await createToken(await currentBind(ctx));
    ctx.state.csrfToken = fresh;
    return fresh;
  };

  const token = async (ctx: Ctx): Promise<string> => {
    const existing = ctx.state.csrfToken;
    return typeof existing === 'string' ? existing : issueToken(ctx);
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
        : await verifyToken(cookieToken, await keyPromise, now(), bind);
    const installed =
      remaining !== null ? cookieToken : await createToken(bind);
    ctx.state.csrfToken = installed;

    // The cookie-write baseline differs by branch: safe responses
    // compare against the request cookie, so a missing, forged, expired,
    // or foreign-bound one replaced at install time ships the fresh
    // token now (refresh); unsafe responses compare against the
    // installed value, so only a handler rotation (`issueToken`) writes
    // — the rotate-on-login path.
    const safe = SAFE_METHODS.has(ctx.req.method.toUpperCase());
    if (!safe) {
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
        // Exact media-type equality (parameters stripped, case folded) —
        // a prefix lookalike must not pull the body through a form parse.
        const contentType = mediaTypeOf(ctx.req.headers.get('content-type'));
        if (
          contentType === 'application/x-www-form-urlencoded' ||
          contentType === 'multipart/form-data'
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
        (await verifyToken(presented, await keyPromise, now(), bind)) === null
      ) {
        throw httpError(403, 'CSRF token invalid or expired');
      }
    }
    await next();
    if (
      ctx.res !== undefined &&
      ctx.state.csrfToken !== (safe ? cookieToken : installed)
    ) {
      setCookie(ctx, cookieName, ctx.state.csrfToken as string, cookieOptions);
    }
  };

  return { middleware, token, issueToken };
}
