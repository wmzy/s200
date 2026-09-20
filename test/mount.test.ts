import { describe, it } from 'vitest';

import { createApp, get, handle, mount, use } from '../src/app';

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
    (() => mount(app, 'v1', createApp())).should.throw(/must be empty or start with/);
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
});
