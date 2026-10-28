/**
 * Shared crypto primitives for the batteries — the base64 codecs (both
 * alphabets), hex rendering, one constant-time byte comparison, the
 * LRU Map helpers, the shared HMAC-key import cache, and the random
 * token mint, instead of a hand-rolled copy per module
 * (cookies/csrf/jwt/oauth/etag each grew their own). Internal module:
 * not part of any package export entry.
 *
 * @internal
 */

import { evictOldest } from './map-limit';

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

/** LRU read over a plain Map: re-insertion bumps recency (insertion
 * order is recency order), zero dependencies. */
export function lruGet<K, V>(cache: Map<K, V>, key: K): V | undefined {
  const value = cache.get(key);
  if (value !== undefined) {
    cache.delete(key);
    cache.set(key, value);
  }
  return value;
}

/** LRU write over a plain Map: one past the bound, the oldest entry goes. */
export function lruSet<K, V>(cache: Map<K, V>, key: K, value: V, limit: number): void {
  cache.set(key, value);
  if (cache.size > limit) {
    evictOldest(cache);
  }
}

/** Hex of a SHA-256 digest of key material — import caches are keyed by
 * this, so a store that persists or logs its keys never sees the
 * material (an HMAC secret, a private signing JWK) in the clear. */
export async function materialDigest(material: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material))
  );
  return toHex(digest);
}

/** The cache contract {@link getHmacKey} reads and writes through — the
 * method names pin the LRU behavior the default implements; an injected
 * cache keeps its own bounds and lifetime policy. */
export type HmacKeyCache = {
  lruGet(key: string): Promise<CryptoKey> | undefined;
  lruSet(key: string, value: Promise<CryptoKey>): void;
};

/** Default HMAC-import cache bound: past this many distinct imports the
 * least recently used entry is dropped (re-imported on demand), so
 * attacker-shaped key material cannot grow the cache without bound. */
const HMAC_KEY_CACHE_LIMIT = 100;

const hmacKeyCache = new Map<string, Promise<CryptoKey>>();

const defaultHmacCache: HmacKeyCache = {
  lruGet: (key) => lruGet(hmacKeyCache, key),
  lruSet: (key, value) => lruSet(hmacKeyCache, key, value, HMAC_KEY_CACHE_LIMIT),
};

/** One imported HMAC key per (secret digest, hash, usage) — importing per
 * signature would cost a key-derivation pass on every request. Cache
 * keys carry the SHA-256 digest of the secret, never the material
 * itself, so a cache that persists or logs its keys never sees the
 * secret in the clear. */
export async function getHmacKey(
  secret: string,
  hash: string,
  usages: readonly KeyUsage[],
  store: HmacKeyCache = defaultHmacCache
): Promise<CryptoKey> {
  const cacheKey = `${hash}:${usages.join('+')}:${await materialDigest(secret)}`;
  let key = store.lruGet(cacheKey);
  if (key === undefined) {
    key = crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash },
      false,
      usages
    );
    store.lruSet(cacheKey, key);
  }
  return key;
}

/** Random token of `byteLength` entropy bytes, base64url — the opaque
 * token mint (OAuth verifier/state, CSRF nonce) the auth batteries
 * share. */
export function randomToken(byteLength: number): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
}
