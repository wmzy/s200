import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';

import { createApp, get, post } from '../src/app';
import { throws } from '../src/errors';
import {
  createClient,
  type ClientInit,
  type ClientResponse,
} from '../src/client';
import { serve, type NodeServer } from '../src/node';
import { queryParams } from '../src/query';
import { json } from '../src/respond';
import { jsonBody, requiresHeaders, bodyShape, type StandardSchemaV1 } from '../src/validate';

describe('client input types', () => {
  it('types and demands init.body on jsonBody routes', () => {
    const app = createApp();
    const full = post(
      app,
      '/users/:id',
      jsonBody((data: unknown) => {
        const body = data as { name: unknown };
        if (typeof body.name !== 'string') throw new Error('name required');
        return { name: body.name, id: 7 };
      }),
      (ctx) => json(ctx, { created: ctx.params.id === '7' })
    );
    // Stubbed fetch: the compile-time calls below must not hit the network.
    const client = createClient(full, { fetch: async () => new Response('ok') });

    // The gate's parse type rides `init.body` (a JSON shape by contract),
    // and the init argument becomes required — the route reads a body.
    expectTypeOf<typeof client.post>().toExtend<
      (
        path: '/users/:id',
        args: { id: string },
        init: Omit<ClientInit, 'body'> & { body: { name: string; id: number } }
      ) => Promise<ClientResponse<{ created: boolean }>>
    >();
    void client.post('/users/:id', { id: '7' }, { body: { name: 'ada', id: 7 } });
    // @ts-expect-error -- a jsonBody route without its body is a client bug
    void client.post('/users/:id', { id: '7' });
    // @ts-expect-error -- { name: string } is not { name: string; id: number }
    void client.post('/users/:id', { id: '7' }, { body: { name: 'ada' } });
  });

  it('replaces the loose query sugar on queryParams routes', () => {
    const app = createApp();
    const full = get(
      app,
      '/list',
      queryParams((q: { page?: string; tag?: readonly string[] }) => q),
      () => new Response('ok')
    );
    const client = createClient(full, { fetch: async () => new Response('ok') });

    expectTypeOf<typeof client.get>().toExtend<
      (
        path: '/list',
        init?: ClientInit & { query: { page?: string; tag?: readonly string[] } }
      ) => Promise<ClientResponse<unknown>>
    >();
    void client.get('/list', { query: { page: '2', tag: ['a', 'b'] } });
    // @ts-expect-error -- page is string on this route, not number
    void client.get('/list', { query: { page: 2 } });
  });

  it('merges body and query brands on one route', () => {
    const app = createApp();
    const full = post(
      app,
      '/both',
      jsonBody((data: unknown) => data as { id: number }),
      queryParams((q: { page?: string }) => q),
      () => new Response('ok')
    );
    const client = createClient(full, { fetch: async () => new Response('ok') });

    expectTypeOf<typeof client.post>().toExtend<
      (
        path: '/both',
        init: Omit<ClientInit, 'body' | 'query'> & {
          body: { id: number };
          query: { page?: string };
        }
      ) => Promise<ClientResponse<unknown>>
    >();
    void client.post('/both', { body: { id: 1 }, query: { page: '2' } });
    // @ts-expect-error -- the body brand still demands its shape
    void client.post('/both', { body: { id: 'one' }, query: { page: '2' } });
  });

  it('keeps unbranded routes byte-identical (init optional, body loose)', () => {
    const app = createApp();
    const full = post(app, '/plain/:id', (ctx) => json(ctx, { ok: ctx.params.id !== '' }));
    const client = createClient(full, { fetch: async () => new Response('ok') });

    // No gates → today's exact signature; response typing flows from the
    // json() brand alone, untouched by the input story.
    expectTypeOf<typeof client.post>().toExtend<
      (
        path: '/plain/:id',
        args: { id: string },
        init?: ClientInit
      ) => Promise<ClientResponse<{ ok: boolean }>>
    >();
    void client.post('/plain/:id', { id: '7' });
    void client.post('/plain/:id', { id: '7' }, { body: 'raw string' });
    // @ts-expect-error -- a plain object is not a BodyInit; only a gate
    // brand widens `body` into a JSON shape
    void client.post('/plain/:id', { id: '7' }, { body: { a: 1 } });
  });

  it('types init.body as the schema\'s INPUT when input ≠ output', () => {
    // Callers send `{ iso }`; the schema's parsed `{ epoch }` only ever
    // reaches the handler — the client never sees the output side.
    const isoSchema: StandardSchemaV1 & {
      readonly types?: {
        readonly input: { readonly iso: string };
        readonly output: { readonly epoch: number };
      };
    } = {
      '~standard': {
        version: 1,
        vendor: 's200-test',
        validate: (value) => ({
          value: { epoch: Date.parse((value as { iso: string }).iso) },
        }),
      },
    };
    const app = createApp();
    const full = post(app, '/dates', jsonBody(isoSchema), (ctx) =>
      json(ctx, { received: ctx.state.validated !== undefined })
    );
    const client = createClient(full, { fetch: async () => new Response('ok') });

    expectTypeOf<typeof client.post>().toExtend<
      (
        path: '/dates',
        init: Omit<ClientInit, 'body'> & { body: { readonly iso: string } }
      ) => Promise<ClientResponse<{ received: boolean }>>
    >();
    void client.post('/dates', { body: { iso: '2026-01-01T00:00:00Z' } });
    // @ts-expect-error -- the schema's parsed OUTPUT is not the caller's input
    void client.post('/dates', { body: { epoch: 42 } });
  });

  it('types and demands init.headers on requiresHeaders routes', () => {
    const app = createApp();
    const full = get(
      app,
      '/me',
      requiresHeaders('authorization', 'x-trace-id'),
      (ctx) => json(ctx, { authed: ctx.req.headers.get('authorization') !== null })
    );
    const client = createClient(full, { fetch: async () => new Response('ok') });

    expectTypeOf<typeof client.get>().toExtend<
      (
        path: '/me',
        init: Omit<ClientInit, 'headers'> & {
          headers: Record<string, string> & Record<'authorization' | 'x-trace-id', string>;
        }
      ) => Promise<ClientResponse<{ authed: boolean }>>
    >();
    // The declared keys are required; extra keys ride along (the record's
    // index signature absorbs them — auth/tracing headers still fit).
    void client.get('/me', {
      headers: { authorization: 'Bearer t', 'x-trace-id': 'a1', 'x-extra': 'e' },
    });
    // @ts-expect-error -- the route declares authorization; omitting it is a client bug
    void client.get('/me', { headers: { 'x-trace-id': 'a1' } });
    // @ts-expect-error -- a headers-branded route demands its init (no init, no headers)
    void client.get('/me');
  });

  it('types init.body as the declared structured type on bodyShape routes', () => {
    const app = createApp();
    const full = post(
      app,
      '/avatar',
      bodyShape<FormData>(),
      async (ctx) => json(ctx, { size: [...(await ctx.req.formData()).keys()].length })
    );
    const client = createClient(full, { fetch: async () => new Response('ok') });

    expectTypeOf<typeof client.post>().toExtend<
      (
        path: '/avatar',
        init: Omit<ClientInit, 'body'> & { body: FormData }
      ) => Promise<ClientResponse<{ size: number }>>
    >();
    void client.post('/avatar', { body: new FormData() });
    // @ts-expect-error -- the route reads FormData, not a JSON shape
    void client.post('/avatar', { body: { file: 'x' } });
    // @ts-expect-error -- a bodyShape route demands its body
    void client.post('/avatar');
  });

  it('merges headers and query brands on one route', () => {
    const app = createApp();
    const full = get(
      app,
      '/stats',
      requiresHeaders('x-trace-id'),
      queryParams((q: { page?: string }) => q),
      () => new Response('ok')
    );
    const client = createClient(full, { fetch: async () => new Response('ok') });

    expectTypeOf<typeof client.get>().toExtend<
      (
        path: '/stats',
        init: Omit<ClientInit, 'headers' | 'query'> & {
          headers: Record<string, string> & Record<'x-trace-id', string>;
          query: { page?: string };
        }
      ) => Promise<ClientResponse<unknown>>
    >();
    void client.get('/stats', { headers: { 'x-trace-id': 't1' }, query: { page: '2' } });
    // @ts-expect-error -- the headers brand survives the merge
    void client.get('/stats', { query: { page: '2' } });
  });

  it('surfaces throws-declared statuses and bodies on the client', async () => {
    const app = createApp();
    const full = get(app, '/maybe', throws(401, 404), (ctx) => json(ctx, { ok: true }));
    const client = createClient(full, { fetch: async () => new Response('ok') });

    const res = await client.get('/maybe');
    expectTypeOf(res.status).toEqualTypeOf<200 | 401 | 404>();
    // One json() signature per status now (the discriminated refinement
    // of the former flat body union) — `res.status` narrows `res.json()`.
    expectTypeOf(res.json).toEqualTypeOf<
      (() => Promise<{ ok: boolean }>) | (() => Promise<{ error: string }>)
    >();
    if (res.status === 404) {
      // `res.json` (the member), not `res.json()` — expectTypeOf evaluates
      // its argument, and the stub's non-JSON body must not be parsed.
      expectTypeOf(res.json).toEqualTypeOf<() => Promise<{ error: string }>>();
    }
  });

  it('merges multiple throws gates on the client', async () => {
    const unprocessable: { 422: { issues: string[] } } = { 422: { issues: [] } };
    const app = createApp();
    const full = get(
      app,
      '/merge',
      throws(401),
      throws(unprocessable),
      (ctx) => json(ctx, { ok: true })
    );
    const client = createClient(full, { fetch: async () => new Response('ok') });

    const res = await client.get('/merge');
    expectTypeOf(res.status).toEqualTypeOf<200 | 401 | 422>();
    expectTypeOf(res.json).toEqualTypeOf<
      | (() => Promise<{ ok: boolean }>)
      | (() => Promise<{ error: string }>)
      | (() => Promise<{ issues: string[] }>)
    >();
    if (res.status === 422) {
      expectTypeOf(res.json).toEqualTypeOf<() => Promise<{ issues: string[] }>>();
    }
  });
});

