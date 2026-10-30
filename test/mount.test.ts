import { describe, it, vi } from 'vitest';

import { createApp, get, handle, mount, use } from '../src/app';
import { json, text } from '../src/respond';

function makeRequest(path: string, method = 'GET'): Request {
  return new Request(`http://localhost${path}`, { method });
}

describe('mount', function () {
  it('mounts sub routes under a prefix, joining patterns', async function () {
    const app = createApp();
    const sub = createApp();
    get(sub, '/users/:id', (ctx) => new Response(ctx.params.id));
    get(sub, '/', () => new Response('root'));
    mount(app, '/v1', sub);

    const res = await handle(app, makeRequest('/v1/users/42'));
    res.status.should.equal(200);
    (await res.text()).should.equal('42');
    const root = await handle(app, makeRequest('/v1'));
    root.status.should.equal(200);
    (await root.text()).should.equal('root');
    // Unmounted paths stay unmatched.
    (await handle(app, makeRequest('/users/42'))).status.should.equal(404);
  });

  it('scopes sub-app middlewares to the mounted routes only', async function () {
    const app = createApp();
    const sub = createApp();
    const seen: string[] = [];
    use(sub, async (ctx, next) => {
      seen.push('sub');
      await next();
    });
    get(sub, '/x', () => new Response('ok'));
    get(app, '/plain', () => new Response('plain'));
    mount(app, '/api', sub);

    (await (await handle(app, makeRequest('/api/x'))).text()).should.equal('ok');
    (await (await handle(app, makeRequest('/plain'))).text()).should.equal('plain');
    seen.should.deep.equal(['sub']);
  });

  it('copies the sub-app: it stays functional and remountable', async function () {
    const app = createApp();
    const sub = createApp();
    get(sub, '/x', () => new Response('ok'));
    mount(app, '/a', sub);
    mount(app, '/b', sub);
    // The sub-app itself is untouched by mounting.
    (await (await handle(sub, makeRequest('/x'))).text()).should.equal('ok');
    (await (await handle(app, makeRequest('/a/x'))).text()).should.equal('ok');
    (await (await handle(app, makeRequest('/b/x'))).text()).should.equal('ok');
  });

  it("normalizes '/' and trailing-slash prefixes", async function () {
    const app = createApp();
    const sub = createApp();
    get(sub, '/x', () => new Response('ok'));
    mount(app, '/', sub);
    mount(app, '/v2/', sub);
    (await (await handle(app, makeRequest('/x'))).text()).should.equal('ok');
    (await (await handle(app, makeRequest('/v2/x'))).text()).should.equal('ok');
  });

  it('rejects a prefix without a leading slash', function () {
    const app = createApp();
    (() => mount(app, 'v1', createApp())).should.throw(/must start with/);
  });

  it('keeps sub route-scoped middlewares after the sub-app chain', async function () {
    const order: string[] = [];
    const app = createApp();
    const sub = createApp();
    use(sub, async (_ctx, next) => {
      order.push('sub-app');
      await next();
    });
    get(
      sub,
      '/x',
      async (_ctx, next) => {
        order.push('sub-route');
        await next();
      },
      () => {
        order.push('handler');
      }
    );
    mount(app, '/m', sub);
    await handle(app, makeRequest('/m/x'));
    order.should.deep.equal(['sub-app', 'sub-route', 'handler']);
  });

  it('parses mounted params through the joined pattern', async function () {
    const app = createApp();
    const sub = createApp();
    get(sub, '/p/:id', (ctx) => new Response(`id=${ctx.params.id}`));
    mount(app, '/v1', sub);
    const res = await handle(app, makeRequest('/v1/p/7'));
    (await res.text()).should.equal('id=7');
  });

  it('carries the sub-app onError: a thrown sub error maps through the sub policy', async function () {
    const app = createApp();
    const sub = createApp({
      onError: (ctx, error) => {
        json(ctx, { sub: true, message: (error as Error).message }, { status: 502 });
      },
    });
    get(sub, '/boom', () => {
      throw new Error('kaput');
    });
    mount(app, '/v1', sub);
    const res = await handle(app, makeRequest('/v1/boom'));
    res.status.should.equal(502);
    (await res.json()).should.deep.equal({ sub: true, message: 'kaput' });
  });

  it('applies the carried sub onError to sub middleware errors too', async function () {
    const app = createApp();
    const sub = createApp({
      onError: (ctx) => {
        text(ctx, 'sub-caught', { status: 500 });
      },
    });
    use(sub, async () => {
      throw new Error('middleware boom');
    });
    get(sub, '/x', () => new Response('never'));
    mount(app, '/v1', sub);
    const res = await handle(app, makeRequest('/v1/x'));
    res.status.should.equal(500);
    (await res.text()).should.equal('sub-caught');
  });

  it('falls back to the parent policy when the sub onError declines', async function () {
    const parent = createApp({
      onError: (ctx) => {
        json(ctx, { parent: true }, { status: 501 });
      },
    });
    // Declines: the sub policy acknowledges the error but writes nothing.
    const sub = createApp({ onError: () => undefined });
    get(sub, '/x', () => {
      throw new Error('kaput');
    });
    mount(parent, '/p', sub);
    const res = await handle(parent, makeRequest('/p/x'));
    res.status.should.equal(501);
    (await res.json()).should.deep.equal({ parent: true });
  });

  it('warns once when the sub defines onNotFound — mount drops it', function () {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const app = createApp();
      const sub = createApp({
        onNotFound: (ctx) => {
          text(ctx, 'nope', { status: 404 });
        },
      });
      get(sub, '/a', () => new Response('a'));
      get(sub, '/b', () => new Response('b'));
      mount(app, '/w', sub);
      warn.mock.calls.length.should.equal(1);
      (warn.mock.calls[0]![0] as string).should.match(
        /^\[s200\] mount: sub-app onNotFound\/match are not carried by mount\(\)/
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('warns for a custom matcher, never for a default matcher or a carried onError', function () {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const app = createApp();
      mount(app, '/plain', createApp());
      // onError is carried now — not a warnable drop.
      mount(app, '/onerr', createApp({ onError: (ctx) => { text(ctx, 'x'); } }));
      warn.mock.calls.length.should.equal(0);
      mount(app, '/custom', createApp({ match: () => undefined }));
      warn.mock.calls.length.should.equal(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('warns when the sub-app strictness differs from the parent — mount drops it', function () {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const app = createApp();
      mount(app, '/strict', createApp({ strict: false }));
      warn.mock.calls.length.should.equal(1);
      (warn.mock.calls[0]![0] as string).should.match(
        /^\[s200\] mount: the sub-app's strict:false is not carried/
      );
      // The same strictness on both sides — nothing is dropped, nothing said.
      const laxParent = createApp({ strict: false });
      mount(laxParent, '/lax', createApp({ strict: false }));
      warn.mock.calls.length.should.equal(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("dispatches the mounted routes with the parent's strictness", async function () {
    const app = createApp();
    const sub = createApp({ strict: false });
    get(sub, '/users', () => new Response('users'));
    mount(app, '/v1', sub);

    // The parent's matcher decides: the sub's trailing-slash tolerance is
    // gone (the mount warns about it).
    (await handle(app, makeRequest('/v1/users'))).status.should.equal(200);
    (await handle(app, makeRequest('/v1/users/'))).status.should.equal(404);
  });
});
