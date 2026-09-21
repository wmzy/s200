import { describe, it } from 'vitest';

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
});

/** base64url for the alg:none probe. */
function b64url(text: string): string {
  return Buffer.from(text).toString('base64url');
}
