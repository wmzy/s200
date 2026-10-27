/**
 * JWT over WebCrypto — HS (HMAC), RS (RSASSA-PKCS1-v1_5), PS (RSA-PSS),
 * ES (ECDSA), and EdDSA (Ed25519) families, plus a JWKS resolver for key
 * rotation. No crypto dependency: key import, signing, and verification
 * run through `crypto.subtle`.
 *
 * Algorithm/key pairing is enforced by family — the `alg` header picks
 * the family, and the supplied key must match it (HMAC requires a secret
 * string; RS/PS require an RSA key; ES requires an EC key; EdDSA
 * requires an Ed25519 OKP key — JWK `kty:'OKP'` with `crv:'Ed25519'`).
 * This closes the HS/RSA algorithm-confusion attack without a
 * caller-maintained allowlist (an allowlist can still narrow the
 * default "everything").
 *
 * EdDSA runs wherever WebCrypto implements Ed25519 (stable in Node ≥ 20
 * and current browsers); a runtime without it gets a clear `JwtError`
 * from a one-time capability probe instead of the platform's opaque
 * `NotSupportedError`.
 *
 * @module
 */

import type { Ctx, Middleware, State } from './types';

import { getCookie } from './cookies';
import { httpError } from './errors';
import {
  b64urlDecode as decodeB64url,
  b64urlEncode,
  equalBytes,
  toHex,
} from './crypto-util';
import { evictOldest } from './map-limit';

/** Decoding that keeps this module's throw-site contract: any invalid
 * input (padding, out-of-alphabet char, impossible length) surfaces as
 * the same plain `Error` verifyJwt's callers and the header/payload
 * catch blocks below pin. */
function b64urlDecode(text: string): Uint8Array {
  const bytes = decodeB64url(text);
  if (bytes === null) {
    throw new Error('invalid base64url input');
  }
  return bytes;
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
    }
  | {
      /** RFC 8037 `EdDSA` — Ed25519 only: Ed448 is not in browser
       * WebCrypto secure-curves support, so it stays out of the table. */
      readonly kind: 'ed';
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
  EdDSA: { kind: 'ed' },
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

/**
 * Key-import cache. The key encodes the algorithm and usages plus a
 * SHA-256 hex digest of the key material — the material itself is never
 * embedded, since an injected store may persist or log whatever it is
 * keyed by. The value is
 * a `Promise` of a process-local, non-extractable `CryptoKey`: it cannot
 * be serialized or shipped to another process, so an injected store
 * customizes the in-process import cache (its bounds, eviction policy, or
 * an id→secret mapping the process imports itself) rather than sharing
 * imported keys across instances. The default is an in-process LRU
 * bounded at 100 entries; injecting a store bypasses it entirely.
 */
export type JwtKeyStore = {
  get(key: string): Promise<CryptoKey> | undefined;
  set(key: string, value: Promise<CryptoKey>): void;
};

/** Default key-store bound: past this many distinct imports the least
 * recently used entry is dropped (re-imported on demand), so attacker-
 * shaped key material cannot grow the cache without bound. */
const KEY_CACHE_LIMIT = 100;

const keyCache = new Map<string, Promise<CryptoKey>>();

/** LRU read over a plain Map: re-insertion bumps recency (insertion order
 * is recency order), zero dependencies. */
function lruGet<K, V>(cache: Map<K, V>, key: K): V | undefined {
  const value = cache.get(key);
  if (value !== undefined) {
    cache.delete(key);
    cache.set(key, value);
  }
  return value;
}

/** LRU write over a plain Map: one past the bound, the oldest entry goes. */
function lruSet<K, V>(cache: Map<K, V>, key: K, value: V, limit: number): void {
  cache.set(key, value);
  if (cache.size > limit) {
    evictOldest(cache);
  }
}

const defaultKeyStore: JwtKeyStore = {
  get: (key) => lruGet(keyCache, key),
  set: (key, value) => lruSet(keyCache, key, value, KEY_CACHE_LIMIT),
};

/** Hex of a SHA-256 digest of key material — the import cache is keyed by
 * this, so a store that persists or logs its keys never sees the material
 * (an HMAC secret, a private signing JWK) in the clear. */
async function materialDigest(material: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material))
  );
  return toHex(digest);
}

/** One imported HMAC key per (secret digest, hash, usage) — importing per
 * signature would cost a key-derivation pass on every request. */
