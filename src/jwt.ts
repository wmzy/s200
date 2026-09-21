/**
 * JWT over WebCrypto — HS (HMAC), RS (RSASSA-PKCS1-v1_5), PS (RSA-PSS),
 * and ES (ECDSA) families, plus a JWKS resolver for key rotation. No
 * crypto dependency: key import, signing, and verification run through
 * `crypto.subtle`.
 *
 * Algorithm/key pairing is enforced by family — the `alg` header picks the
 * family, and the supplied key must match it (HMAC requires a secret
 * string; RS/PS require an RSA key; ES requires an EC key). This closes
 * the HS/RSA algorithm-confusion attack without a caller-maintained
 * allowlist (an allowlist can still narrow the default "everything").
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

/** Base64url encode, no padding: 3 bytes → 4 alphabet chars, with the
 * trailing group emitting 2 chars for 1 leftover byte and 3 for 2. */
function b64url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const rest = bytes.length - i;
    const n =
      ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64_ALPHABET.charAt((n >> 18) & 63);
    out += B64_ALPHABET.charAt((n >> 12) & 63);
    if (rest >= 2) {
      out += B64_ALPHABET.charAt((n >> 6) & 63);
    }
    if (rest >= 3) {
      out += B64_ALPHABET.charAt(n & 63);
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

type AlgInfo =
  | { readonly kind: 'hmac'; readonly hash: 'SHA-256' | 'SHA-384' | 'SHA-512' }
  | {
      readonly kind: 'rsa';
      readonly hash: 'SHA-256' | 'SHA-384' | 'SHA-512';
      readonly algName: 'RSASSA-PKCS1-v1_5' | 'RSA-PSS';
    }
  | {
      readonly kind: 'ec';
      readonly hash: 'SHA-256' | 'SHA-384' | 'SHA-512';
      readonly curve: 'P-256' | 'P-384' | 'P-521';
    };

const ALG_INFO = {
  HS256: { kind: 'hmac', hash: 'SHA-256' },
  HS384: { kind: 'hmac', hash: 'SHA-384' },
  HS512: { kind: 'hmac', hash: 'SHA-512' },
  RS256: { kind: 'rsa', hash: 'SHA-256', algName: 'RSASSA-PKCS1-v1_5' },
  RS384: { kind: 'rsa', hash: 'SHA-384', algName: 'RSASSA-PKCS1-v1_5' },
  RS512: { kind: 'rsa', hash: 'SHA-512', algName: 'RSASSA-PKCS1-v1_5' },
  PS256: { kind: 'rsa', hash: 'SHA-256', algName: 'RSA-PSS' },
  PS384: { kind: 'rsa', hash: 'SHA-384', algName: 'RSA-PSS' },
  PS512: { kind: 'rsa', hash: 'SHA-512', algName: 'RSA-PSS' },
  ES256: { kind: 'ec', hash: 'SHA-256', curve: 'P-256' },
  ES384: { kind: 'ec', hash: 'SHA-384', curve: 'P-384' },
  ES512: { kind: 'ec', hash: 'SHA-512', curve: 'P-521' },
} as const satisfies Record<string, AlgInfo>;

export type JwtAlgorithm = keyof typeof ALG_INFO;

/** Key material: an HMAC secret, an imported `CryptoKey`, or a JWK. */
export type JwtKey = string | Uint8Array | CryptoKey | JsonWebKey;

/** A JWK with the `kid` rotation field (TS's dom `JsonWebKey` lacks it). */
type JwkWithKid = JsonWebKey & { readonly kid?: string };

/** PSS salt lengths per RFC 7518 §3.5: the hash's digest size. */
function pssSaltLength(hash: 'SHA-256' | 'SHA-384' | 'SHA-512'): number {
  return hash === 'SHA-256' ? 32 : hash === 'SHA-384' ? 48 : 64;
}

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

/** One imported HMAC key per (secret text, hash, usage) — importing per
 * signature would cost a key-derivation pass on every request. */
function getHmacKey(
  secretText: string,
  hash: string,
  usages: readonly KeyUsage[]
): Promise<CryptoKey> {
  const cacheKey = `${hash}:${usages.join('+')}:${secretText}`;
  let key = keyCache.get(cacheKey);
  if (key === undefined) {
    key = crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secretText),
      { name: 'HMAC', hash },
      false,
      usages
    );
    keyCache.set(cacheKey, key);
  }
  return key;
}

