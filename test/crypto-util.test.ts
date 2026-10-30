import { describe, it, vi } from 'vitest';

import { lruStore } from '../src/bounded-collections';
import {
  b64Decode,
  b64Encode,
  b64urlDecode,
  b64urlEncode,
  equalBytes,
  getHmacKey,
  hmacSign,
  hmacVerify,
  materialDigest,
  randomToken,
  toHex,
  type HmacKeyCache,
} from '../src/crypto-util';

describe('lruStore', function () {
  it('bounds a store: reads bump recency, writes evict past the limit', function () {
    const store = lruStore<string, number>(2);
    store.set('a', 1);
    store.set('b', 2);
    store.get('a')!.should.equal(1); // bump a past b in recency
    store.set('c', 3); // past the bound — evicts b, not the read a
    (store.get('b') === undefined).should.be.true;
    store.get('a')!.should.equal(1);
    store.get('c')!.should.equal(3);
    // Unknown keys stay misses.
    (store.get('nope') === undefined).should.be.true;
    // Overwrites keep one entry per key.
    store.set('a', 9);
    store.get('a')!.should.equal(9);
  });
});

describe('crypto-util', function () {
  it('encodes known vectors: partial and full 3-byte groups', function () {
    b64urlEncode(new Uint8Array(0)).should.equal('');
    // 1 leftover byte → 2 chars, 2 leftover → 3 chars, 3 → 4 chars.
    b64urlEncode(new Uint8Array([102])).should.equal('Zg');
    b64urlEncode(new Uint8Array([102, 111])).should.equal('Zm8');
    b64urlEncode(new Uint8Array([102, 111, 111])).should.equal('Zm9v');
    Array.from(b64urlDecode('Zg') ?? []).should.deep.equal([102]);
    Array.from(b64urlDecode('Zm8') ?? []).should.deep.equal([102, 111]);
    Array.from(b64urlDecode('Zm9v') ?? []).should.deep.equal([102, 111, 111]);
  });

  it('roundtrips empty, 1-, 2-, 3-byte, and all-0xff buffers', function () {
    const cases = [
      new Uint8Array(0),
      new Uint8Array([1]),
      new Uint8Array([1, 2]),
      new Uint8Array([1, 2, 3]),
      new Uint8Array(32).fill(255),
    ];
    for (const bytes of cases) {
      const decoded = b64urlDecode(b64urlEncode(bytes));
      (decoded === null).should.be.false;
      equalBytes(decoded!, bytes).should.be.true;
      decoded!.length.should.equal(bytes.length);
    }
  });

  it('emits no padding and stays inside the url-safe alphabet', function () {
    // All-0xff bytes exercise the high alphabet chars (`+`/`/` → `-`/`_`).
    const text = b64urlEncode(new Uint8Array(32).fill(255));
    text.should.not.match(/[+/=]/);
    text.length.should.equal(43); // ⌈32 bytes → 43⅓ chars⌉, no '=' tail
  });

  it('decodes empty to zero bytes, rejecting padding and bad input with null', function () {
    b64urlDecode('')?.length.should.equal(0);
    // '=' padding is outside the unpadded url-safe contract.
    (b64urlDecode('Zg==') === null).should.be.true;
    (b64urlDecode('Zg=') === null).should.be.true;
    // Out-of-alphabet chars, including the standard-alphabet '+'.
    (b64urlDecode('Zm9v!') === null).should.be.true;
    (b64urlDecode('Zm+v') === null).should.be.true;
    (b64urlDecode('Zm9v+') === null).should.be.true;
    // A final group of 1 char carries only 6 bits — short of a byte.
    (b64urlDecode('Z') === null).should.be.true;
    (b64urlDecode('Zm9vZm9vZ') === null).should.be.true;
    // Non-ASCII input.
    (b64urlDecode('Zm9v\u00e9') === null).should.be.true;
  });

  it('compares bytes: equal, differing, and length-mismatched', function () {
    equalBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])).should.be.true;
    equalBytes(new Uint8Array(0), new Uint8Array(0)).should.be.true;
    equalBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])).should.be.false;
    equalBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2])).should.be.false;
    equalBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])).should.be.false;
  });

  it('encodes standard base64: +// alphabet, padded (RFC 4648 §4)', function () {
    // The same RFC 7636 vectors as the url-safe block above, but partial
    // groups keep their '=' tail — the Basic-auth (RFC 7617) shape.
    b64Encode(new Uint8Array(0)).should.equal('');
    b64Encode(new Uint8Array([102])).should.equal('Zg==');
    b64Encode(new Uint8Array([102, 111])).should.equal('Zm8=');
    b64Encode(new Uint8Array([102, 111, 111])).should.equal('Zm9v');
    // All-0xff drives the encoder into the high alphabet chars — here they
    // must stay '+', '/', unlike b64urlEncode's '-'/'_' translation.
    b64Encode(new Uint8Array(32).fill(255)).should.match(/^[A-Za-z0-9+/]{43}=$/);
  });

  it('decodes standard base64: vectors roundtrip b64Encode (b64Decode)', function () {
    for (const bytes of [
      new Uint8Array(0),
      new Uint8Array([102]),
      new Uint8Array([102, 111]),
      new Uint8Array([102, 111, 111]),
      new Uint8Array(32).fill(255),
    ]) {
      const decoded = b64Decode(b64Encode(bytes));
      (decoded === null).should.be.false;
      equalBytes(decoded!, bytes).should.be.true;
    }
    // Padded vectors, plus the unpadded shape atob accepts.
    Array.from(b64Decode('Zg==') ?? []).should.deep.equal([102]);
    Array.from(b64Decode('Zm8=') ?? []).should.deep.equal([102, 111]);
    Array.from(b64Decode('Zm9v') ?? []).should.deep.equal([102, 111, 111]);
    Array.from(b64Decode('Zm8') ?? []).should.deep.equal([102, 111]);
    // Padding completes the final quantum — a '=' after a whole group,
    // or 3+ pads, is malformed.
    (b64Decode('Zm9v=') === null).should.be.true;
    (b64Decode('Zg===') === null).should.be.true;
    (b64Decode('Zg====') === null).should.be.true;
    // '=' before the trailing run, out-of-alphabet chars, non-ASCII.
    (b64Decode('Zm=9v') === null).should.be.true;
    (b64Decode('Zm9v!') === null).should.be.true;
    (b64Decode('Z\u00e9==') === null).should.be.true;
    // A final group of 1 char carries only 6 bits — short of a byte.
    (b64Decode('Z') === null).should.be.true;
    (b64Decode('Z==') === null).should.be.true;
  });

  it('renders lowercase hex, two chars per byte (toHex)', function () {
    toHex(new Uint8Array(0)).should.equal('');
    toHex(new Uint8Array([0x00, 0x0f, 0xa5, 0xff])).should.equal('000fa5ff');
  });

  it('digests key material to hex (materialDigest)', async function () {
    // FIPS 180-2 change-notice vectors.
    (await materialDigest('abc')).should.equal(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
    (await materialDigest('')).should.equal(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
    // Raw bytes digest as themselves: 'abc' UTF-8 is [97, 98, 99].
    (await materialDigest(new Uint8Array([97, 98, 99]))).should.equal(
      await materialDigest('abc')
    );
    (await materialDigest(new Uint8Array([102, 111, 111]))).should.not.equal(
      await materialDigest('Zm9v') // the base64url TEXT of those bytes
    );
  });

  it('imports one HMAC key per (secret, hash, usage), cached', async function () {
    const signKey = await getHmacKey('cache-me', 'SHA-256', ['sign']);
    (signKey === (await getHmacKey('cache-me', 'SHA-256', ['sign']))).should.be
      .true;
    // A different usage list is a different cache entry — and key.
    const verifyKey = await getHmacKey('cache-me', 'SHA-256', ['sign', 'verify']);
    (signKey === verifyKey).should.be.false;
    signKey.extractable.should.be.false;
    signKey.type.should.equal('secret');
    Array.from(verifyKey.usages).should.deep.equal(['sign', 'verify']);
  });

  it('imports byte secrets as their raw bytes, never re-encoded text', async function () {
    // 'foo' as raw bytes vs the base64url TEXT of those bytes are two
    // different materials — before raw-byte keying they collided on one
    // import (the bytes were first base64url-encoded into a string).
    const bytes = new Uint8Array([102, 111, 111]); // 'foo', b64url 'Zm9v'
    const byteKey = await getHmacKey(bytes, 'SHA-256', ['sign']);
    // The same material spelled as a string shares one import.
    (byteKey === (await getHmacKey('foo', 'SHA-256', ['sign']))).should.be
      .true;
    // The base64url text of the bytes is different material.
    (byteKey === (await getHmacKey('Zm9v', 'SHA-256', ['sign']))).should.be
      .false;
  });

  it('hands the injected cache digest keys, never the secret', async function () {
    const seen: string[] = [];
    const store: HmacKeyCache = {
      get: () => undefined,
      set: (key) => seen.push(key),
    };
    await getHmacKey('top-secret', 'SHA-256', ['sign'], store);
    await getHmacKey('top-secret', 'SHA-256', ['sign'], store);
    seen.length.should.equal(2); // get misses, so both calls import+set.
    seen[0]!.should.match(/^SHA-256:sign:[0-9a-f]{64}$/);
    seen[0]!.should.not.match(/top-secret/);
  });

  it('digests a secret once, however many calls read the key cache', async function () {
    // Before the per-secret digest memo every getHmacKey call — key-cache
    // hit included — paid a full SHA-256 pass rebuilding its cache key.
    const digest = vi.spyOn(crypto.subtle, 'digest');
    try {
      await getHmacKey('memo-me', 'SHA-256', ['sign']);
      await getHmacKey('memo-me', 'SHA-256', ['sign']); // key-cache hit
      await getHmacKey('memo-me', 'SHA-384', ['sign']); // new row, same secret
      digest.mock.calls.length.should.equal(1);
      // A distinct secret digests on its own.
      await getHmacKey('memo-me-2', 'SHA-256', ['sign']);
      digest.mock.calls.length.should.equal(2);
      // Byte secrets memo by object identity: the same array never
      // re-digests, whatever the hash or usage row.
      const bytes = new Uint8Array([9, 9, 9]);
      await getHmacKey(bytes, 'SHA-256', ['sign']);
      await getHmacKey(bytes, 'SHA-512', ['sign']);
      digest.mock.calls.length.should.equal(3);
      // The string memo is FIFO-bounded: 64 newer secrets push 'memo-me'
      // out, so its next use digests again.
      for (let i = 0; i < 64; i += 1) {
        await getHmacKey(`memo-overflow-${i}`, 'SHA-256', ['sign']);
      }
      await getHmacKey('memo-me', 'SHA-256', ['sign']);
      digest.mock.calls.length.should.equal(3 + 64 + 1);
    } finally {
      digest.mockRestore();
    }
  });

  it('imports through an injected store once per secret (set once)', async function () {
    const backing = new Map<string, Promise<CryptoKey>>();
    let sets = 0;
    const store: HmacKeyCache = {
      get: (key) => backing.get(key),
      set: (key, value) => {
        sets += 1;
        backing.set(key, value);
      },
    };
    await getHmacKey('set-once', 'SHA-256', ['sign'], store);
    await getHmacKey('set-once', 'SHA-256', ['sign'], store);
    // The second call is a get hit through the injected store — the
    // digest memo must not change the passthrough contract.
    sets.should.equal(1);
  });

  it('mints random url-safe tokens of the requested entropy (randomToken)', function () {
    for (const bytes of [1, 16, 32, 64]) {
      const token = randomToken(bytes);
      token.should.match(/^[A-Za-z0-9_-]+$/);
      // ⌈bytes·8/6⌉ chars, no '=' tail: 1→2, 16→22, 32→43, 64→86.
      token.length.should.equal(Math.ceil((bytes * 8) / 6));
      // Decodes back to exactly that many bytes.
      b64urlDecode(token)!.length.should.equal(bytes);
    }
    const tokens = new Set(Array.from({ length: 64 }, () => randomToken(16)));
    tokens.size.should.equal(64);
  });

  it('signs and verifies through the shared HMAC helpers (hmacSign/hmacVerify)', async function () {
    const message = new TextEncoder().encode('604800.nonce');
    const sig = await hmacSign(message, 'shared-secret');
    sig.should.match(/^[A-Za-z0-9_-]+$/); // base64url, no '=' tail
    (await hmacVerify(message, sig, 'shared-secret')).should.be.true;
    (await hmacVerify(message, sig, 'other-secret')).should.be.false;
    // A different message, or a mutated/lengthened signature, fails.
    (await hmacVerify(new TextEncoder().encode('604800.nonce.'), sig, 'shared-secret')).should.be.false;
    (await hmacVerify(message, `${sig}x`, 'shared-secret')).should.be.false;
    (await hmacVerify(message, `${sig.slice(0, -1)}`, 'shared-secret')).should.be.false;
    // A malformed signature encoding reads false, never throws.
    (await hmacVerify(message, '!!not-base64url!!', 'shared-secret')).should.be.false;
    (await hmacVerify(message, 'Zg==', 'shared-secret')).should.be.false; // '=' padding
    // Default digest is SHA-256 — byte-identical to a direct subtle sign.
    const key = await getHmacKey('shared-secret', 'SHA-256', ['sign']);
    Array.from(b64urlDecode(sig)!).should.deep.equal(
      Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, message)))
    );
  });

  it('honors the hash option and an injected cache (hmacSign/hmacVerify)', async function () {
    const message = new TextEncoder().encode('scoped');
    const seen: string[] = [];
    const store: HmacKeyCache = { get: () => undefined, set: (key) => seen.push(key) };
    const sig512 = await hmacSign(message, 'scoped-secret', { hash: 'SHA-512', cache: store });
    // The cache row carries the hash and the secret's digest, never the secret.
    seen.length.should.equal(1);
    seen[0]!.should.match(/^SHA-512:sign:[0-9a-f]{64}$/);
    // The same material+hash verifies through the default cache — the
    // injected store is a scope, not a different key derivation.
    (await hmacVerify(message, sig512, 'scoped-secret', { hash: 'SHA-512' })).should.be.true;
    // A different digest is a different signature.
    const sig256 = await hmacSign(message, 'scoped-secret', { cache: store });
    sig256.should.not.equal(sig512);
    seen[1]!.should.match(/^SHA-256:sign:/);
    (await hmacVerify(message, sig256, 'scoped-secret', { hash: 'SHA-512' })).should.be.false;
  });

  it('signs and verifies with a pre-imported CryptoKey untouched', async function () {
    const message = new TextEncoder().encode('passthrough');
    // jwt hands hmacSign/hmacVerify an already-resolved key — no import,
    // no cache hop, no usage negotiation.
    const key = await getHmacKey('passthrough-secret', 'SHA-384', ['sign', 'verify']);
    const sig = await hmacSign(message, key);
    (await hmacVerify(message, sig, key)).should.be.true;
    // Same material through the import path derives the same signature.
    (await hmacVerify(message, sig, 'passthrough-secret', { hash: 'SHA-384' })).should.be.true;
  });
});
