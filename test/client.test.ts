import { describe, expectTypeOf, it } from 'vitest';

import { createApp, get, post, all, del, mount, removeRoute, use } from '../src/app';
import {
  createClient,
  type ClientInit,
  type ClientResponse,
} from '../src/client';
import { json } from '../src/respond';

describe('client (typed fetch)', () => {
  function capture() {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response('{"ok":true}', { status: 200 });
    };
    return { calls, fetch };
  }

  it('fills static paths and encodes params', async () => {
    const app = createApp();
    const withGet = get(app, '/users/:id', (ctx) => new Response(ctx.params.id));
    const { calls, fetch } = capture();
    const client = createClient(withGet, { baseUrl: 'http://x.test', fetch });

    await client.get('/users/:id', { id: 'foo bar' });
    calls[0]?.url.should.equal('http://x.test/users/foo%20bar');
    calls[0]?.init.method?.should.equal('GET');
  });

  it('keeps slashes in wildcard captures but encodes each piece', async () => {
    const app = createApp();
    const withGet = get(app, '/files/*path', () => new Response('ok'));
    const { calls, fetch } = capture();
    const client = createClient(withGet, { baseUrl: 'http://x.test', fetch });

    await client.get('/files/*path', { path: 'a/b c' });
    calls[0]?.url.should.equal('http://x.test/files/a/b%20c');
  });

  it('appends query params, repeating arrays and skipping undefined', async () => {
    const app = createApp();
    const withGet = get(app, '/list', () => new Response('ok'));
    const { calls, fetch } = capture();
    const client = createClient(withGet, { fetch });

    await client.get('/list', { query: { page: 2, tag: ['a', 'b'], skip: undefined, on: true } });
    calls[0]?.url.should.equal('/list?page=2&tag=a&tag=b&on=true');
  });

  it('sends the right method per group and offers ALL routes on every method', async () => {
    const app = createApp();
    const withPost = post(app, '/p', () => new Response('post'));
    const withAll = all(withPost, '/any', () => new Response('any'));
    const full = del(withAll, '/d/:id', () => new Response('del'));
    const { calls, fetch } = capture();
    const client = createClient(full, { fetch });

    await client.post('/p');
    calls[0]?.init.method?.should.equal('POST');
    await client.put('/any');
    calls[1]?.init.method?.should.equal('PUT');
    await client.delete('/d/:id', { id: '7' });
    calls[2]?.url.should.equal('/d/7');
    calls[2]?.init.method?.should.equal('DELETE');
  });

  it('throws on missing params and unknown patterns', async () => {
    const app = createApp();
    const withGet = get(app, '/users/:id', () => new Response('ok'));
    const { fetch } = capture();
    const client = createClient(withGet, { fetch });

    await client.get('/users/:id', { id: '1' });
    // Call-time param errors throw synchronously (they are caller bugs,
    // not network failures) — the unknown-pattern guard matches. '/nope'
    // is not a registered literal, so the typed surface rejects it at
    // compile time; drop to the loose shape to exercise the runtime guard.
    const loose = client as { get: (pattern: string, ...rest: unknown[]) => Promise<Response> };
    (() => client.get('/users/:id', {} as { id: string })).should.throw(/Missing param 'id'/);
    (() => loose.get('/nope', undefined)).should.throw(/No GET route '\/nope'/);
  });

  it('survives route removal at runtime', async () => {
    const app = createApp();
    const withA = get(app, '/a', () => new Response('a'));
    const withB = get(withA, '/b', () => new Response('b'));
    // Removal happens before client creation: the runtime table no longer
    // carries /a, so the call throws even though `withB`'s type (a stale
    // snapshot) still offers it. Threading removeRoute's own return would
    // erase /a from the type instead — both honest, this tests the stale
    // corner.
    removeRoute(withB, 'GET', '/a');
    const { calls, fetch } = capture();
    const client = createClient(withB, { fetch });

    await client.get('/b');
    calls.length.should.equal(1);
    (() => client.get('/a', undefined)).should.throw(/No GET route/);
  });

  it('follows mounted routes through the phantom log', async () => {
    const sub = createApp();
    const subWithGet = get(sub, '/users/:id', () => new Response('ok'));
    const app = createApp();
    const mounted = mount(app, '/v1', subWithGet);
    const { calls, fetch } = capture();
    const client = createClient(mounted, { fetch });

    await client.get('/v1/users/:id', { id: '3' });
    calls[0]?.url.should.equal('/v1/users/3');
  });

  it('types paths, params and query through the app', () => {
    // The phantom route log accumulates through the registrars' return
    // types — thread the returns to keep it (the value is the same app).
    const app = createApp();
    const withMw = use(app, async (ctx, next) => next());
    const withGet = get(withMw, '/users/:id', (ctx) => new Response(ctx.params.id));
    const full = post(withGet, '/users/:id?', () => new Response('ok'));
    // Stubbed fetch: the compile-time calls below must not hit the network
    // (a relative URL would reject unhandled and pollute the suite).
    const client = createClient(full, { fetch: async () => new Response('ok') });
    type Get = typeof client.get;
    // A required-param route demands typed args (the optional-param route
    // is also callable for that path — contravariance keeps the union
    // assignable to this signature).
    expectTypeOf<Get>().toExtend<
      (path: '/users/:id', args: { id: string }, init?: ClientInit) => Promise<Response>
    >();
    // Compile-time calls: wrong shapes fail the build.
    void client.get('/users/:id', { id: 'x' }, { query: { a: '1' } });
    void client.post('/users/:id?', {});
  });

  it('types response bodies from json-branded handlers', () => {
    const app = createApp();
    // Sync and async handlers both resolve: the brand survives the
    // Promise unwrap in ResolveOut.
    const withSync = get(app, '/users/:id', (ctx) =>
      json(ctx, { id: Number(ctx.params.id), name: 'ada' })
    );
    const withAsync = get(withSync, '/ping', async (ctx) => json(ctx, { ok: true }));
    // A plain Response handler stays untyped (unknown, not any).
    const full = get(withAsync, '/plain', () => new Response('ok'));
    // Stubbed fetch: the typed call below must not hit the network.
    const client = createClient(full, { fetch: async () => new Response('ok') });
    void client.get('/users/:id', { id: '1' });

    expectTypeOf<typeof client.get>().toExtend<
      (
        path: '/users/:id',
        args: { id: string },
        init?: ClientInit
      ) => Promise<ClientResponse<{ id: number; name: string }>>
    >();
    expectTypeOf<typeof client.get>().toExtend<
      (path: '/ping', init?: ClientInit) => Promise<ClientResponse<{ ok: boolean }>>
    >();
    expectTypeOf<typeof client.get>().toExtend<
      (path: '/plain', init?: ClientInit) => Promise<ClientResponse<unknown>>
    >();
  });

  it('keeps response-body types through mount', () => {
    const sub = createApp();
    const subWithGet = get(sub, '/item/:id', (ctx) => json(ctx, { id: ctx.params.id }));
    const app = createApp();
    const mounted = mount(app, '/v1', subWithGet);
    const client = createClient(mounted, { fetch: async () => new Response('ok') });
    void client.get('/v1/item/:id', { id: '7' });

    expectTypeOf<typeof client.get>().toExtend<
      (
        path: '/v1/item/:id',
        args: { id: string },
        init?: ClientInit
      ) => Promise<ClientResponse<{ id: string }>>
    >();
  });
});
