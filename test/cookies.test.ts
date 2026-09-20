import type { Ctx } from '../src/types';

import { describe, it } from 'vitest';

import { createApp, get, handle, use } from '../src/app';
import {
  getCookie,
  getSignedCookie,
  setCookie,
  setSignedCookie,
  verifyCookieSignature,
} from '../src/cookies';

function requestWith(cookie: string, path = '/'): Request {
  return new Request(`http://localhost${path}`, { headers: { cookie } });
}

describe('getCookie', function () {
  it('reads a cookie by name from the Cookie header', async function () {
    const app = createApp();
    get(app, '/', (ctx) => new Response(getCookie(ctx, 'sid') ?? 'missing'));
    const res = await handle(app, requestWith('a=1; sid=abc%20123; b=2'));
    (await res.text()).should.equal('abc 123');
  });

  it('returns undefined for missing names and malformed pairs', async function () {
    const app = createApp();
    get(app, '/', (ctx) => new Response(String(getCookie(ctx, 'sid') ?? 'undefined')));
    const res = await handle(app, requestWith('broken; sid=%zz'));
    (await res.text()).should.equal('undefined');
  });
});

describe('setCookie', function () {
  it('emits a full attribute set on an existing response', async function () {
    const app = createApp();
    get(app, '/', (ctx) => {
      ctx.res = new Response('ok');
      setCookie(ctx, 'sid', 'a b', {
        maxAge: 60,
        domain: 'example.com',
        path: '/app',
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
      });
    });
    const res = await handle(app, new Request('http://localhost/'));
    (res.headers.get('set-cookie') ?? '').should.equal(
      'sid=a%20b; Max-Age=60; Domain=example.com; Path=/app; HttpOnly; Secure; SameSite=Lax'
    );
  });

  it('defaults to Path=/ and omits unset attributes', async function () {
    const app = createApp();
    get(app, '/', (ctx) => {
      ctx.res = new Response('ok');
      setCookie(ctx, 'plain', 'v');
    });
    const res = await handle(app, new Request('http://localhost/'));
    (res.headers.get('set-cookie') ?? '').should.equal('plain=v; Path=/');
  });

  it('appends distinct set-cookie headers instead of merging them', async function () {
    const app = createApp();
    get(app, '/', (ctx) => {
      ctx.res = new Response('ok');
      setCookie(ctx, 'a', '1');
      setCookie(ctx, 'b', '2');
    });
    const res = await handle(app, new Request('http://localhost/'));
    res.headers.getSetCookie().should.deep.equal(['a=1; Path=/', 'b=2; Path=/']);
  });

  it('throws when no response exists yet', async function () {
    let message = '';
    const app = createApp();
    use(app, (ctx, next) => {
      try {
        setCookie(ctx, 'early', 'v');
      } catch (error) {
        message = String(error);
        ctx.res = new Response('guarded');
        return;
      }
      return next();
    });
    get(app, '/', () => new Response('unreached'));
    const res = await handle(app, new Request('http://localhost/'));
    (await res.text()).should.equal('guarded');
    message.should.match(/no response written yet/);
  });

  it('rejects non-token cookie names', function () {
    const ctx = {
      req: new Request('http://localhost/'),
      url: new URL('http://localhost/'),
      params: {},
      query: new URLSearchParams(),
      state: {},
      res: new Response('ok'),
    } satisfies Ctx;
    (() => setCookie(ctx, 'bad name', 'v')).should.throw(/not an RFC 6265 token/);
  });
});

describe('signed cookies', function () {
  async function signOnce(): Promise<string> {
    const app = createApp();
    get(app, '/', async (ctx) => {
      ctx.res = new Response('set');
      await setSignedCookie(ctx, 'sid', 'alice', 'sekret');
    });
    const res = await handle(app, new Request('http://localhost/'));
    return res.headers.getSetCookie().join('; ');
  }

  it('round-trips through set/get with verification', async function () {
    const stored = await signOnce();
    stored.should.match(/sid=alice/);
    stored.should.match(/sid\.sig=/);
    const app = createApp();
    get(app, '/', async (ctx) => new Response((await getSignedCookie(ctx, 'sid', 'sekret')) ?? ''));
    const res = await handle(app, requestWith(stored));
    (await res.text()).should.equal('alice');
  });

  it('rejects a tampered value and a wrong secret', async function () {
    const stored = await signOnce();
    const tampered = stored.replace('alice', 'mallory');
    const app = createApp();
    get(app, '/', async (ctx) => new Response((await getSignedCookie(ctx, 'sid', 'sekret')) ?? ''));
    const bad = await handle(app, requestWith(tampered));
    (await bad.text()).should.equal('');

    const signature = stored.match(/sid\.sig=([^;]+)/)?.[1] ?? '';
    (await verifyCookieSignature('alice', signature, 'sekret')).should.be.true;
    (await verifyCookieSignature('alice', signature, 'other')).should.be.false;
  });

  it('treats a missing signature partner as unsigned', async function () {
    const app = createApp();
    get(app, '/', async (ctx) => new Response((await getSignedCookie(ctx, 'sid', 'sekret')) ?? ''));
    const res = await handle(app, requestWith('sid=alice'));
    (await res.text()).should.equal('');
  });
});
