import { describe, it } from 'vitest';

import { createApp, get, post, use, handle } from '../src/app';
import { createCsrf } from '../src/csrf';
import { json } from '../src/respond';

describe('csrf', () => {
  const SECRET = 'test-secret';
  const build = () => {
    const app = createApp();
    const csrf = createCsrf({ secret: SECRET });
    use(app, csrf.middleware);
    get(app, '/form', (ctx) => json(ctx, { token: ctx.state.csrfToken }));
    post(app, '/submit', () => new Response('saved', { status: 200 }));
    return { app, csrf };
  };

  async function readSetCookie(res: Response): Promise<string> {
    const setCookie = res.headers
      .getSetCookie()
      .find((c) => c.startsWith('csrf_token='));
    if (setCookie === undefined) {
      throw new Error('no csrf cookie set');
    }
    return decodeURIComponent(setCookie.split(';')[0]?.split('=')[1] ?? '');
  }

  it('sets a cookie on safe responses and echoes the same token to the page', async () => {
    const { app } = build();
    const res = await handle(app, new Request('http://localhost/form'));
    res.status.should.equal(200);
    const cookieToken = await readSetCookie(res);
    const pageToken = ((await res.json()) as { token: string }).token;
    pageToken.should.equal(cookieToken);
  });

  it('token(ctx) reuses the middleware-installed token instead of minting', async () => {
    const app = createApp();
    const csrf = createCsrf({ secret: SECRET });
    use(app, csrf.middleware);
    // The handler runs after the middleware, so the per-request token is
    // already installed — token() must echo it, not mint a second one.
    get(app, '/page', async (ctx) => json(ctx, { token: await csrf.token(ctx) }));

    const res = await handle(app, new Request('http://localhost/page'));
    ((await res.json()) as { token: string }).token.should.equal(
      await readSetCookie(res)
    );
  });

  it('signs and verifies with a Uint8Array secret', async () => {
    const app = createApp();
    const csrf = createCsrf({ secret: new Uint8Array([7, 0, 255, 1, 99, 200, 3, 3]) });
    use(app, csrf.middleware);
    get(app, '/form', (ctx) => json(ctx, { token: ctx.state.csrfToken }));
    post(app, '/submit', () => new Response('saved', { status: 200 }));

    const form = await handle(app, new Request('http://localhost/form'));
    const token = await readSetCookie(form);
    const ok = await handle(
      app,
      new Request('http://localhost/submit', {
        method: 'POST',
        headers: { 'x-csrf-token': token },
      })
    );
    ok.status.should.equal(200);
  });

  it('expires tokens by the injected clock', async () => {
    let ms = 1_700_000_000_000;
    const app = createApp();
    const csrf = createCsrf({ secret: SECRET, ttl: 60, now: () => ms });
    use(app, csrf.middleware);
    get(app, '/form', (ctx) => json(ctx, { token: ctx.state.csrfToken }));
    post(app, '/submit', () => new Response('saved', { status: 200 }));

    const form = await handle(app, new Request('http://localhost/form'));
    const token = await readSetCookie(form);

    // Mid-TTL on the same clock: accepted.
    ms += 30_000;
    const ok = await handle(
      app,
      new Request('http://localhost/submit', {
        method: 'POST',
        headers: { 'x-csrf-token': token },
      })
    );
    ok.status.should.equal(200);

    // Past the TTL: deterministically rejected, no fake timers.
    ms += 31_000;
    const stale = await handle(
      app,
      new Request('http://localhost/submit', {
        method: 'POST',
        headers: { 'x-csrf-token': token },
      })
    );
    stale.status.should.equal(403);
  });

  it('rejects unsafe requests without a token, then accepts the cookie token', async () => {
    const { app } = build();
    const form = await handle(app, new Request('http://localhost/form'));
    const token = await readSetCookie(form);

    const missing = await handle(
      app,
      new Request('http://localhost/submit', { method: 'POST' })
    );
    missing.status.should.equal(403);

    const ok = await handle(
      app,
      new Request('http://localhost/submit', {
        method: 'POST',
        headers: {
          cookie: `csrf_token=${encodeURIComponent(token)}`,
          'x-csrf-token': token,
        },
      })
    );
    ok.status.should.equal(200);
    (await ok.text()).should.equal('saved');
  });

  it('accepts the token from a urlencoded form field', async () => {
    const { app } = build();
    const form = await handle(app, new Request('http://localhost/form'));
    const token = await readSetCookie(form);

    const body = new URLSearchParams({ _csrf: token, note: 'hi' });
    const res = await handle(
      app,
      new Request('http://localhost/submit', {
        method: 'POST',
        headers: {
          cookie: `csrf_token=${encodeURIComponent(token)}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body,
      })
    );
    res.status.should.equal(200);
  });

  it('reads the urlencoded field across content-type parameters', async () => {
    const { app } = build();
    const form = await handle(app, new Request('http://localhost/form'));
    const token = await readSetCookie(form);

    const res = await handle(
      app,
      new Request('http://localhost/submit', {
        method: 'POST',
        headers: {
          cookie: `csrf_token=${encodeURIComponent(token)}`,
          'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
        },
        body: new URLSearchParams({ _csrf: token, note: 'hi' }),
      })
    );
    res.status.should.equal(200);
  });

  it('reads the token from a multipart form field', async () => {
    const { app } = build();
    const form = await handle(app, new Request('http://localhost/form'));
    const token = await readSetCookie(form);

    const fields = new FormData();
    fields.set('_csrf', token);
    fields.set('note', 'hi');
    const res = await handle(
      app,
      new Request('http://localhost/submit', {
        method: 'POST',
        headers: { cookie: `csrf_token=${encodeURIComponent(token)}` },
        body: fields,
      })
    );
    res.status.should.equal(200);
  });

  it('does not form-parse a lookalike content type', async () => {
    const { app } = build();
    const form = await handle(app, new Request('http://localhost/form'));
    const token = await readSetCookie(form);

    // Shares the prefix but is not the media type — the body must not be
    // pulled through a form parse, so the token counts as missing.
    const res = await handle(
      app,
      new Request('http://localhost/submit', {
        method: 'POST',
        headers: {
          cookie: `csrf_token=${encodeURIComponent(token)}`,
          'content-type': 'application/x-www-form-urlencodedish',
        },
        body: new URLSearchParams({ _csrf: token, note: 'hi' }),
      })
    );
    res.status.should.equal(403);
  });

  it('rejects forged and expired tokens', async () => {
    const { app } = build();
    const forged = `9999999999999.${'A'.repeat(22)}.${'B'.repeat(43)}`;
    const res = await handle(
      app,
      new Request('http://localhost/submit', {
        method: 'POST',
        headers: { 'x-csrf-token': forged },
      })
    );
    res.status.should.equal(403);
  });

  it('rejects a mismatched Origin even with a valid token', async () => {
    const { app } = build();
    const form = await handle(app, new Request('http://localhost/form'));
    const token = await readSetCookie(form);

    const res = await handle(
      app,
      new Request('http://localhost/submit', {
        method: 'POST',
        headers: {
          origin: 'https://evil.example',
          'x-csrf-token': token,
        },
      })
    );
    res.status.should.equal(403);
  });

  it('passes a same-origin request with Origin present', async () => {
    const { app } = build();
    const form = await handle(app, new Request('http://localhost/form'));
    const token = await readSetCookie(form);

    const res = await handle(
      app,
      new Request('http://localhost/submit', {
        method: 'POST',
        headers: { origin: 'http://localhost', 'x-csrf-token': token },
      })
    );
    res.status.should.equal(200);
  });

  it('rejects a cross-site sec-fetch-site request before the token check', async () => {
    const { app } = build();
    const form = await handle(app, new Request('http://localhost/form'));
    const token = await readSetCookie(form);

    const noToken = await handle(
      app,
      new Request('http://localhost/submit', {
        method: 'POST',
        headers: { 'sec-fetch-site': 'cross-site' },
      })
    );
    noToken.status.should.equal(403);

    // even a valid token cannot pass an explicitly cross-site request
    const withToken = await handle(
      app,
      new Request('http://localhost/submit', {
        method: 'POST',
        headers: { 'sec-fetch-site': 'cross-site', 'x-csrf-token': token },
      })
    );
    withToken.status.should.equal(403);
  });

  it('lets same-origin, same-site, and none sec-fetch-site values through to the token check', async () => {
    const { app } = build();
    const form = await handle(app, new Request('http://localhost/form'));
    const token = await readSetCookie(form);

    for (const value of ['same-origin', 'same-site', 'none']) {
      const missing = await handle(
        app,
        new Request('http://localhost/submit', {
          method: 'POST',
          headers: { 'sec-fetch-site': value },
        })
      );
      missing.status.should.equal(403);
      // the site check passed — the rejection came from the token check
      ((await missing.json()) as { error: string }).error.should.equal(
        'CSRF token missing'
      );

      const ok = await handle(
        app,
        new Request('http://localhost/submit', {
          method: 'POST',
          headers: { 'sec-fetch-site': value, 'x-csrf-token': token },
        })
      );
      ok.status.should.equal(200);
    }
  });

  it('binds tokens to the current bind value: same value accepted, another rejected', async () => {
    let session = 'session-a';
    const app = createApp();
    const csrf = createCsrf({ secret: SECRET, bind: () => session });
    use(app, csrf.middleware);
    get(app, '/form', (ctx) => json(ctx, { token: ctx.state.csrfToken }));
    post(app, '/submit', () => new Response('saved', { status: 200 }));

    const form = await handle(app, new Request('http://localhost/form'));
    const token = await readSetCookie(form);

    const same = await handle(
      app,
      new Request('http://localhost/submit', {
        method: 'POST',
        headers: {
          cookie: `csrf_token=${encodeURIComponent(token)}`,
          'x-csrf-token': token,
        },
      })
    );
    same.status.should.equal(200);

    session = 'session-b';
    const other = await handle(
      app,
      new Request('http://localhost/submit', {
        method: 'POST',
        headers: {
          cookie: `csrf_token=${encodeURIComponent(token)}`,
          'x-csrf-token': token,
        },
      })
    );
    other.status.should.equal(403);

    // the next safe request replaces the foreign-bound cookie
    const refreshed = await handle(
      app,
      new Request('http://localhost/form', {
        headers: { cookie: `csrf_token=${encodeURIComponent(token)}` },
      })
    );
    const freshCookie = await readSetCookie(refreshed);
    freshCookie.should.not.equal(token);
    const ok = await handle(
      app,
      new Request('http://localhost/submit', {
        method: 'POST',
        headers: { 'x-csrf-token': freshCookie },
      })
    );
    ok.status.should.equal(200);
  });

  it('supports an async bind callback', async () => {
    const app = createApp();
    const csrf = createCsrf({ secret: SECRET, bind: async () => 'user-42' });
    use(app, csrf.middleware);
    get(app, '/form', (ctx) => json(ctx, { token: ctx.state.csrfToken }));
    post(app, '/submit', () => new Response('saved', { status: 200 }));

    const form = await handle(app, new Request('http://localhost/form'));
    const token = await readSetCookie(form);
    const res = await handle(
      app,
      new Request('http://localhost/submit', {
        method: 'POST',
        headers: { 'x-csrf-token': token },
      })
    );
    res.status.should.equal(200);
  });

  it('issueToken mints a fresh verifiable token; the old one stays valid until its TTL', async () => {
    const { app, csrf } = build();
    get(app, '/rotate', async (ctx) =>
      json(ctx, { token: await csrf.issueToken(ctx) })
    );

    const form = await handle(app, new Request('http://localhost/form'));
    const oldToken = await readSetCookie(form);

    const rotated = await handle(app, new Request('http://localhost/rotate'));
    rotated.status.should.equal(200);
    const fresh = ((await rotated.json()) as { token: string }).token;
    fresh.should.not.equal(oldToken);
    // the rotated response persists the fresh cookie
    (await readSetCookie(rotated)).should.equal(fresh);

    // stateless minting: both the fresh and the previous token verify
    for (const value of [fresh, oldToken]) {
      const res = await handle(
        app,
        new Request('http://localhost/submit', {
          method: 'POST',
          headers: { 'x-csrf-token': value },
        })
      );
      res.status.should.equal(200);
    }
  });

  it('rotates on login: the fresh token is bound to the new session, the old one is retired', async () => {
    let session = 'anon';
    const app = createApp();
    const csrf = createCsrf({ secret: SECRET, bind: () => session });
    use(app, csrf.middleware);
    get(app, '/form', (ctx) => json(ctx, { token: ctx.state.csrfToken }));
    post(app, '/login', async (ctx) => {
      session = 'user-1';
      return json(ctx, { token: await csrf.issueToken(ctx) });
    });
    post(app, '/submit', () => new Response('saved', { status: 200 }));

    const form = await handle(app, new Request('http://localhost/form'));
    const oldToken = await readSetCookie(form);

    const login = await handle(
      app,
      new Request('http://localhost/login', {
        method: 'POST',
        headers: {
          cookie: `csrf_token=${encodeURIComponent(oldToken)}`,
          'x-csrf-token': oldToken,
        },
      })
    );
    login.status.should.equal(200);
    const fresh = ((await login.json()) as { token: string }).token;
    fresh.should.not.equal(oldToken);
    // the unsafe login response carries the rotated cookie
    (await readSetCookie(login)).should.equal(fresh);

    const ok = await handle(
      app,
      new Request('http://localhost/submit', {
        method: 'POST',
        headers: { 'x-csrf-token': fresh },
      })
    );
    ok.status.should.equal(200);

    const stale = await handle(
      app,
      new Request('http://localhost/submit', {
        method: 'POST',
        headers: { 'x-csrf-token': oldToken },
      })
    );
    stale.status.should.equal(403);
  });
});
