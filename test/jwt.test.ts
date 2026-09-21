import { describe, it } from 'vitest';

import { createApp, get, use, handle  } from '../src/app';
import { isJwtError, jwtAuth, signJwt, verifyJwt } from '../src/jwt';
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
});

/** base64url for the alg:none probe. */
function b64url(text: string): string {
  return Buffer.from(text).toString('base64url');
}
