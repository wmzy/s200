import { describe, it } from 'vitest';

import { b64urlDecode, b64urlEncode, equalBytes } from '../src/crypto-util';

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
});