// What the ephemeral server observed, per request, in arrival order.
const gated: { contentType: string | null; echoed: unknown }[] = [];
const probes: { contentType: string | null; text: string }[] = [];
const tags: string[][] = [];
const uploads: { auth: string | null; contentType: string | null; field: string }[] = [];

/** The app the runtime tests serve and drive a client against. */
function buildApp() {
  const app = createApp();
  const withUsers = post(
    app,
    '/users',
    jsonBody((data: unknown) => {
      const body = data as { name: unknown };
      if (typeof body.name !== 'string') throw new Error('name required');
      return { name: body.name };
    }),
    (ctx) => {
      gated.push({ contentType: ctx.req.headers.get('content-type'), echoed: ctx.state.validated });
      return json(ctx, ctx.state.validated);
    }
  );
  const withProbe = post(withUsers, '/probe', async (ctx) => {
    probes.push({ contentType: ctx.req.headers.get('content-type'), text: await ctx.req.text() });
    return json(ctx, { ok: true });
  });
  const withTags = get(withProbe, '/tags', (ctx) => {
    tags.push(ctx.query.getAll('tag'));
    return json(ctx, { ok: true });
  });
  // Declaration gates (`requiresHeaders`/`bodyShape`) + a handler that
  // really reads the form — the runtime tests prove the gates are pure
  // pass-throughs: the request rides untouched and the handler answers.
  return post(
    withTags,
    '/upload',
    requiresHeaders('authorization'),
    bodyShape<FormData>(),
    async (ctx) => {
      const form = await ctx.req.formData();
      uploads.push({
        auth: ctx.req.headers.get('authorization'),
        contentType: ctx.req.headers.get('content-type'),
        field: String(form.get('file') ?? ''),
      });
      return json(ctx, { ok: true });
    }
  );
}

