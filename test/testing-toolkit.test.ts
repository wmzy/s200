import type { ClientInit, ClientResponse } from '../src/client';

import type { Middleware } from '../src/types';

import { describe, expectTypeOf, it } from 'vitest';

import { all, createApp, get, post } from '../src/app';
import { defineMiddleware } from '../src/middleware';
import { json } from '../src/respond';
import { probeApp, request, testClient } from '../src/test';


import { jsonBody } from '../src/validate';

describe('testing toolkit (s200/test)', () => {
  it('request() dispatches a json route with full app semantics', async () => {
    const app = get(createApp(), '/users/:id', (ctx) => json(ctx, { id: ctx.params.id }));

    const res = await request(app, '/users/7');
    res.status.should.equal(200);
    (res.headers.get('content-type') ?? '').should.equal('application/json');
    (await res.json()).should.deep.equal({ id: '7' });
  });

  it('request() resolves relative inputs against the dummy origin', async () => {
    const app = get(createApp(), '/users/:id', (ctx) => json(ctx, { id: ctx.params.id }));

    const res = await request(app, '/users/1');
    res.status.should.equal(200);
    (await res.json()).should.deep.equal({ id: '1' });

    // URL and Request inputs pass through untouched.
    const viaUrl = await request(app, new URL('http://s200.test/users/2'));
    (await viaUrl.json()).should.deep.equal({ id: '2' });
    const viaRequest = await request(app, new Request('http://s200.test/users/3'));
    (await viaRequest.json()).should.deep.equal({ id: '3' });
  });

  it('request() answers the default 404 for unmatched paths', async () => {
    const res = await request(createApp(), '/nope');
    res.status.should.equal(404);
    (await res.json()).should.deep.equal({ error: 'Not Found' });
  });

  it('request() maps a throwing handler to the anonymous 500', async () => {
    const app = get(createApp({ logError: () => undefined }), '/boom', () => {
      throw new Error('kaboom');
    });

    const res = await request(app, '/boom');
    res.status.should.equal(500);
    (await res.json()).should.deep.equal({ error: 'Internal Server Error' });
  });

  it('testClient() round-trips typed calls in-process', async () => {
    const app = post(
      get(createApp(), '/ping', (ctx) => json(ctx, { pong: true })),
      '/echo',
      async (ctx) => json(ctx, await ctx.req.json())
    );
    const client = testClient(app);

    const res = await client.get('/ping');
    res.status.should.equal(200);
    (await res.json()).should.deep.equal({ pong: true });

    const posted = await client.post('/echo', {
      method: 'POST',
      body: JSON.stringify({ hello: 'world' }),
      headers: { 'content-type': 'application/json' },
    });
    posted.status.should.equal(200);
    (await posted.json()).should.deep.equal({ hello: 'world' });
  });

  it('testClient() exposes the app phantom route log', () => {
    const app = get(createApp(), '/ping', (ctx) => json(ctx, { pong: true }));
    const client = testClient(app);
    void client.get('/ping');

    expectTypeOf<typeof client.get>().toExtend<
      (path: '/ping', init?: ClientInit) => Promise<ClientResponse<{ pong: boolean }>>
    >();
  });

  it('probeApp() smoke-tests every route with synthesized params', async () => {
    const app = createApp({ logError: () => undefined });
    const withPing = get(app, '/ping', (ctx) => json(ctx, { pong: true }));
    const withUser = get(withPing, '/users/:id', (ctx) =>
      json(ctx, { id: ctx.params.id }, { status: 201 })
    );
    const withFiles = get(withUser, '/files/*path', () => new Response('file', { status: 202 }));
    const withAll = all(withFiles, '/everything', () => new Response('any', { status: 203 }));
    const full = get(withAll, '/boom', () => {
      throw new Error('boom');
    });

    const rows = await probeApp(full);

    // Registration order; params were synthesized so the :id and *path
    // routes answer with their handlers' statuses, never a 404-by-miss.
    rows.should.deep.equal([
      { method: 'GET', pattern: '/ping', status: 200, ok: true },
      { method: 'GET', pattern: '/users/:id', status: 201, ok: true },
      { method: 'GET', pattern: '/files/*path', status: 202, ok: true },
      { method: 'GET', pattern: '/everything', status: 203, ok: true },
      { method: 'POST', pattern: '/everything', status: 203, ok: true },
      { method: 'GET', pattern: '/boom', status: 500, ok: false },
    ]);
  });

  it('probeApp() honors methodsForAll for ALL routes', async () => {
    const app = all(createApp(), '/everything', () => new Response('any', { status: 203 }));

    const rows = await probeApp(app, { methodsForAll: ['PATCH', 'DELETE'] });

    rows.should.deep.equal([
      { method: 'PATCH', pattern: '/everything', status: 203, ok: true },
      { method: 'DELETE', pattern: '/everything', status: 203, ok: true },
    ]);
  });

  it('defineMiddleware() is a runtime identity', () => {
    const mw: Middleware = async (ctx, next) => next();
    defineMiddleware(mw).should.equal(mw);
  });

  it('defineMiddleware() preserves gate phantom _in brands', () => {
    const gate = jsonBody((data: unknown) => data as { name: string });
    const published = defineMiddleware(gate);
    published.should.equal(gate);

    expectTypeOf(published).toEqualTypeOf<
      Middleware & { readonly _in?: { readonly json: { name: string } } }
    >();
  });
});