/** One imported asymmetric key per (alg, JWK, usage). */
function importAsymKey(
  jwk: JsonWebKey,
  alg: JwtAlgorithm,
  usages: readonly KeyUsage[]
): Promise<CryptoKey> {
  const info = ALG_INFO[alg];
  const cacheKey = `${alg}:${usages.join('+')}:${JSON.stringify(jwk)}`;
  let key = keyCache.get(cacheKey);
  if (key === undefined) {
    if (info.kind === 'rsa') {
      key = crypto.subtle.importKey(
        'jwk',
        jwk,
        { name: info.algName, hash: info.hash },
        false,
        usages
      );
    } else if (info.kind === 'ec') {
      key = crypto.subtle.importKey(
        'jwk',
        jwk,
        { name: 'ECDSA', namedCurve: info.curve },
        false,
        usages
      );
    } else {
      throw jwtError(`HMAC key material cannot be imported as a JWK (${alg})`);
    }
    keyCache.set(cacheKey, key);
  }
  return key;
}

function secretText(secret: string | Uint8Array): string {
  return typeof secret === 'string' ? secret : b64url(secret);
}

function isSecretKey(key: JwtKey): key is string | Uint8Array {
  return typeof key === 'string' || key instanceof Uint8Array;
}

/** True when a CryptoKey's algorithm family matches the JWT alg. */
function keyMatches(key: CryptoKey, info: AlgInfo): boolean {
  const name = key.algorithm.name;
  switch (info.kind) {
    case 'hmac':
      return name === 'HMAC';
    case 'rsa':
      return name === info.algName;
    case 'ec':
      return name === 'ECDSA';
  }
}

/** Resolves signing key material for an algorithm, rejecting mismatches. */
async function getSignKey(key: JwtKey, alg: JwtAlgorithm): Promise<CryptoKey> {
  const info = ALG_INFO[alg];
  if (info.kind === 'hmac') {
    if (!isSecretKey(key)) {
      throw jwtError(`HMAC algorithm ${alg} requires a secret string or Uint8Array`);
    }
    return getHmacKey(secretText(key), info.hash, ['sign']);
  }
  if (key instanceof CryptoKey) {
    if (!keyMatches(key, info)) {
      throw jwtError(`key does not match algorithm ${alg}`);
    }
    return key;
  }
  const jwk = key as JsonWebKey;
  const expected = info.kind === 'rsa' ? 'RSA' : 'EC';
  if (jwk.kty !== expected) {
    throw jwtError(`key kty '${String(jwk.kty)}' does not match algorithm ${alg}`);
  }
  return importAsymKey(jwk, alg, ['sign']);
}

/** Resolves verification key material, rejecting family mismatches (this
 * is the algorithm-confusion defense: an RS header can never be verified
 * with HMAC secret bytes, and vice versa). */
async function getVerifyKey(key: JwtKey, alg: JwtAlgorithm): Promise<CryptoKey> {
  const info = ALG_INFO[alg];
  if (info.kind === 'hmac') {
    if (!isSecretKey(key)) {
      throw jwtError(`HMAC algorithm ${alg} requires a secret string or Uint8Array`);
    }
    // HMAC verification re-signs and compares constant-time, so the key
    // needs the sign usage (verify comes along for free).
    return getHmacKey(secretText(key), info.hash, ['sign', 'verify']);
  }
  if (key instanceof CryptoKey) {
    if (!keyMatches(key, info)) {
      throw jwtError(`key does not match algorithm ${alg}`);
    }
    return key;
  }
  const jwk = key as JsonWebKey;
  const expected = info.kind === 'rsa' ? 'RSA' : 'EC';
  if (jwk.kty !== expected) {
    throw jwtError(`key kty '${String(jwk.kty)}' does not match algorithm ${alg}`);
  }
  return importAsymKey(jwk, alg, ['verify']);
}

