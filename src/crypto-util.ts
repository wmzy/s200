/**
 * Shared crypto primitives for the batteries — the base64 codecs (both
 * alphabets), hex rendering, one constant-time byte comparison, the
 * shared HMAC-key import cache, and the random token mint, instead of a
 * hand-rolled copy per module (cookies/csrf/jwt/oauth/etag each grew
 * their own). Internal module: not part of any package export entry.
 *
 * @internal
 */

import { evictOldest, lruStore } from './bounded-collections';

/** One process-wide encoder — `encode()` still allocates a fresh output
 * buffer per call, so hoisting the encoder itself (respond.ts precedent)
 * leaves per-request work unchanged and removes the per-call allocation. */
const encoder = new TextEncoder();

/** Base64url alphabet and its decode table — built once at module load
 * so per-request token mint/verify paths allocate nothing for them. */
const B64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_DECODE = new Int8Array(128).fill(-1);
for (let i = 0; i < B64_ALPHABET.length; i += 1) {
  B64_DECODE[B64_ALPHABET.charCodeAt(i)] = i;
}

/** Builds the Latin-1 binary string `btoa` consumes — one pass, one
 * string per encode, nothing else allocated. Both base64 alphabets
 * start here; only the post-processing differs. */
function toBinaryString(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return binary;
}

/** Base64url encode, no padding: `btoa` packs the bytes, then `+` `/`
 * translate to the url-safe alphabet and trailing `=` strips. `btoa` is
 * global on Node ≥ 16, Bun, browsers, and workers. */
export function b64urlEncode(bytes: Uint8Array): string {
  return btoa(toBinaryString(bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Standard-alphabet base64 (RFC 4648 §4, padded) — the Basic-auth
 * (RFC 7617) and binary-XML convention; the url-safe variant stays
 * {@link b64urlEncode}. */
export function b64Encode(bytes: Uint8Array): string {
  return btoa(toBinaryString(bytes));
}

/** Standard-alphabet base64 decode (RFC 4648 §4, padded) — the decode
 * twin of {@link b64Encode}: `+` `/` translate onto the url-safe table
 * so the bit-packing stays the one shared decoder. `null` on '='
 * outside the one trailing padding run, padding that does not complete
 * the final quantum (a `=` after a whole group, or 3+ pads), any
 * out-of-alphabet char, or `length % 4 === 1` (inherited from the core
 * — a final group of 1 char carries only 6 bits, short of a byte). */
export function b64Decode(text: string): Uint8Array | null {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 61 /* '=' */) {
    end -= 1;
  }
  const pads = text.length - end;
  // Padding completes a quantum: 0 pads anywhere (unpadded input), else
  // exactly 2 or 3 data chars must precede it — atob's forgiving shape.
  if (pads > 2 || (pads > 0 && end % 4 !== 2 && end % 4 !== 3)) {
    return null;
  }
  let core = '';
  for (let i = 0; i < end; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 61 /* '=' */) {
      return null; // before the trailing run — out of place
    }
    core += code === 43 /* '+' */ ? '-' : code === 47 /* '/' */ ? '_' : String.fromCharCode(code);
  }
  return b64urlDecode(core);
}

/** Lowercase hex, two chars per byte — the digest rendering SHA etags
 * and key-material cache keys use. */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

/** Base64url decode, strict unpadded: `null` on '=' padding (out of the
 * url-safe alphabet, caught by the table), any out-of-alphabet char, or
 * an impossible length — a final group of 1 char carries only 6 bits,
 * short of a byte, so `length % 4 === 1` can never decode. */
export function b64urlDecode(text: string): Uint8Array | null {
  if (text.length % 4 === 1) {
    return null;
  }
  const out = new Uint8Array(Math.floor((text.length * 6) / 8));
  let acc = 0;
  let accBits = 0;
  let outIndex = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const value = code > 127 ? -1 : (B64_DECODE[code] ?? -1);
    if (value === -1) {
      return null;
    }
    acc = (acc << 6) | value;
    accBits += 6;
    if (accBits >= 8) {
      accBits -= 8;
      out[outIndex] = (acc >> accBits) & 0xff;
      outIndex += 1;
    }
  }
  return out;
}

