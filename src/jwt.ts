/**
 * JWT (HS256/384/512) as an opt-in battery over WebCrypto — no crypto
 * dependency, Node/Bun/Deno/edge alike. `signJwt`/`verifyJwt` are the pure
 * functions; `jwtAuth` is the gate middleware, storing the verified
 * payload on `ctx.state.jwt` and answering 401 before the chain below runs.
 *
 * Verification is strict by default: `alg` must be one of HS256/384/512
 * (the `none` family is always rejected), `exp`/`nbf` are enforced, and
 * `aud`/`iss` are checked when requested. Failures throw a plain `Error`
 * named `JwtError` — check {@link isJwtError}.
 *
 * @module
 */

import type { Ctx, Middleware, State } from './types';

import { getCookie } from './cookies';
import { httpError } from './errors';

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

/** Base64url decode without padding; throws on out-of-alphabet input. */
function b64urlDecode(text: string): Uint8Array {
  const out = new Uint8Array(Math.floor((text.length * 6) / 8));
  let acc = 0;
  let accBits = 0;
  let outIndex = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code > 127 || B64_DECODE[code] === -1) {
      throw new Error('invalid base64url input');
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

/** Constant-time digest equality — the MAC comparison must not early-exit. */
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

const ALG_HASH = { HS256: 'SHA-256', HS384: 'SHA-384', HS512: 'SHA-512' } as const;

export type JwtAlgorithm = keyof typeof ALG_HASH;

function jwtError(message: string): Error {
  const error = new Error(message);
  error.name = 'JwtError';
  return error;
}

/** Shape predicate for verification failures (check the `name`, not `instanceof`). */
export function isJwtError(error: unknown): boolean {
  return error instanceof Error && error.name === 'JwtError';
}

const keyCache = new Map<string, Promise<CryptoKey>>();

/** One imported HMAC key per (secret text, alg) — importing per signature
 * would cost a key-derivation pass on every request. */
function getHmacKey(secretText: string, hash: string): Promise<CryptoKey> {
  const cacheKey = `${hash}:${secretText}`;
  let key = keyCache.get(cacheKey);
  if (key === undefined) {
    key = crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secretText),
      { name: 'HMAC', hash },
      false,
      ['sign']
    );
    keyCache.set(cacheKey, key);
  }
  return key;
}

function secretText(secret: string | Uint8Array): string {
  return typeof secret === 'string' ? secret : b64url(secret);
}

export type JwtSignOptions = {
  /** HMAC algorithm; default HS256. */
  readonly alg?: JwtAlgorithm;
  /** Lifetime in seconds from now (sets `exp`). */
  readonly expiresIn?: number;
  /** Delay in seconds before the token becomes valid (sets `nbf`). */
  readonly notBefore?: number;
  /** `iat` in seconds; default now. `false` omits the claim. */
  readonly issuedAt?: number | false;
  readonly audience?: string | readonly string[];
  readonly issuer?: string;
  readonly subject?: string;
  readonly jwtId?: string;
};

/** The standard registered claims — present when the options set them. */
export type RegisteredClaims = {
  readonly iat?: number;
  readonly exp?: number;
  readonly nbf?: number;
  readonly iss?: string;
  readonly sub?: string;
  readonly aud?: string | string[];
  readonly jti?: string;
};

/**
 * Signs a payload as a compact JWT: `b64url(header).b64url(payload).b64url(HMAC)`.
 * Claims from the options override same-named payload keys.
 */
export async function signJwt(
  payload: Record<string, unknown>,
  secret: string | Uint8Array,
  options: JwtSignOptions = {}
): Promise<string> {
  const alg = options.alg ?? 'HS256';
  const hash = ALG_HASH[alg];
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = { ...payload };
  if (options.issuedAt !== false) {
    claims.iat = options.issuedAt ?? now;
  }
  if (options.expiresIn !== undefined) {
    claims.exp = now + options.expiresIn;
  }
  if (options.notBefore !== undefined) {
    claims.nbf = now + options.notBefore;
  }
  if (options.audience !== undefined) {
    claims.aud = options.audience;
  }
  if (options.issuer !== undefined) {
    claims.iss = options.issuer;
  }
  if (options.subject !== undefined) {
    claims.sub = options.subject;
  }
  if (options.jwtId !== undefined) {
    claims.jti = options.jwtId;
  }
  const encoder = new TextEncoder();
  const headerText = b64url(encoder.encode(JSON.stringify({ alg, typ: 'JWT' })));
  const payloadText = b64url(encoder.encode(JSON.stringify(claims)));
  const key = await getHmacKey(secretText(secret), hash);
  const sig = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, encoder.encode(`${headerText}.${payloadText}`))
  );
  return `${headerText}.${payloadText}.${b64url(sig)}`;
}

export type JwtVerifyOptions = {
  /** Allowed algorithms; default every HS variant. The `none` family is
   * rejected unconditionally. */
  readonly algorithms?: readonly JwtAlgorithm[];
  /** Required audience(s) — the token's `aud` must intersect. */
  readonly audience?: string | readonly string[];
  /** Required issuer(s). */
  readonly issuer?: string | readonly string[];
  /** Clock skew tolerance in seconds; default 0. */
  readonly clockTolerance?: number;
};