async function getHmacKey(
  secretText: string,
  hash: string,
  usages: readonly KeyUsage[],
  store: JwtKeyStore
): Promise<CryptoKey> {
  const cacheKey = `${hash}:${usages.join('+')}:${await materialDigest(secretText)}`;
  let key = store.get(cacheKey);
  if (key === undefined) {
    key = crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secretText),
      { name: 'HMAC', hash },
      false,
      usages
    );
    store.set(cacheKey, key);
  }
  return key;
}

/** One imported asymmetric key per (alg, JWK digest, usage). */
async function importAsymKey(
  jwk: JsonWebKey,
  alg: JwtAlgorithm,
  usages: readonly KeyUsage[],
  store: JwtKeyStore
): Promise<CryptoKey> {
  const info = ALG_INFO[alg];
  const cacheKey = `${alg}:${usages.join('+')}:${await materialDigest(JSON.stringify(jwk))}`;
  let key = store.get(cacheKey);
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
    } else if (info.kind === 'ed') {
      // The string identifier, not an algorithm object — some runtimes
      // mishandle the object form for secure curves.
      key = crypto.subtle.importKey('jwk', jwk, 'Ed25519', false, usages);
    } else {
      throw jwtError(`HMAC key material cannot be imported as a JWK (${alg})`);
    }
    store.set(cacheKey, key);
  }
  return key;
}

function secretText(secret: string | Uint8Array): string {
  return typeof secret === 'string' ? secret : b64urlEncode(secret);
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
    case 'ed':
      // X25519 keys share the OKP family but cannot sign — the name is
      // the discriminator.
      return name === 'Ed25519';
  }
}

/** Ed25519 capability probe — undefined until first asked, then the
 * cached verdict. Probing with a real (non-extractable, immediately
 * dropped) keygen is the honest test: it exercises the same code path
 * import/sign/verify would. */
let ed25519Support: Promise<boolean> | undefined;

/** Throws a clear `JwtError` when this runtime's WebCrypto lacks
 * Ed25519 (pre-20 Node, some embedded runtimes) — one keygen, cached
 * for the process lifetime, so the check costs nothing after the first
 * EdDSA token. */
async function assertEd25519(): Promise<void> {
  if (ed25519Support === undefined) {
    ed25519Support = crypto.subtle
      .generateKey('Ed25519', false, ['sign'])
      .then(
        () => true,
        () => false
      );
  }
  if (!(await ed25519Support)) {
    throw jwtError(
      'EdDSA is not supported by this runtime\'s WebCrypto (Ed25519 is stable in Node >= 20)'
    );
  }
}

/** Resolves signing key material for an algorithm, rejecting mismatches. */
async function getSignKey(key: JwtKey, alg: JwtAlgorithm): Promise<CryptoKey> {
  const info = ALG_INFO[alg];
  if (info.kind === 'ed') {
    await assertEd25519();
  }
  if (info.kind === 'hmac') {
    if (!isSecretKey(key)) {
      throw jwtError(`HMAC algorithm ${alg} requires a secret string or Uint8Array`);
    }
    return getHmacKey(secretText(key), info.hash, ['sign'], defaultKeyStore);
  }
  if (key instanceof CryptoKey) {
    if (!keyMatches(key, info)) {
      throw jwtError(`key does not match algorithm ${alg}`);
    }
    return key;
  }
  const jwk = key as JsonWebKey;
  const expected = info.kind === 'rsa' ? 'RSA' : info.kind === 'ec' ? 'EC' : 'OKP';
  if (jwk.kty !== expected) {
    throw jwtError(`key kty '${String(jwk.kty)}' does not match algorithm ${alg}`);
  }
  if (info.kind === 'ed' && jwk.crv !== 'Ed25519') {
    throw jwtError(`key crv '${String(jwk.crv)}' does not match algorithm ${alg} (Ed25519 only)`);
  }
  return importAsymKey(jwk, alg, ['sign'], defaultKeyStore);
}

/** Resolves verification key material, rejecting family mismatches (this
 * is the algorithm-confusion defense: an RS header can never be verified
 * with HMAC secret bytes, and vice versa). */