const app = buildApp();
let server: NodeServer;

describe('client input types (runtime)', () => {
  beforeAll(async () => {
    server = await serve(app, { port: 0 });
  });

  afterAll(async () => {
    await server.close();
  });

  it('stringifies typed bodies, defaults content-type, and round-trips a jsonBody gate', async () => {
    const client = createClient(app, { baseUrl: server.url });
    const res = await client.post('/users', { body: { name: 'ada' } });

    res.status.should.equal(200);
    ((await res.json()) as { name: string }).should.deep.equal({ name: 'ada' });
    expect(gated[gated.length - 1]?.contentType).toBe('application/json');
  });

  it('keeps an explicit content-type over the JSON default', async () => {
    const client = createClient(app, { baseUrl: server.url });
    const res = await client.post('/users', {
      body: { name: 'bob' },
      headers: { 'content-type': 'text/plain' },
    });

    // The object body is still stringified (the gate parsed it), but the
    // caller's content-type wins — the default never overrides.
    res.status.should.equal(200);
    ((await res.json()) as { name: string }).should.deep.equal({ name: 'bob' });
    expect(gated[gated.length - 1]?.contentType).toBe('text/plain');
  });

  it('passes string bodies through untouched', async () => {
    const client = createClient(app, { baseUrl: server.url });
    const res = await client.post('/probe', { body: 'raw text' });

    res.status.should.equal(200);
    probes[probes.length - 1]?.text.should.equal('raw text');
    // No JSON default is stamped on non-object bodies — fetch's own
    // string typing (text/plain) applies instead.
    expect(probes[probes.length - 1]?.contentType).not.toBe('application/json');
  });

  it('keeps the query sugar unchanged (repeated keys from arrays)', async () => {
    const client = createClient(app, { baseUrl: server.url });
    const res = await client.get('/tags', { query: { tag: ['a', 'b'], one: 1 } });

    res.status.should.equal(200);
    tags[tags.length - 1]?.should.deep.equal(['a', 'b']);
  });

  it('rides declaration gates as pure pass-throughs (FormData body, record headers)', async () => {
    const client = createClient(app, { baseUrl: server.url });
    const form = new FormData();
    form.append('file', 'avatar-bytes');
    const res = await client.post('/upload', {
      headers: { authorization: 'Bearer t' },
      body: form,
    });

    res.status.should.equal(200);
    const seen = uploads[uploads.length - 1];
    (seen?.auth ?? '').should.equal('Bearer t');
    seen?.field.should.equal('avatar-bytes');
    // The FormData rode to fetch untouched — fetch stamped the multipart
    // content-type with its own boundary, the client nothing.
    (seen?.contentType ?? '').should.match(/^multipart\/form-data; boundary=/);
  });
});
