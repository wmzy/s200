/**
 * Cookie reading, writing and signing as pure functions over the request
 * context — no parser dependency, Web Standard only.
 *
 * Writing happens through `ctx.res.headers.append('set-cookie', …)`, so a
 * cookie can only be set once the response exists. The natural idiom:
 * `setCookie` after `await next()` (the unwind), where `ctx.res` is always
 * materialized — handler response or fallback alike.
 *
 * @module
 */

import type { Ctx } from './types';

/** RFC 6265 token — cookie names live in a stricter alphabet than values. */
const NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export type CookieOptions = {
  /** Lifetime in seconds; emitted as `Max-Age`. */
  readonly maxAge?: number;
  /** Absolute expiry; emitted as `Expires` (RFC 1123). */
  readonly expires?: Date;
  readonly domain?: string;
  /** Default '/'; the only sane default outside exact-path cookies. */
  readonly path?: string;
  readonly secure?: boolean;
  readonly httpOnly?: boolean;
  readonly sameSite?: 'strict' | 'lax' | 'none';
  /** Chrome CHIPS — emit the `Partitioned` attribute. */
  readonly partitioned?: boolean;
};

/**
 * Reads one cookie by name from the request's `Cookie` header. Returns
 * `undefined` for a missing cookie or a malformed pair (an undecodable
 * escape), and the decoded value otherwise.
 */
export function getCookie(ctx: Ctx, name: string): string | undefined {
  const header = ctx.req.headers.get('cookie');
  if (header === null) return undefined;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const pairName = pair.slice(0, eq).trim();
    if (pairName !== name) continue;
    try {
      return decodeURIComponent(pair.slice(eq + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Appends a `Set-Cookie` header to the response. Throws when no response
 * exists yet — cookies ride on the response, so set them on the unwind
 * (after `await next()`) or after writing one yourself.
 */
export function setCookie(
  ctx: Ctx,
  name: string,
  value: string,
  options: CookieOptions = {}
): void {
  if (!NAME_RE.test(name)) {
    throw new Error(`Invalid cookie name '${name}': not an RFC 6265 token`);
  }
  if (ctx.res === undefined) {
    throw new Error(
      `Cannot set cookie '${name}': no response written yet — call setCookie after the response exists (e.g. after 'await next()')`
    );
  }
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${Math.trunc(options.maxAge)}`);
  }
  if (options.expires !== undefined) {
    parts.push(`Expires=${options.expires.toUTCString()}`);
  }
  if (options.domain !== undefined) {
    parts.push(`Domain=${options.domain}`);
  }
  parts.push(`Path=${options.path ?? '/'}`);
  if (options.httpOnly === true) parts.push('HttpOnly');
  if (options.secure === true) parts.push('Secure');
  if (options.sameSite !== undefined) {
    const sameSite =
      options.sameSite === 'strict'
        ? 'Strict'
        : options.sameSite === 'lax'
          ? 'Lax'
          : 'None';
    parts.push(`SameSite=${sameSite}`);
  }
  if (options.partitioned === true) parts.push('Partitioned');
  ctx.res.headers.append('set-cookie', parts.join('; '));
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** HMAC-SHA256 over `value`, base64url — the cookie-signature convention. */
export async function signCookie(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return base64url(new Uint8Array(digest));
}

/** Checks a stored signature against a recomputed one. */
export async function verifyCookieSignature(
  value: string,
  signature: string,
  secret: string
): Promise<boolean> {
  return (await signCookie(value, secret)) === signature;
}

/**
 * Sets a signed cookie: the value plus a `${name}.sig` partner holding the
 * HMAC. `httpOnly` defaults to true — a signature readable by page scripts
 * buys nothing.
 */
export async function setSignedCookie(
  ctx: Ctx,
  name: string,
  value: string,
  secret: string,
  options: CookieOptions = {}
): Promise<void> {
  setCookie(ctx, name, value, options);
  setCookie(ctx, `${name}.sig`, await signCookie(value, secret), {
    ...options,
    httpOnly: options.httpOnly ?? true,
  });
}

/**
 * Reads a signed cookie, verifying the `.sig` partner. Returns `undefined`
 * for a missing pair AND for a failed verification — tampering and absence
 * look identical to the client by design; use
 * {@link verifyCookieSignature} directly when they must differ.
 */
export async function getSignedCookie(
  ctx: Ctx,
  name: string,
  secret: string
): Promise<string | undefined> {
  const value = getCookie(ctx, name);
  const signature = getCookie(ctx, `${name}.sig`);
  if (value === undefined || signature === undefined) return undefined;
  return (await verifyCookieSignature(value, signature, secret)) ? value : undefined;
}