/** Constant-time byte equality: XOR-folds every byte and decides once
 * at the end, so digest comparisons never early-exit on the first
 * mismatching byte (the timing of which would leak agreement).
 * Unequal lengths return `false` immediately — a digest's length is
 * fixed by its algorithm, so it carries no secret bits. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/** Hex of a SHA-256 digest of key material (a string digests its UTF-8
 * bytes, raw bytes digest themselves — equal material hashes equal, so
 * a byte secret and the same bytes as a string share one cache entry) —
 * import caches are keyed by this, so a store that persists or logs its
 * keys never sees the material (an HMAC secret, a private signing JWK)
 * in the clear. */
export async function materialDigest(
  material: string | Uint8Array
): Promise<string> {
  const bytes =
    typeof material === 'string' ? encoder.encode(material) : material;
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  );
  return toHex(digest);
}

/** The cache contract {@link getHmacKey} reads and writes through — the
 * `get`/`set` shape `lruStore` returns (jwt's `JwtKeyStore` is this
 * type), so an injected store slots in without an adapter. */
export type HmacKeyCache = {
  get(key: string): Promise<CryptoKey> | undefined;
  set(key: string, value: Promise<CryptoKey>): void;
};

/** Default HMAC-import cache bound: past this many distinct imports the
 * least recently used entry is dropped (re-imported on demand), so
 * attacker-shaped key material cannot grow the cache without bound. */
const HMAC_KEY_CACHE_LIMIT = 100;

const defaultHmacCache: HmacKeyCache = lruStore(HMAC_KEY_CACHE_LIMIT);

/** Get-or-import through a {@link HmacKeyCache}: on a miss the import
 * starts and its *promise* is cached before anything awaits it, so
 * concurrent misses for one key share a single import, and a rejected
 * import replays the identical cached failure on every later read (the
 * LRU-bounds tests pin both). The callback owns the algorithm
 * parameters — this module's HMAC row and jwt's asymmetric JWK rows are
 * the two callers — and a synchronous throw from it never reaches
 * `set`, so a bad-before-start import leaves the cache untouched for
 * the next call to retry. */
export function cachedImport(
  store: HmacKeyCache,
  cacheKey: string,
  importKey: () => Promise<CryptoKey>
): Promise<CryptoKey> {
  let key = store.get(cacheKey);
  if (key === undefined) {
    key = importKey();
    store.set(cacheKey, key);
  }
  return key;
}

/** String-secret digest-memo bound: past this many distinct secrets the
 * oldest memo entry drops (its digest recomputes on demand). Secrets are
 * configuration sources, not request input, so a small FIFO is honest —
 * it bounds memory, it does not defend. */
const SECRET_DIGEST_MEMO_LIMIT = 64;

const stringSecretDigests = new Map<string, Promise<string>>();
const byteSecretDigests = new WeakMap<Uint8Array, Promise<string>>();

/** One digest per secret — {@link getHmacKey} reads the memo on every
 * call, cache hit included, so a request never pays a SHA-256 pass to
 * rebuild a cache key it already built. Strings memo in the bounded FIFO
 * above; byte secrets memo by object identity in a `WeakMap` (holding a
 * digest alive must not hold the caller's buffer alive). A rejection
 * evicts itself, so a transient failure never sticks. */
function secretDigest(secret: string | Uint8Array): Promise<string> {
  if (typeof secret !== 'string') {
    let digest = byteSecretDigests.get(secret);
    if (digest === undefined) {
      digest = materialDigest(secret).catch((error: unknown) => {
        byteSecretDigests.delete(secret);
        throw error;
      });
      byteSecretDigests.set(secret, digest);
    }
    return digest;
  }
  let digest = stringSecretDigests.get(secret);
  if (digest === undefined) {
    digest = materialDigest(secret).catch((error: unknown) => {
      stringSecretDigests.delete(secret);
      throw error;
    });
    stringSecretDigests.set(secret, digest);
    // Evict-after-insert = FIFO over the plain insertion-ordered Map —
    // the shared contract in bounded-collections.
    while (stringSecretDigests.size > SECRET_DIGEST_MEMO_LIMIT) {
      evictOldest(stringSecretDigests);
    }
  }
  return digest;
}

