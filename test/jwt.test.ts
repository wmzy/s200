import type { JwtKeyStore, JwksEntry, JwksStore } from '../src/jwt';

import { describe, it, vi } from 'vitest';

import { createApp, get, use, handle  } from '../src/app';
import { createJwksResolver, isJwtError, jwtAuth, signJwt, verifyJwt } from '../src/jwt';
import { json } from '../src/respond';

// vitest's should chain has no chai-as-promised plugins (no `rejectedWith`),
// so capture rejections manually and assert on the tagged value.
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined; // resolved — property assertions below will fail
}

describe('jwt', () => {
  const SECRET = 'super-secret';

  it('signs and verifies a round trip with registered claims', async () => {
    const token = await signJwt({ sub: 'u1', role: 'admin' }, SECRET, {
      expiresIn: 60,
      issuer: 's200-test',
    });
    token.split('.').length.should.equal(3);
    const payload = await verifyJwt<{ role: string }>(token, SECRET, { issuer: 's200-test' });
    payload.role.should.equal('admin');
    payload.sub?.should.equal('u1');
    payload.iat?.should.be.a('number');
    payload.exp?.should.be.a('number');
  });

  it('rejects tampering, wrong secret, expiry and unknown algorithms', async () => {
    const expired = await signJwt({ a: 1 }, SECRET, { expiresIn: -1 });
    const expiredErr = (await rejectionOf(verifyJwt(expired, SECRET))) as Error;
    expiredErr.message.should.match(/expired/);
    isJwtError(expiredErr).should.be.true;

    const [header, payload, sig] = expired.split('.');
    const tampered = `${header}.${payload}.${'0'.repeat(sig?.length ?? 0)}`;
    ((await rejectionOf(verifyJwt(tampered, SECRET))) as Error).message.should.match(
      /signature/
    );

    const signed = await signJwt({ a: 1 }, SECRET);
    ((await rejectionOf(verifyJwt(signed, 'other-secret'))) as Error).message.should.match(
      /signature/
    );

    // An alg:none token is structurally rejected (non-empty dummy sig).
    const none = `${b64url('{"alg":"none"}')}.${b64url('{"a":1}')}.AAAA`;
    ((await rejectionOf(verifyJwt(none, SECRET))) as Error).message.should.match(/algorithm/);
  });

  it('enforces audience, issuer and not-before', async () => {
    const token = await signJwt({}, SECRET, { audience: 'api', notBefore: 5 });
    ((await rejectionOf(verifyJwt(token, SECRET))) as Error).message.should.match(/not yet valid/);

    // Time claims gate before audience; use a token that is otherwise
    // valid to reach the audience check.
    const audToken = await signJwt({}, SECRET, { audience: 'api' });
    ((await rejectionOf(verifyJwt(audToken, SECRET, { audience: 'other' }))) as Error).message.should.match(
      /audience/
    );
    await verifyJwt(token, SECRET, { audience: 'api', clockTolerance: 10 });
  });

  it('gates routes via the middleware and stores the payload on ctx.state', async () => {
    const app = createApp();
    use(app, jwtAuth({ secret: SECRET }));
    get(app, '/me', (ctx) => json(ctx, { sub: (ctx.state.jwt as { sub: string }).sub }));

    const missing = await handle(app, new Request('http://localhost/me'));
    missing.status.should.equal(401);

    const token = await signJwt({ sub: 'u1' }, SECRET);
    const ok = await handle(
      app,
      new Request('http://localhost/me', {
        headers: { authorization: `Bearer ${token}` },
      })
    );
    ok.status.should.equal(200);
    (await ok.json()).should.deep.equal({ sub: 'u1' });
  });

  it('reads tokens from a cookie and answers 401 for invalid ones', async () => {
    const app = createApp();
    use(app, jwtAuth({ secret: SECRET, cookie: 'session' }));
    get(app, '/me', () => new Response('ok'));

    const token = await signJwt({ sub: 'u1' }, SECRET);
    const ok = await handle(
      app,
      new Request('http://localhost/me', {
        headers: { cookie: `session=${encodeURIComponent(token)}` },
      })
    );
    ok.status.should.equal(200);

    const bad = await handle(
      app,
      new Request('http://localhost/me', { headers: { cookie: 'session=garbage' } })
    );
    bad.status.should.equal(401);
  });

  it('signs and verifies RS256/PS256 round trips', async () => {
    const { privateKey, publicKey } = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify']
    );
    const rs = await signJwt({ sub: 'rs' }, privateKey, { alg: 'RS256' });
    (await verifyJwt(rs, publicKey)).sub?.should.equal('rs');

    const pss = await crypto.subtle.generateKey(
      { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify']
    );
    const ps = await signJwt({ sub: 'ps' }, pss.privateKey, { alg: 'PS256' });
    (await verifyJwt(ps, pss.publicKey)).sub?.should.equal('ps');

    // Tampering still rejects.
    const [h, p, s] = ps.split('.');
    const forged = `${h}.${p}.${'0'.repeat(s?.length ?? 0)}`;
    ((await rejectionOf(verifyJwt(forged, pss.publicKey))) as Error).message.should.match(/signature/);
  });

  it('signs and verifies ES256 round trips', async () => {
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    const token = await signJwt({ sub: 'es' }, pair.privateKey, { alg: 'ES256' });
    (await verifyJwt(token, pair.publicKey)).sub?.should.equal('es');
  });

  it('signs and verifies with JWK material', async () => {
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    const token = await signJwt({ sub: 'jwk' }, privateJwk, { alg: 'ES256' });
    (await verifyJwt(token, publicJwk)).sub?.should.equal('jwk');
  });

  it('signs and verifies EdDSA (Ed25519) round trips and rejects tampering', async () => {
    const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const token = await signJwt({ sub: 'ed' }, pair.privateKey, { alg: 'EdDSA' });
    token.split('.').length.should.equal(3);
    (await verifyJwt(token, pair.publicKey)).sub?.should.equal('ed');

    const [h, p, s] = token.split('.');
    const forged = `${h}.${p}.${'0'.repeat(s?.length ?? 0)}`;
    ((await rejectionOf(verifyJwt(forged, pair.publicKey))) as Error).message.should.match(
      /signature/
    );
  });

  it('signs and verifies EdDSA with OKP JWK material', async () => {
    const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    publicJwk.kty?.should.equal('OKP');
    publicJwk.crv?.should.equal('Ed25519');
    const token = await signJwt({ sub: 'okp' }, privateJwk, { alg: 'EdDSA' });
    (await verifyJwt(token, publicJwk)).sub?.should.equal('okp');
  });

  it('rejects EdDSA key-family and curve mismatches (algorithm confusion)', async () => {
    const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const token = await signJwt({ a: 1 }, pair.privateKey, { alg: 'EdDSA' });

    // A secret string is not OKP material.
    ((await rejectionOf(verifyJwt(token, SECRET))) as Error).message.should.match(
      /kty 'undefined' does not match algorithm EdDSA/
    );
    // An X25519 key shares the OKP family but cannot sign.
    const x25519 = await crypto.subtle.generateKey('X25519', true, ['deriveKey']);
    ((await rejectionOf(verifyJwt(token, x25519.publicKey))) as Error).message.should.match(
      /key does not match algorithm EdDSA/
    );
    // An OKP JWK with the wrong curve rejects before import.
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    ((await rejectionOf(verifyJwt(token, { ...jwk, crv: 'Ed448' }))) as Error).message.should.match(
      /crv 'Ed448' does not match algorithm EdDSA/
    );
    // An EC key cannot verify an EdDSA token, nor the reverse.
    const ec = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    ((await rejectionOf(verifyJwt(token, ec.publicKey))) as Error).message.should.match(
      /key does not match algorithm EdDSA/
    );
    const ecToken = await signJwt({ a: 1 }, ec.privateKey, { alg: 'ES256' });
    ((await rejectionOf(verifyJwt(ecToken, pair.publicKey))) as Error).message.should.match(
      /key does not match algorithm ES256/
    );
  });

  it('rejects family-mismatched keys (algorithm confusion)', async () => {
    const token = await signJwt({ a: 1 }, SECRET, { alg: 'HS256' });
    // An RSA public key can never verify an HS token: the key family must
    // match the header alg.
    const pair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify']
    );
    const err = (await rejectionOf(verifyJwt(token, pair.publicKey))) as Error;
    err.message.should.match(/HMAC algorithm HS256 requires a secret/);
  });

  it('resolves keys from a JWKS by kid', async () => {
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const kid = 'key-1';
    const jwks = JSON.stringify({ keys: [{ ...publicJwk, kid }] });
    const resolver = createJwksResolver('https://idp.test/jwks', {
      fetchFn: async () => new Response(jwks, { status: 200 }),
    });
    const token = await signJwt({ sub: 'kid' }, pair.privateKey, { alg: 'ES256', jwtId: kid });
    // Without a kid in the token, the first key serves; with one, it must match.
    (await verifyJwt(token, await resolver({ alg: 'ES256' }))).sub?.should.equal('kid');
    // An unknown kid rejects inside the resolver itself.
    const missing = (await rejectionOf(
      Promise.resolve().then(() => resolver({ alg: 'ES256', kid: 'key-2' }))
    )) as Error;
    missing.message.should.match(/no jwks key/);
  });

  it('refetches the jwks document once when a fresh cache misses the kid', async () => {
    const pairA = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    const pairB = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    const jwkA = await crypto.subtle.exportKey('jwk', pairA.publicKey);
    const jwkB = await crypto.subtle.exportKey('jwk', pairB.publicKey);
    let served = JSON.stringify({ keys: [{ ...jwkA, kid: 'A' }] });
    let fetches = 0;
    const fetchFn = async () => {
      fetches += 1;
      return new Response(served, { status: 200 });
    };
    const resolver = createJwksResolver('https://idp-rotate.test/jwks', {
      ttlMs: 600_000,
      fetchFn,
    });
    const tokenA = await signJwt({ sub: 'a' }, pairA.privateKey, { alg: 'ES256' });
    (await verifyJwt(tokenA, await resolver({ alg: 'ES256', kid: 'A' }))).sub?.should.equal('a');
    fetches.should.equal(1);
    // Rotation: the stub now serves kid B only.
    served = JSON.stringify({ keys: [{ ...jwkB, kid: 'B' }] });
    const tokenB = await signJwt({ sub: 'b' }, pairB.privateKey, { alg: 'ES256' });
    // kid B misses the fresh (mid-TTL) cache → exactly one forced refetch.
    (await verifyJwt(tokenB, await resolver({ alg: 'ES256', kid: 'B' }))).sub?.should.equal('b');
    fetches.should.equal(2);
    // A kid unknown to both documents fails without another outbound
    // fetch: the forced-refetch cooldown from the kid B rotation is still
    // open.
    const unknown = (await rejectionOf(
      Promise.resolve().then(() => resolver({ alg: 'ES256', kid: 'C' }))
    )) as Error;
    unknown.message.should.match(/no jwks key for kid 'C'/);
    fetches.should.equal(2);
  });

  it('does not refetch on a kid miss when this call just fetched the document', async () => {
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    let fetches = 0;
    const fetchFn = async () => {
      fetches += 1;
      return new Response(
        JSON.stringify({ keys: [{ ...publicJwk, kid: 'A' }] }),
        { status: 200 }
      );
    };
    // Cold cache: the miss happens against a document this call fetched,
    // so the forced refetch must not fire a second time.
    const resolver = createJwksResolver('https://idp-cold.test/jwks', {
      ttlMs: 600_000,
      fetchFn,
    });
    const missing = (await rejectionOf(
      Promise.resolve().then(() => resolver({ alg: 'ES256', kid: 'B' }))
    )) as Error;
    missing.message.should.match(/no jwks key for kid 'B'/);
    fetches.should.equal(1);
  });

  it('bounds forced jwks refetches for unknown kids and keeps the cached TTL', async () => {
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    let served = JSON.stringify({ keys: [{ ...publicJwk, kid: 'A' }] });
    let fetches = 0;
    const fetchFn = async () => {
      fetches += 1;
      return new Response(served, { status: 200 });
    };
    const url = 'https://idp-bounded.test/jwks';
    const backing = new Map<string, JwksEntry>();
    const store: JwksStore = {
      get: (key) => backing.get(key),
      set: (key, entry) => backing.set(key, entry),
    };
    // Fake only the clock: fetch and WebCrypto stay real.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(0);
      const resolver = createJwksResolver(url, { ttlMs: 600_000, fetchFn, store });
      await resolver({ alg: 'ES256', kid: 'A' });
      fetches.should.equal(1);
      const document = backing.get(url);
      (document === undefined).should.equal(false);
      // A burst of unknown kids: one forced refetch total, then the
      // cooldown answers without touching the network.
      for (let i = 0; i < 5; i += 1) {
        const missing = (await rejectionOf(
          Promise.resolve().then(() => resolver({ alg: 'ES256', kid: 'ghost' }))
        )) as Error;
        missing.message.should.match(/no jwks key for kid 'ghost'/);
      }
      fetches.should.equal(2);
      // The fruitless forced refetch did not replace the document or
      // push its refresh deadline forward.
      backing.get(url)!.should.equal(document);
      // Past the 30 s cooldown, still mid-TTL: another forced refetch runs.
      vi.setSystemTime(30_001);
      await rejectionOf(
        Promise.resolve().then(() => resolver({ alg: 'ES256', kid: 'ghost' }))
      );
      fetches.should.equal(3);
      // The normal TTL path still picks up a rotation.
      served = JSON.stringify({ keys: [{ ...publicJwk, kid: 'B' }] });
      vi.setSystemTime(600_001);
      const rotated = (await resolver({ alg: 'ES256', kid: 'B' })) as JsonWebKey & {
        kid?: string;
      };
      rotated.kid?.should.equal('B');
      fetches.should.equal(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keys the import cache by a secret digest, never the raw secret', async () => {
    const secret = 'raw-secret-that-must-not-leak';
    const token = await signJwt({ sub: 'digest' }, secret);
    const keys: string[] = [];
    const backing = new Map<string, Promise<CryptoKey>>();
    const store: JwtKeyStore = {
      get: (key) => {
        keys.push(key);
        return backing.get(key);
      },
      set: (key, value) => {
        keys.push(key);
        backing.set(key, value);
      },
    };
    (await verifyJwt(token, secret, { keyStore: store })).sub?.should.equal('digest');
    keys.length.should.equal(2); // one get, one set
    keys.every((key) => !key.includes(secret)).should.equal(true);
    keys[0]!.should.match(/^SHA-256:sign\+verify:[0-9a-f]{64}$/);
    keys[0]!.should.equal(keys[1]);
    // The digest is stable, so the same secret + usages is a cache hit.
    await verifyJwt(token, secret, { keyStore: store });
    backing.size.should.equal(1);
  });

  it('gates routes through jwtAuth with a jwks endpoint', async () => {
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const jwks = JSON.stringify({ keys: [{ ...publicJwk, kid: 'k1' }] });
    // The resolver captures the fetch implementation at construction —
    // stub the global before building the app.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(jwks, { status: 200 });
    try {
      const app = createApp();
      // Distinct URL: the resolver cache is module-wide (5-minute TTL),
      // so tests must not share an endpoint.
      use(app, jwtAuth({ jwks: { url: 'https://idp-auth.test/jwks', ttlMs: 60_000 } }));
      get(app, '/me', () => new Response('ok'));

      const token = await signJwt({ sub: 'g' }, pair.privateKey, { alg: 'ES256' });
      const ok = await handle(
        app,
        new Request('http://localhost/me', { headers: { authorization: `Bearer ${token}` } })
      );
      ok.status.should.equal(200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('forwards audience and issuer checks through the gate', async () => {
    const app = createApp();
    use(app, jwtAuth({ secret: SECRET, audience: 'api', issuer: 's200-test' }));
    get(app, '/me', () => new Response('ok'));

    const good = await signJwt({ sub: 'u1' }, SECRET, { audience: 'api', issuer: 's200-test' });
    const ok = await handle(
      app,
      new Request('http://localhost/me', { headers: { authorization: `Bearer ${good}` } })
    );
    ok.status.should.equal(200);

    const wrongAudience = await signJwt({ sub: 'u1' }, SECRET, {
      audience: 'other',
      issuer: 's200-test',
    });
    const aud401 = await handle(
      app,
      new Request('http://localhost/me', { headers: { authorization: `Bearer ${wrongAudience}` } })
    );
    aud401.status.should.equal(401);

    const wrongIssuer = await signJwt({ sub: 'u1' }, SECRET, {
      audience: 'api',
      issuer: 'who-else',
    });
    const iss401 = await handle(
      app,
      new Request('http://localhost/me', { headers: { authorization: `Bearer ${wrongIssuer}` } })
    );
    iss401.status.should.equal(401);
  });

  it('honors clockTolerance and requireExpiry through the gate', async () => {
    // 5 s past exp — inside a 10 s skew tolerance, outside the default 0.
    const barelyExpired = await signJwt({ sub: 'u1' }, SECRET, { expiresIn: -5 });

    const tolerant = createApp();
    use(tolerant, jwtAuth({ secret: SECRET, clockTolerance: 10 }));
    get(tolerant, '/me', () => new Response('ok'));
    const ok = await handle(
      tolerant,
      new Request('http://localhost/me', { headers: { authorization: `Bearer ${barelyExpired}` } })
    );
    ok.status.should.equal(200);

    const strict = createApp();
    use(strict, jwtAuth({ secret: SECRET }));
    get(strict, '/me', () => new Response('ok'));
    const gone = await handle(
      strict,
      new Request('http://localhost/me', { headers: { authorization: `Bearer ${barelyExpired}` } })
    );
    gone.status.should.equal(401);

    // signJwt adds iat but never exp without expiresIn.
    const noExp = await signJwt({ sub: 'u1' }, SECRET);
    const missingErr = (await rejectionOf(
      verifyJwt(noExp, SECRET, { requireExpiry: true })
    )) as Error;
    missingErr.message.should.match(/missing exp/);

    const demanding = createApp();
    use(demanding, jwtAuth({ secret: SECRET, requireExpiry: true }));
    get(demanding, '/me', () => new Response('ok'));
    const rejected = await handle(
      demanding,
      new Request('http://localhost/me', { headers: { authorization: `Bearer ${noExp}` } })
    );
    rejected.status.should.equal(401);
    // Unset (the default) keeps accepting exp-less tokens.
    const lax = createApp();
    use(lax, jwtAuth({ secret: SECRET }));
    get(lax, '/me', () => new Response('ok'));
    const laxOk = await handle(
      lax,
      new Request('http://localhost/me', { headers: { authorization: `Bearer ${noExp}` } })
    );
    laxOk.status.should.equal(200);
  });

  it('bounds the default key cache: LRU evicts the oldest import', async () => {
    const token = await signJwt({ a: 1 }, 'key-lru-anchor');
    // WebCrypto spec-mandates a DataError for zero-length HMAC keys, and
    // the rejection is cached like any import: replaying the same cached
    // rejected promise re-throws the identical Error object — the one
    // observable difference between a cache hit and a re-import.
    const first = (await rejectionOf(verifyJwt(token, ''))) as Error;
    const again = (await rejectionOf(verifyJwt(token, ''))) as Error;
    again.should.equal(first);
    // 100 distinct secrets (the default bound) push the entry out.
    for (let i = 0; i < 100; i += 1) {
      await rejectionOf(verifyJwt(token, `key-lru-${i}`));
    }
    const reimported = (await rejectionOf(verifyJwt(token, ''))) as Error;
    reimported.should.not.equal(first);
  });

  it('bounds the default jwks cache: LRU evicts the least recently used URL', async () => {
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const jwks = JSON.stringify({ keys: [{ ...publicJwk, kid: 'k' }] });
    let fetches = 0;
    const fetchFn = async () => {
      fetches += 1;
      return new Response(jwks, { status: 200 });
    };
    const resolverAt = (i: number) =>
      createJwksResolver(`https://idp-lru.test/jwks-${i}`, { ttlMs: 600_000, fetchFn });
    // Fill the cache to its bound (50 URLs).
    for (let i = 0; i < 50; i += 1) {
      await resolverAt(i)({ alg: 'ES256' });
    }
    fetches.should.equal(50);
    // Touching URL 0 bumps its recency without a refetch.
    await resolverAt(0)({ alg: 'ES256' });
    fetches.should.equal(50);
    // One more URL evicts the oldest — URL 1, not the touched URL 0.
    await resolverAt(50)({ alg: 'ES256' });
    fetches.should.equal(51);
    await resolverAt(0)({ alg: 'ES256' });
    fetches.should.equal(51);
    await resolverAt(1)({ alg: 'ES256' });
    fetches.should.equal(52);
  });

  it('verifies through an injected key store, bypassing the default cache', async () => {
    const token = await signJwt({ sub: 'store' }, 'inject-key-secret');
    const backing = new Map<string, Promise<CryptoKey>>();
    const gets: string[] = [];
    const store: JwtKeyStore = {
      get: (key) => {
        gets.push(key);
        return backing.get(key);
      },
      set: (key, value) => {
        backing.set(key, value);
      },
    };
    (await verifyJwt(token, 'inject-key-secret', { keyStore: store })).sub?.should.equal('store');
    gets.length.should.equal(1);
    backing.size.should.equal(1);
    // The second verify is a store hit — no fresh import, no growth.
    await verifyJwt(token, 'inject-key-secret', { keyStore: store });
    gets.length.should.equal(2);
    backing.size.should.equal(1);
    // A pre-imported key served verbatim from the store verifies too.
    const preseeded = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('preseeded-secret'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify']
    );
    const preToken = await signJwt({ sub: 'pre' }, 'preseeded-secret');
    (await verifyJwt(preToken, 'preseeded-secret', {
      keyStore: { get: () => Promise.resolve(preseeded), set: () => undefined },
    })).sub?.should.equal('pre');
  });

  it('serves jwks resolution from an injected store with TTL refresh intact', async () => {
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const jwks = JSON.stringify({ keys: [{ ...publicJwk, kid: 'k' }] });
    let fetches = 0;
    const fetchFn = async () => {
      fetches += 1;
      return new Response(jwks, { status: 200 });
    };
    const backing = new Map<string, JwksEntry>();
    const store: JwksStore = {
      get: (url) => backing.get(url),
      set: (url, entry) => backing.set(url, entry),
    };
    const resolver = createJwksResolver('https://idp-injected.test/jwks', {
      ttlMs: 600_000,
      fetchFn,
      store,
    });
    await resolver({ alg: 'ES256' });
    await resolver({ alg: 'ES256', kid: 'k' });
    fetches.should.equal(1);
    backing.size.should.equal(1);
    // An expired entry refreshes even in an injected store.
    const stale = new Map<string, JwksEntry>([
      ['https://idp-stale.test/jwks', { exp: Date.now() - 1, keys: [{ kid: 'old' }] }],
    ]);
    const staleResolver = createJwksResolver('https://idp-stale.test/jwks', {
      ttlMs: 600_000,
      fetchFn,
      store: { get: (url) => stale.get(url), set: (url, entry) => stale.set(url, entry) },
    });
    ((await staleResolver({ alg: 'ES256', kid: 'k' })) as JsonWebKey & { kid?: string }).kid?.should.equal('k');
    fetches.should.equal(2);
    // An unexpired pre-seeded entry skips the fetch entirely.
    const fresh = new Map<string, JwksEntry>([
      ['https://idp-fresh.test/jwks', { exp: Date.now() + 600_000, keys: [{ ...publicJwk, kid: 'seeded' }] }],
    ]);
    const freshResolver = createJwksResolver('https://idp-fresh.test/jwks', {
      fetchFn,
      store: { get: (url) => fresh.get(url), set: () => undefined },
    });
    ((await freshResolver({ alg: 'ES256', kid: 'seeded' })) as JsonWebKey & { kid?: string }).kid?.should.equal('seeded');
    fetches.should.equal(2);
  });

  it('threads an injected key store through jwtAuth', async () => {
    const sets: string[] = [];
    const store: JwtKeyStore = {
      get: () => undefined,
      set: (key) => {
        sets.push(key);
      },
    };
    const app = createApp();
    use(app, jwtAuth({ secret: 'auth-store-secret', keyStore: store }));
    get(app, '/me', () => new Response('ok'));
    const token = await signJwt({ sub: 'a' }, 'auth-store-secret');
    const ok = await handle(
      app,
      new Request('http://localhost/me', { headers: { authorization: `Bearer ${token}` } })
    );
    ok.status.should.equal(200);
    sets.length.should.equal(1);
  });

  it('accepts a jwks store through the jwtAuth shorthand', async () => {
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    let fetches = 0;
    const backing = new Map<string, JwksEntry>();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetches += 1;
      return new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: 'k1' }] }));
    };
    try {
      const app = createApp();
      use(app, jwtAuth({
        jwks: {
          url: 'https://idp-shorthand.test/jwks',
          store: { get: (url) => backing.get(url), set: (url, entry) => backing.set(url, entry) },
        },
      }));
      get(app, '/me', () => new Response('ok'));
      const token = await signJwt({ sub: 'g' }, pair.privateKey, { alg: 'ES256' });
      const ok = await handle(
        app,
        new Request('http://localhost/me', { headers: { authorization: `Bearer ${token}` } })
      );
      ok.status.should.equal(200);
      fetches.should.equal(1);
      backing.size.should.equal(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/** base64url for the alg:none probe. */
function b64url(text: string): string {
  return Buffer.from(text).toString('base64url');
}