function hasValue<T>(list: readonly T[] | undefined, value: unknown, what: string): void {
  if (list === undefined) {
    return;
  }
  const values = Array.isArray(value) ? value : [value];
  const ok = values.some((item) =>
    list.some((expected) => expected === item)
  );
  if (!ok) {
    throw jwtError(`token ${what} '${String(values[0])}' not allowed`);
  }
}

/**
 * Verifies a compact JWT: structure, algorithm, signature, expiry,
 * not-before, and requested audience/issuer. Returns the payload plus its
 * registered claims; throws a `JwtError` on any failure.
 */
export async function verifyJwt<T = Record<string, unknown>>(
  token: string,
  secret: string | Uint8Array,
  options: JwtVerifyOptions = {}
): Promise<T & RegisteredClaims> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part === '')) {
    throw jwtError('malformed token');
  }
  const [headerText, payloadText, sigText] = parts;
  const headerBytes = b64urlDecode(headerText ?? '');
  const sigBytes = b64urlDecode(sigText ?? '');
  const encoder = new TextEncoder();
  let header: { alg?: unknown };
  try {
    header = JSON.parse(new TextDecoder().decode(headerBytes));
  } catch {
    throw jwtError('malformed token header');
  }
  if (
    typeof header.alg !== 'string' ||
    !(header.alg in ALG_HASH) ||
    (options.algorithms !== undefined && !options.algorithms.includes(header.alg as JwtAlgorithm))
  ) {
    throw jwtError(`unsupported algorithm '${String(header.alg)}'`);
  }
  const alg = header.alg as JwtAlgorithm;
  const key = await getHmacKey(secretText(secret), ALG_HASH[alg]);
  const expected = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(`${headerText}.${payloadText}`)
    )
  );
  if (!equalBytes(expected, sigBytes)) {
    throw jwtError('invalid signature');
  }
  let payload: T & RegisteredClaims;
  try {
    payload = JSON.parse(
      new TextDecoder().decode(b64urlDecode(payloadText ?? ''))
    );
  } catch {
    throw jwtError('malformed token payload');
  }
  const now = Math.floor(Date.now() / 1000);
  const tolerance = options.clockTolerance ?? 0;
  if (typeof payload.exp === 'number' && payload.exp < now - tolerance) {
    throw jwtError('token expired');
  }
  if (typeof payload.nbf === 'number' && payload.nbf > now + tolerance) {
    throw jwtError('token not yet valid');
  }
  if (typeof payload.iat === 'number' && payload.iat > now + tolerance) {
    throw jwtError('token issued in the future');
  }
  hasValue(
    options.issuer === undefined
      ? undefined
      : Array.isArray(options.issuer)
        ? options.issuer
        : [options.issuer],
    payload.iss,
    'issuer'
  );
  hasValue(
    options.audience === undefined
      ? undefined
      : Array.isArray(options.audience)
        ? options.audience
        : [options.audience],
    payload.aud,
    'audience'
  );
  return payload;
}

export type JwtAuthOptions = {
  /** HMAC secret — required unless `verify` is provided. */
  readonly secret?: string | Uint8Array;
  /** Header carrying the token; default `authorization`. */
  readonly header?: string;
  /** Scheme prefix stripped from the header value; default `'Bearer '`. */
  readonly prefix?: string;
  /** Cookie name to fall back to when the header is absent. */
  readonly cookie?: string;
  /** Custom verification (key rotation, asymmetric keys, another library) —
   * the returned value lands on `ctx.state.jwt`. */
  readonly verify?: (token: string) => unknown | Promise<unknown>;
};

/**
 * The JWT gate middleware: extracts the token (header `Authorization:
 * Bearer …`, or a cookie), verifies it, and stores the payload on
 * `ctx.state.jwt` — augment your `State` interface with the payload shape
 * to read it typed. Missing/invalid tokens answer `401` and the chain
 * below never runs.
 */
export function jwtAuth(options: JwtAuthOptions): Middleware<State> {
  if (options.secret === undefined && options.verify === undefined) {
    throw new Error('jwtAuth: provide a secret or a custom verify function');
  }
  const headerName = options.header ?? 'authorization';
  const prefix = options.prefix ?? 'Bearer ';
  const cookieName = options.cookie;
  const verify = options.verify;
  const secret = options.secret;
  return async (ctx: Ctx, next) => {
    let token: string | undefined;
    const headerValue = ctx.req.headers.get(headerName);
    if (headerValue !== null && headerValue.startsWith(prefix)) {
      token = headerValue.slice(prefix.length);
    } else if (cookieName !== undefined) {
      token = getCookie(ctx, cookieName);
    }
    if (token === undefined || token === '') {
      throw httpError(401, 'Authentication required');
    }
    try {
      ctx.state.jwt =
        verify !== undefined
          ? await verify(token)
          : await verifyJwt(token, secret as string | Uint8Array);
    } catch (error) {
      if (isJwtError(error)) {
        throw httpError(401, 'Invalid token');
      }
      throw error;
    }
    await next();
  };
}
