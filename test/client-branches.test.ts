import type { App } from '../src/app';

import type { RouteDef, State } from '../src/types';

import { describe, expectTypeOf, it } from 'vitest';

import { createApp, get, handle, mount, post, use } from '../src/app';
import { createClient } from '../src/client';
import { httpError, throws } from '../src/errors';
import { serve } from '../src/node';
import { json } from '../src/respond';


/** Extracts the `errors` channel of the LAST route in an app's phantom log
 * (registrars append each def at the tail, so the last def is the one just
 * registered). */
type LastErrors<A> = A extends App<State, infer R>
  ? R extends readonly [...RouteDef[], infer D extends RouteDef]
    ? D extends { readonly errors: infer E }
      ? E
      : never
    : never
  : never;

/** Extracts the `branches` channel of the LAST route — same tail trick. */
type LastBranches<A> = A extends App<State, infer R>
  ? R extends readonly [...RouteDef[], infer D extends RouteDef]
    ? D extends { readonly branches: infer B }
      ? B
      : never
    : never
  : never;

describe('client status branches (types)', () => {
  it('infers a returned httpError(404) as a 404 { error: string } branch', async () => {
    const app = createApp();
    const full = get(app, '/nf/:id', (c) =>
      c.params.id === '0' ? httpError(404, 'nf') : json(c, { id: c.params.id })
    );
    const client = createClient(full, {
      baseUrl: 'http://t.test',
      fetch: (input, init) => handle(full, new Request(input, init)),
    });

    // The errors channel carries the returned branch (bodyless → envelope).
    expectTypeOf<LastErrors<typeof full>>().toEqualTypeOf<{
      readonly 404: { error: string };
    }>();
    // The client narrows json() by status.
    const res = await client.get('/nf/:id', { id: '0' });
    res.status.should.equal(404);
    (await res.json()).should.deep.equal({ error: 'nf' });
    expectTypeOf(res.status).toEqualTypeOf<200 | 404>();
    if (res.status === 404) {
      expectTypeOf(res.json).toEqualTypeOf<() => Promise<{ error: string }>>();
    }
    if (res.status === 200) {
      expectTypeOf(res.json).toEqualTypeOf<() => Promise<{ id: string }>>();
    }
  });

  it('infers a structured body branch from httpError(status, message, body)', async () => {
    const app = createApp();
    const full = post(app, '/validate', (c) =>
      c.req.headers.has('x-bad')
        ? httpError(422, 'e', { issues: ['x'] })
        : json(c, { ok: true })
    );
    const client = createClient(full, {
      baseUrl: 'http://t.test',
      fetch: (input, init) => handle(full, new Request(input, init)),
    });

    const res = await client.post('/validate', { headers: { 'x-bad': '1' } });
    res.status.should.equal(422);
    (await res.json()).should.deep.equal({ issues: ['x'] });
    expectTypeOf(res.status).toEqualTypeOf<200 | 422>();
    if (res.status === 422) {
      expectTypeOf(res.json).toEqualTypeOf<() => Promise<{ issues: string[] }>>();
    }
    if (res.status === 200) {
      expectTypeOf(res.json).toEqualTypeOf<() => Promise<{ ok: boolean }>>();
    }
  });

  it('pairs json bodies with their statuses across a mixed handler', async () => {
    const app = createApp();
    const full = get(app, '/field/:id', (c) =>
      c.params.id === '0'
        ? json(c, { error: 'bad id' }, { status: 400 })
        : json(c, { id: 1 })
    );
    const client = createClient(full, {
      baseUrl: 'http://t.test',
      fetch: (input, init) => handle(full, new Request(input, init)),
    });

    // The branches channel keeps the pairing the flat out/status channels
    // lose — one entry per status, body attached.
    expectTypeOf<LastBranches<typeof full>>().toEqualTypeOf<
      { status: 200; out: { id: number } } | { status: 400; out: { error: string } }
    >();
    const miss = await client.get('/field/:id', { id: '0' });
    miss.status.should.equal(400);
    (await miss.json()).should.deep.equal({ error: 'bad id' });
    if (miss.status === 400) {
      expectTypeOf(miss.json).toEqualTypeOf<() => Promise<{ error: string }>>();
    }
    const hit = await client.get('/field/:id', { id: '7' });
    hit.status.should.equal(200);
    (await hit.json()).should.deep.equal({ id: 1 });
    if (hit.status === 200) {
      expectTypeOf(hit.json).toEqualTypeOf<() => Promise<{ id: number }>>();
    }
  });

  it('merges throws gates with returned-httpError branches', async () => {
    const app = createApp();
    const full = get(
      app,
      '/mix/:n',
      throws(401),
      (c) => (c.params.n === '1' ? httpError(429, 'slow') : json(c, { ok: true }))
    );
    const client = createClient(full, {
      baseUrl: 'http://t.test',
      fetch: (input, init) => handle(full, new Request(input, init)),
    });

    expectTypeOf<LastErrors<typeof full>>().toEqualTypeOf<{
      readonly 401: { error: string };
      readonly 429: { error: string };
    }>();
    const res = await client.get('/mix/:n', { n: '1' });
    res.status.should.equal(429);
    (await res.json()).should.deep.equal({ error: 'slow' });
    expectTypeOf(res.status).toEqualTypeOf<200 | 401 | 429>();
    if (res.status === 401) {
      expectTypeOf(res.json).toEqualTypeOf<() => Promise<{ error: string }>>();
    }
    if (res.status === 200) {
      expectTypeOf(res.json).toEqualTypeOf<() => Promise<{ ok: boolean }>>();
    }
  });

  it('unions bodies when throws and a return declare the same status', () => {
    const declared: { 422: { detail: string } } = { 422: { detail: '' } };
    const app = createApp();
    const full = get(
      app,
      '/clash',
      throws(declared),
      () => httpError(422, 'shape', { issues: ['x'] })
    );

    expectTypeOf<LastErrors<typeof full>>().toEqualTypeOf<{
      readonly 422: { issues: string[] } | { detail: string };
    }>();
    void full;
  });

  it('keeps unbranded routes on today exact response surface', async () => {
    const app = createApp();
    const full = get(app, '/plain', () => new Response('ok'));
    const client = createClient(full, { fetch: async () => new Response('ok') });

    const res = await client.get('/plain');
    // No brands, no gates: unknown body, number status — unchanged.
    expectTypeOf(res.status).toEqualTypeOf<number>();
    expectTypeOf(res.json).toEqualTypeOf<() => Promise<unknown>>();
  });

  it('keeps returned-error branches through mount', async () => {
    const sub = createApp();
    const subFull = get(sub, '/item/:id', (c) =>
      c.params.id === '0' ? httpError(404, 'gone') : json(c, { id: c.params.id })
    );
    const parent = mount(createApp(), '/v1', subFull);
    const client = createClient(parent, {
      baseUrl: 'http://t.test',
      fetch: (input, init) => handle(parent, new Request(input, init)),
    });

    const res = await client.get('/v1/item/:id', { id: '0' });
    res.status.should.equal(404);
    (await res.json()).should.deep.equal({ error: 'gone' });
    expectTypeOf(res.status).toEqualTypeOf<200 | 404>();
    if (res.status === 404) {
      expectTypeOf(res.json).toEqualTypeOf<() => Promise<{ error: string }>>();
    }
  });
});