/** One imported HMAC key per (secret digest, hash, usage) — importing per
 * signature would cost a key-derivation pass on every request. Byte
 * secrets import as their exact raw bytes (string secrets as their
 * UTF-8 bytes) and the cache key digests that same raw material, so a
 * string secret and a byte secret never collide on one import. Cache
 * keys carry the SHA-256 digest of the secret (memoized per secret — see
 * {@link secretDigest}), never the material itself, so a cache that
 * persists or logs its keys never sees the secret in the clear. */
export async function getHmacKey(
  secret: string | Uint8Array,
  hash: string,
  usages: readonly KeyUsage[],
  store: HmacKeyCache = defaultHmacCache
): Promise<CryptoKey> {
  const bytes =
    typeof secret === 'string' ? encoder.encode(secret) : secret;
  const cacheKey = `${hash}:${usages.join('+')}:${await secretDigest(secret)}`;
  return cachedImport(store, cacheKey, () =>
    crypto.subtle.importKey(
      'raw',
      bytes as Uint8Array<ArrayBuffer>,
      { name: 'HMAC', hash },
      false,
      usages
    )
  );
}

/** Random token of `byteLength` entropy bytes, base64url — the opaque
 * token mint (OAuth verifier/state, CSRF nonce) the auth batteries
 * share. */
export function randomToken(byteLength: number): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** The {@link hmacSign}/{@link hmacVerify} knobs: the digest (default
 * SHA-256, the cookie/CSRF/jwt-HS256 convention) and the import cache a
 * caller scopes for itself (cookies' private 8-entry LRU) — the default
 * is the shared process-wide cache below. */
export type HmacOptions = {
  readonly hash?: 'SHA-256' | 'SHA-384' | 'SHA-512';
  readonly cache?: HmacKeyCache;
};

/** Resolves the key behind {@link hmacSign}/{@link hmacVerify}: material
 * imports through {@link getHmacKey} (one digest-keyed row per secret),
 * an already-imported `CryptoKey` passes through untouched — jwt
 * resolves its keys through usage-aware stores of its own. */
async function hmacKeyFor(
  secret: string | Uint8Array | CryptoKey,
  options: HmacOptions
): Promise<CryptoKey> {
  if (secret instanceof CryptoKey) {
    return secret;
  }
  return getHmacKey(secret, options.hash ?? 'SHA-256', ['sign'], options.cache);
}

/** HMAC over `message` as raw digest bytes — the shared core of
 * {@link hmacSign} (renders base64url) and {@link hmacVerify} (compares
 * the bytes constant-time). */
async function hmacSignBytes(
  message: Uint8Array,
  secret: string | Uint8Array | CryptoKey,
  options: HmacOptions
): Promise<Uint8Array> {
  const key = await hmacKeyFor(secret, options);
  return new Uint8Array(
    await crypto.subtle.sign('HMAC', key, message as Uint8Array<ArrayBuffer>)
  );
}

/** HMAC over `message`, rendered base64url — the one mint the cookie
 * signature, the CSRF token, and jwt's HS* re-sign share; digest and
 * cache scope flow through `options`. */
export async function hmacSign(
  message: Uint8Array,
  secret: string | Uint8Array | CryptoKey,
  options: HmacOptions = {}
): Promise<string> {
  return b64urlEncode(await hmacSignBytes(message, secret, options));
}

/** HMAC verification by re-signing and comparing constant-time
 * ({@link equalBytes}) — the cookie-signature/double-submit convention.
 * The stored signature decodes as base64url first: a malformed encoding
 * reads `false`, not a throw, so a gate keeps its fail-closed answer. */
export async function hmacVerify(
  message: Uint8Array,
  signatureB64url: string,
  secret: string | Uint8Array | CryptoKey,
  options: HmacOptions = {}
): Promise<boolean> {
  const given = b64urlDecode(signatureB64url);
  if (given === null) {
    return false;
  }
  return equalBytes(await hmacSignBytes(message, secret, options), given);
}
