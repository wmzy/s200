/**
 * Shared crypto primitives for the batteries — one base64url codec and
 * one constant-time byte comparison, instead of a hand-rolled copy per
 * module (cookies/csrf/jwt/oauth each grew their own). Internal module:
 * not part of any package export entry.
 *
 * @internal
 */

/** Base64url alphabet and its decode table — built once at module load
 * so per-request token mint/verify paths allocate nothing for them. */
const B64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_DECODE = new Int8Array(128).fill(-1);
for (let i = 0; i < B64_ALPHABET.length; i += 1) {
  B64_DECODE[B64_ALPHABET.charCodeAt(i)] = i;
}

/** Base64url encode, no padding: `btoa` packs the bytes, then `+` `/`
 * translate to the url-safe alphabet and trailing `=` strips. `btoa` is
 * global on Node ≥ 16, Bun, browsers, and workers. */
export function b64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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