async function getVerifyKey(
  key: JwtKey,
  alg: JwtAlgorithm,
  store: JwtKeyStore
): Promise<CryptoKey> {
  const info = ALG_INFO[alg];
  if (info.kind === 'ed') {
    await assertEd25519();
  }
  if (info.kind === 'hmac') {
    if (!isSecretKey(key)) {
      throw jwtError(`HMAC algorithm ${alg} requires a secret string or Uint8Array`);
    }
    // HMAC verification re-signs and compares constant-time, so the key
    // needs the sign usage (verify comes along for free).
    return getHmacKey(secretText(key), info.hash, ['sign', 'verify'], store);
  }
  if (key instanceof CryptoKey) {
    if (!keyMatches(key, info)) {
      throw jwtError(`key does not match algorithm ${alg}`);
    }
    return key;
  }
  const jwk = key as JsonWebKey;
  const expected = info.kind === 'rsa' ? 'RSA' : info.kind === 'ec' ? 'EC' : 'OKP';
  if (jwk.kty !== expected) {
    throw jwtError(`key kty '${String(jwk.kty)}' does not match algorithm ${alg}`);
  }
  if (info.kind === 'ed' && jwk.crv !== 'Ed25519') {
    throw jwtError(`key crv '${String(jwk.crv)}' does not match algorithm ${alg} (Ed25519 only)`);
  }
  return importAsymKey(jwk, alg, ['verify'], store);
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
  const headerText = b64urlEncode(encoder.encode(JSON.stringify({ alg, typ: 'JWT' })));
  const payloadText = b64urlEncode(encoder.encode(JSON.stringify(claims)));
  const signingKey = await getSignKey(key, alg);
  const data = encoder.encode(`${headerText}.${payloadText}`);
  const params: AlgorithmIdentifier | string =
    info.kind === 'hmac'
      ? 'HMAC'
      : info.kind === 'ed'
        ? 'Ed25519'
        : info.kind === 'rsa'
          ? info.algName === 'RSA-PSS'
            ? ({ name: 'RSA-PSS', saltLength: pssSaltLength(info.hash) } as AlgorithmIdentifier)
            : ({ name: info.algName, hash: info.hash } as AlgorithmIdentifier)
          : ({ name: 'ECDSA', hash: info.hash } as AlgorithmIdentifier);
  const sig = new Uint8Array(
    await crypto.subtle.sign(params, signingKey, data)
  );
  return `${headerText}.${payloadText}.${b64urlEncode(sig)}`;
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
  /** Reject tokens whose payload carries no numeric `exp` claim; default
   * false — expiry stays optional, as before. */
  readonly requireExpiry?: boolean;
  /**
   * Key-import cache. The default is an in-process LRU bounded at 100
   * entries; injecting a store bypasses the default cache entirely. Keys
   * are SHA-256 digests of the key material (never the raw secret); values
   * are process-local `CryptoKey`s, so a store bounds/expires imports in
   * this process rather than sharing them across instances.
   */
  readonly keyStore?: JwtKeyStore;
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
  const verifyingKey = await getVerifyKey(
    key,
    alg,
    options.keyStore ?? defaultKeyStore
  );
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
      info.kind === 'ed'
        ? 'Ed25519'
        : info.kind === 'rsa'
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
  if (options.requireExpiry === true && typeof payload.exp !== 'number') {
    throw jwtError('token missing exp');
  }
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
  /**
   * Document cache. The default is an in-process LRU bounded at 50 URLs;
   * injecting a store bypasses the default cache entirely. Entries keep
   * the `{ exp, keys }` shape, so TTL refresh applies to any store.
   */
  readonly store?: JwksStore;
};

/** One cached JWKS document: `exp` is the ms-epoch refresh deadline. */
export type JwksEntry = {
  readonly exp: number;
  readonly keys: readonly (JsonWebKey & { readonly kid?: string })[];
};

/**
 * JWKS document cache keyed by endpoint URL — see {@link JwksOptions.store}.
 * The injected store owns its own bounds and lifetime policy; TTL refresh
 * still happens on read.
 */
export type JwksStore = {
  get(url: string): JwksEntry | undefined;
  set(url: string, entry: JwksEntry): void;
};

/** Default JWKS-store bound: past this many distinct endpoints the least
 * recently used document is dropped (refetched on demand), so a multi-
 * tenant issuer allowlist cannot grow the cache without bound. */
const JWKS_CACHE_LIMIT = 50;

const jwksCache = new Map<string, JwksEntry>();

const defaultJwksStore: JwksStore = {
  get: (url) => lruGet(jwksCache, url),
  set: (url, entry) => lruSet(jwksCache, url, entry, JWKS_CACHE_LIMIT),
};

/** Upper bound on the forced-refetch cooldown: the window between two
 * refetches triggered by an unknown `kid`. A shorter `ttlMs` wins, since
 * the document then refreshes on its own sooner. */
const JWKS_FORCED_REFETCH_COOLDOWN_MS = 30_000;