export type JwtSignOptions = {
  /** Algorithm; default HS256. Required when signing with a `CryptoKey`
   * or JWK (it cannot be derived safely). */
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
 * Signs a payload as a compact JWT: `b64url(header).b64url(payload).b64url(signature)`.
 * Claims from the options override same-named payload keys.
 */
export async function signJwt(
  payload: Record<string, unknown>,
  key: JwtKey,
  options: JwtSignOptions = {}
): Promise<string> {
  if (options.alg === undefined && !isSecretKey(key)) {
    throw jwtError('signJwt: the alg option is required when signing with a CryptoKey or JWK');
  }
  const alg = options.alg ?? 'HS256';
  const info = ALG_INFO[alg];
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
  const signingKey = await getSignKey(key, alg);
  const data = encoder.encode(`${headerText}.${payloadText}`);
  const params: AlgorithmIdentifier | string =
    info.kind === 'hmac'
      ? 'HMAC'
      : info.kind === 'rsa'
        ? info.algName === 'RSA-PSS'
          ? ({ name: 'RSA-PSS', saltLength: pssSaltLength(info.hash) } as AlgorithmIdentifier)
          : ({ name: info.algName, hash: info.hash } as AlgorithmIdentifier)
        : ({ name: 'ECDSA', hash: info.hash } as AlgorithmIdentifier);
  const sig = new Uint8Array(
    await crypto.subtle.sign(params, signingKey, data)
  );
  return `${headerText}.${payloadText}.${b64url(sig)}`;
}

export type JwtVerifyOptions = {
  /** Allowed algorithms; default every supported one. `none` is rejected
   * unconditionally. Key-family matching still guards against confusion:
   * the supplied key must match the header's algorithm family. */
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
 * registered claims; throws a `JwtError` on any failure. HMAC verification
 * compares constant-time against a re-signed digest; asymmetric families
 * verify through `crypto.subtle.verify`.
 */
export async function verifyJwt<T = Record<string, unknown>>(
  token: string,
  key: JwtKey,
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
    !(header.alg in ALG_INFO) ||
    (options.algorithms !== undefined && !options.algorithms.includes(header.alg as JwtAlgorithm))
  ) {
    throw jwtError(`unsupported algorithm '${String(header.alg)}'`);
  }
  const alg = header.alg as JwtAlgorithm;
  const info = ALG_INFO[alg];
  const verifyingKey = await getVerifyKey(key, alg);
  const data = encoder.encode(`${headerText}.${payloadText}`);
  if (info.kind === 'hmac') {
    const expected = new Uint8Array(
      await crypto.subtle.sign('HMAC', verifyingKey, data)
    );
    if (!equalBytes(expected, sigBytes)) {
      throw jwtError('invalid signature');
    }
  } else {
    const params: AlgorithmIdentifier | string =
      info.kind === 'rsa'
        ? info.algName === 'RSA-PSS'
          ? ({ name: 'RSA-PSS', saltLength: pssSaltLength(info.hash) } as AlgorithmIdentifier)
          : ({ name: info.algName, hash: info.hash } as AlgorithmIdentifier)
        : ({ name: 'ECDSA', hash: info.hash } as AlgorithmIdentifier);
    const ok = await crypto.subtle.verify(
      params,
      verifyingKey,
      sigBytes as Uint8Array<ArrayBuffer>,
      data as Uint8Array<ArrayBuffer>
    );
    if (!ok) {
      throw jwtError('invalid signature');
    }
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

/** The token header a key resolver sees. */
export type JwtHeader = {
  readonly alg: string;
  readonly kid?: string;
};

/** Resolves key material from a token header — the key-rotation hook. */
export type KeyResolver = (header: JwtHeader) => JwtKey | Promise<JwtKey>;

export type JwksOptions = {
  /** Cache lifetime in ms; default 5 minutes. */
  readonly ttlMs?: number;
  /** Fetch implementation; default the global fetch. */
  readonly fetchFn?: typeof fetch;
};

const jwksCache = new Map<
  string,
  { readonly exp: number; readonly keys: JwkWithKid[] }
>();

/**
 * Builds a {@link KeyResolver} over a JWKS endpoint: fetches the key set,
 * caches it for `ttlMs`, and picks by `kid` (first key when the token
 * carries none). Fetches are cached per URL module-wide, so many app
 * instances in one process share the rotation.
 */
export function createJwksResolver(
  url: string,
  options: JwksOptions = {}
): KeyResolver {
  const ttl = options.ttlMs ?? 300_000;
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  return async (header) => {
    const now = Date.now();
    let cached = jwksCache.get(url);
    if (cached === undefined || cached.exp <= now) {
      const res = await fetchFn(url);
      if (!res.ok) {
        throw jwtError(`jwks fetch failed: HTTP ${res.status}`);
      }
      const body = (await res.json()) as { keys?: JwkWithKid[] };
      if (!Array.isArray(body.keys) || body.keys.length === 0) {
        throw jwtError('malformed jwks: missing keys');
      }
      cached = { exp: now + ttl, keys: body.keys };
      jwksCache.set(url, cached);
    }
    const candidates =
      header.kid === undefined
        ? cached.keys
        : cached.keys.filter((key) => key.kid === header.kid);
    const key = candidates[0];
    if (key === undefined) {
      throw jwtError(
        header.kid === undefined
          ? 'no jwks key available'
          : `no jwks key for kid '${header.kid}'`
      );
    }
    return key;
  };
}

export type JwtAuthOptions = {
  /** HMAC secret — one of `secret`/`key`/`keyResolver`/`jwks` is required
   * unless `verify` is provided. */
  readonly secret?: string | Uint8Array;
  /** Static key material (CryptoKey/JWK for RS/PS/ES, secret for HS). */
  readonly key?: JwtKey;
  /** Per-token key resolution (key rotation, multi-issuer). */
  readonly keyResolver?: KeyResolver;
  /** JWKS endpoint — shorthand for {@link createJwksResolver}. */
  readonly jwks?: string | { readonly url: string; readonly ttlMs?: number };
  /** Algorithms the gate accepts; default every supported one. */
  readonly algorithms?: readonly JwtAlgorithm[];
  /** Header carrying the token; default `authorization`. */
  readonly header?: string;
  /** Scheme prefix stripped from the header value; default `'Bearer '`. */
  readonly prefix?: string;
  /** Cookie name to fall back to when the header is absent. */
  readonly cookie?: string;
  /** Custom verification (another library, exotic tokens) — the returned
   * value lands on `ctx.state.jwt`. */
  readonly verify?: (token: string) => unknown | Promise<unknown>;
};

function parseHeaderOf(token: string): JwtHeader {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw jwtError('malformed token');
  }
  try {
    const header = JSON.parse(
      new TextDecoder().decode(b64urlDecode(parts[0] ?? ''))
    ) as { alg?: unknown; kid?: unknown };
    return {
      alg: typeof header.alg === 'string' ? header.alg : '',
      kid: typeof header.kid === 'string' ? header.kid : undefined,
    };
  } catch {
    throw jwtError('malformed token header');
  }
}

/**
 * The JWT gate middleware: extracts the token (header `Authorization:
 * Bearer …`, or a cookie), verifies it, and stores the payload on
 * `ctx.state.jwt` — augment your `State` interface with the payload shape
 * to read it typed. Missing/invalid tokens answer `401` and the chain
 * below never runs.
 */
export function jwtAuth(options: JwtAuthOptions): Middleware<State> {
  const configured =
    options.secret !== undefined ||
    options.key !== undefined ||
    options.keyResolver !== undefined ||
    options.jwks !== undefined ||
    options.verify !== undefined;
  if (!configured) {
    throw new Error(
      'jwtAuth: provide a secret, key, keyResolver, jwks, or a custom verify function'
    );
  }
  const headerName = options.header ?? 'authorization';
  const prefix = options.prefix ?? 'Bearer ';
  const cookieName = options.cookie;
  const verify = options.verify;
  const staticKey: JwtKey | undefined = options.key ?? options.secret;
  const resolver: KeyResolver | undefined =
    options.keyResolver ??
    (options.jwks !== undefined
      ? createJwksResolver(
          typeof options.jwks === 'string' ? options.jwks : options.jwks.url,
          typeof options.jwks === 'string'
            ? undefined
            : { ttlMs: options.jwks.ttlMs }
        )
      : undefined);
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
          : await verifyJwt(
              token,
              resolver !== undefined
                ? await resolver(parseHeaderOf(token))
                : (staticKey as JwtKey),
              { algorithms: options.algorithms }
            );
    } catch (error) {
      if (isJwtError(error)) {
        throw httpError(401, 'Invalid token');
      }
      throw error;
    }
    await next();
  };
}