describe('returned httpError branches (runtime)', () => {
  it('answers exactly like the thrown twin (status, body, envelope)', async () => {
    const app = createApp();
    get(app, '/ret', () => httpError(418, 'teapot', { brew: 'coffee' }));
    get(app, '/thr', () => {
      throw httpError(418, 'teapot', { brew: 'coffee' });
    });

    const ret = await handle(app, new Request('http://t.test/ret'));
    const thr = await handle(app, new Request('http://t.test/thr'));
    ret.status.should.equal(418);
    thr.status.should.equal(418);
    const retBody = await ret.json();
    const thrBody = await thr.json();
    retBody.should.deep.equal({ brew: 'coffee' });
    retBody.should.deep.equal(thrBody);
    (ret.headers.get('content-type') ?? '').should.match(/application\/json/);
  });

  it('keeps the default envelope for bodyless returns', async () => {
    const app = createApp();
    get(app, '/e', () => httpError(422, 'invalid'));
    const res = await handle(app, new Request('http://t.test/e'));
    res.status.should.equal(422);
    (await res.json()).should.deep.equal({ error: 'invalid' });
  });

  it('flows a returned error through the app onError policy', async () => {
    const seen: unknown[] = [];
    const app = createApp({
      onError: (ctx, error) => {
        seen.push(error);
        ctx.res = new Response(JSON.stringify({ mapped: true }), {
          status: 419,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    get(app, '/x', () => httpError(418, 'teapot'));

    const res = await handle(app, new Request('http://t.test/x'));
    res.status.should.equal(419);
    (await res.json()).should.deep.equal({ mapped: true });
    seen.should.deep.equal([httpError(418, 'teapot')]);
  });

  it('lets unwinding middlewares observe the stamped error response', async () => {
    const seen: { phase: string; status: number | undefined }[] = [];
    const app = createApp();
    use(app, async (ctx, next) => {
      seen.push({ phase: 'in', status: ctx.res?.status });
      await next();
      seen.push({ phase: 'out', status: ctx.res?.status });
    });
    get(app, '/boom', () => httpError(503, 'maintenance'));

    const res = await handle(app, new Request('http://t.test/boom'));
    res.status.should.equal(503);
    seen.should.deep.equal([
      { phase: 'in', status: undefined },
      { phase: 'out', status: 503 },
    ]);
  });

  it('ignores a returned error once the handler already wrote a response', async () => {
    const app = createApp();
    get(app, '/late', (c) => {
      json(c, { ok: true });
      return httpError(500, 'late');
    });
    const res = await handle(app, new Request('http://t.test/late'));
    res.status.should.equal(200);
    (await res.json()).should.deep.equal({ ok: true });
  });

  it('answers HEAD requests to returned errors without a body', async () => {
    const app = createApp();
    get(app, '/h', () => httpError(404, 'nf'));
    const res = await handle(app, new Request('http://t.test/h', { method: 'HEAD' }));
    res.status.should.equal(404);
    (await res.text()).should.equal('');
  });

  it('serves returned errors over the real node adapter', async () => {
    const app = createApp();
    get(app, '/svc', () => httpError(409, 'conflict'));
    const server = await serve(app, { port: 0 });
    try {
      const res = await fetch(`${server.url}/svc`);
      res.status.should.equal(409);
      (await res.json()).should.deep.equal({ error: 'conflict' });
    } finally {
      await server.close();
    }
  });
});