/**
 * Builds a {@link KeyResolver} over a JWKS endpoint: fetches the key set,
 * caches it for `ttlMs`, and picks by `kid` (first key when the token
 * carries none). A `kid` miss against an unexpired cached document may
 * force one refetch, so a key published after the cached document was
 * fetched becomes visible mid-TTL (rotation races) — at most one refetch
 * per cooldown (`min(ttlMs, 30s)`), so an arbitrary `kid` cannot turn every
 * request into an outbound fetch. A forced refetch that does not bring the
 * `kid` leaves the cached document and its refresh deadline untouched.
 * Documents are cached per URL module-wide in an LRU bounded at 50
 * endpoints, so many app instances in one process share the rotation;
 * inject a `store` to share documents across processes (their entries are
 * plain JSON), not imported keys.
 */
export function createJwksResolver(
  url: string,
  options: JwksOptions = {}
): KeyResolver {
  const ttl = options.ttlMs ?? 300_000;
  const cooldown = Math.max(0, Math.min(ttl, JWKS_FORCED_REFETCH_COOLDOWN_MS));
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const store = options.store ?? defaultJwksStore;
  // `-Infinity`: the first unknown `kid` may always force one refetch.
  let lastForcedRefetch = Number.NEGATIVE_INFINITY;
  const fetchKeys = async (): Promise<JwksEntry> => {
    const fetchedAt = Date.now();
    const res = await fetchFn(url);
    if (!res.ok) {
      throw jwtError(`jwks fetch failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { keys?: JwkWithKid[] };
    if (!Array.isArray(body.keys) || body.keys.length === 0) {
      throw jwtError('malformed jwks: missing keys');
    }
    return { exp: fetchedAt + ttl, keys: body.keys };
  };
  const fetchDocument = async (): Promise<JwksEntry> => {
    const entry = await fetchKeys();
    store.set(url, entry);
    return entry;
  };
  const keyFor = (entry: JwksEntry, kid: string | undefined) => {
    const candidates =
      kid === undefined ? entry.keys : entry.keys.filter((key) => key.kid === kid);
    return candidates[0];
  };
  return async (header) => {
    const now = Date.now();
    let cached = store.get(url);
    let fetchedThisCall = false;
    if (cached === undefined || cached.exp <= now) {
      cached = await fetchDocument();
      fetchedThisCall = true;
    }
    let key = keyFor(cached, header.kid);
    if (key === undefined && header.kid !== undefined && !fetchedThisCall) {
      // Rotation race: a key published after the cached document was
      // fetched is invisible mid-TTL. One refetch is allowed per cooldown
      // (checked and claimed before the await so concurrent misses share
      // it); a refresh that does not bring the kid is discarded — the old
      // document keeps its refresh deadline, so unknown kids cannot pin the
      // TTL forward with fruitless fetches.
      if (now - lastForcedRefetch >= cooldown) {
        lastForcedRefetch = now;
        const refreshed = await fetchKeys();
        const refreshedKey = keyFor(refreshed, header.kid);
        if (refreshedKey !== undefined) {
          store.set(url, refreshed);
          key = refreshedKey;
        }
      }
    }
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
  readonly jwks?: string | {
    readonly url: string;
    readonly ttlMs?: number;
    readonly store?: JwksStore;
  };
  /**
   * Key-import cache forwarded to `verifyJwt`. The default is an
   * in-process LRU bounded at 100 entries; injecting a store bypasses
   * the default cache entirely. Keys are SHA-256 digests of the key
   * material (never the raw secret).
   */
  readonly keyStore?: JwtKeyStore;
  /** Algorithms the gate accepts; default every supported one. */
  readonly algorithms?: readonly JwtAlgorithm[];
  /** Required audience(s) — the token's `aud` must intersect; forwarded
   * to `verifyJwt`. */
  readonly audience?: string | readonly string[];
  /** Required issuer(s) — forwarded to `verifyJwt`. */
  readonly issuer?: string | readonly string[];
  /** Clock skew tolerance in seconds; default 0. */
  readonly clockTolerance?: number;
  /** Reject tokens with no numeric `exp` claim; default false. */
  readonly requireExpiry?: boolean;
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
  const verifyOptions: JwtVerifyOptions = {
    algorithms: options.algorithms,
    audience: options.audience,
    issuer: options.issuer,
    clockTolerance: options.clockTolerance,
    requireExpiry: options.requireExpiry,
    keyStore: options.keyStore,
  };
  const resolver: KeyResolver | undefined =
    options.keyResolver ??
    (options.jwks !== undefined
      ? createJwksResolver(
          typeof options.jwks === 'string' ? options.jwks : options.jwks.url,
          typeof options.jwks === 'string'
            ? undefined
            : { ttlMs: options.jwks.ttlMs, store: options.jwks.store }
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
              verifyOptions
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
