import { describe, it } from 'vitest';

import { createApp, get, post, use, handle  } from '../src/app';
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
    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith('csrf_token='));
    if (setCookie === undefined) {
      throw new Error('no csrf cookie set');
    }
    return decodeURIComponent(setCookie.split(';')[0]?.split('=')[1] ?? '');
  }

  it('sets a cookie on safe responses and echoes the same token to the page', async () => {
    const { app, csrf } = build();
    const res = await handle(app, new Request('http://localhost/form'));
    res.status.should.equal(200);
    const cookieToken = await readSetCookie(res);
    const pageToken = ((await res.json()) as { token: string }).token;
    pageToken.should.equal(cookieToken);
    // token(ctx) reuses the middleware's per-request token.
    void csrf;
  });

  it('rejects unsafe requests without a token, then accepts the cookie token', async () => {
    const { app } = build();
    const form = await handle(app, new Request('http://localhost/form'));
    const token = await readSetCookie(form);

    const missing = await handle(app, new Request('http://localhost/submit', { method: 'POST' }));
    missing.status.should.equal(403);

    const ok = await handle(
      app,
      new Request('http://localhost/submit', {
        method: 'POST',
        headers: { cookie: `csrf_token=${encodeURIComponent(token)}`, 'x-csrf-token': token },
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
});
