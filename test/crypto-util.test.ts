import { describe, it } from 'vitest';

import {
  b64Encode,
  b64urlDecode,
  b64urlEncode,
  equalBytes,
  getHmacKey,
  materialDigest,
  randomToken,
  toHex,
  type HmacKeyCache,
} from '../src/crypto-util';

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

  it('hands the injected cache digest keys, never the secret', async function () {
    const seen: string[] = [];
    const store: HmacKeyCache = {
      lruGet: () => undefined,
      lruSet: (key) => seen.push(key),
    };
    await getHmacKey('top-secret', 'SHA-256', ['sign'], store);
    await getHmacKey('top-secret', 'SHA-256', ['sign'], store);
    seen.length.should.equal(2); // lruGet misses, so both calls import+set.
    seen[0]!.should.match(/^SHA-256:sign:[0-9a-f]{64}$/);
    seen[0]!.should.not.match(/top-secret/);
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
});
