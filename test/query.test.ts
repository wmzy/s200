import type { ClientInit, ClientResponse } from '../src/client';
import type { QueryOf } from '../src/types';

import { describe, expectTypeOf, it } from 'vitest';

import { createApp, get, handle, use } from '../src/app';
import { createClient } from '../src/client';
import { httpError } from '../src/errors';
import { parseQuery, queryParams, type QueryRecord } from '../src/query';
import { json } from '../src/respond';
import { type StandardSchemaV1 } from '../src/validate';

describe('parseQuery', () => {
  it('collects single keys as strings and repeated keys as arrays', async () => {
    let seen: QueryRecord | undefined;
    const app = createApp();
    use(app, async (ctx, next) => {
      seen = parseQuery(ctx);
      return next();
    });
    get(app, '/', () => new Response('ok'));
    await handle(app, new Request('http://localhost/?page=1&tag=a&tag=b'));
    // Spread into a plain object: the record is null-prototype (a
    // prototype-less object has no .should from Object.prototype).
    ({ ...seen }).should.deep.equal({ page: '1', tag: ['a', 'b'] });
  });

  it('returns an empty record for a query-less URL', async () => {
    let seen: QueryRecord | undefined;
    const app = createApp();
    use(app, async (ctx, next) => {
      seen = parseQuery(ctx);
      return next();
    });
    get(app, '/', () => new Response('ok'));
    await handle(app, new Request('http://localhost/'));
    ({ ...seen }).should.deep.equal({});
  });

  it('keeps __proto__ and constructor as plain own keys', async () => {
    let seen: QueryRecord | undefined;
    const app = createApp();
    use(app, async (ctx, next) => {
      seen = parseQuery(ctx);
      return next();
    });
    get(app, '/', () => new Response('ok'));
    await handle(
      app,
      new Request('http://localhost/?__proto__=x&constructor=y'),
    );
    // Object spread copies own enumerable keys with CreateDataProperty, so
    // both keys survive — on a plain object the __proto__ assignment would
    // have been silently swallowed by the prototype setter.
    JSON.stringify({ ...seen }).should.equal(
      '{"__proto__":"x","constructor":"y"}',
    );
  });

  it('types a query-string literal through QueryOf', () => {
    expectTypeOf<QueryOf<'page&tag'>>().toExtend<{
      page?: string | string[];
      tag?: string | string[];
    }>();
    // Every key is optional: no value is required at runtime.
    const empty: QueryOf<'page&tag'> = {};
    void empty;
  });
});

describe('queryParams', () => {
  it('parses the query through the schema and stores the result on state', async () => {
    const app = createApp();
    get(
      app,
      '/',
      queryParams((q) => ({ page: Number(q.page ?? 1), tags: q.tag ?? [] })),
      (ctx) => json(ctx, ctx.state.validated)
    );
    const res = await handle(app, new Request('http://localhost/?page=7&tag=x'));
    res.status.should.equal(200);
    // A single occurrence stays a string; repeats would collect into an array.
    (await res.json()).should.deep.equal({ page: 7, tags: 'x' });
  });

  it('stores under a custom state key', async () => {
    const app = createApp();
    get(
      app,
      '/',
      queryParams((q) => q, { key: 'q' }),
      (ctx) => json(ctx, ctx.state.q)
    );
    const res = await handle(app, new Request('http://localhost/?a=1&a=2'));
    (await res.json()).should.deep.equal({ a: ['1', '2'] });
  });

  it('maps a throwing parse to the app error path', async () => {
    const app = createApp();
    get(
      app,
      '/',
      queryParams((q) => {
        if (q.page === undefined) throw httpError(400, 'page required');
        return q.page;
      }),
      () => new Response('ok')
    );
    const res = await handle(app, new Request('http://localhost/'));
    res.status.should.equal(400);
    (await res.json()).should.deep.equal({ error: 'page required' });
  });

  it('passes repeated keys through as arrays', async () => {
    const app = createApp();
    get(
      app,
      '/',
      queryParams((q) => ({ tag: q.tag })),
      (ctx) => json(ctx, ctx.state.validated)
    );
    const res = await handle(app, new Request('http://localhost/?tag=a&tag=b'));
    (await res.json()).should.deep.equal({ tag: ['a', 'b'] });
  });
});

// ---- Standard Schema over the query record ----

/** The output the fake query schema produces. */
type ListOut = { readonly page: number; readonly tags: readonly string[] };

/** The query-string read the schema accepts — the caller's side. */
type ListIn = { readonly page?: string; readonly tag?: string | readonly string[] };

const listSchema: StandardSchemaV1 & {
  readonly types?: { readonly input: ListIn; readonly output: ListOut };
} = {
  '~standard': {
    version: 1,
    vendor: 's200-test',
    validate: (value) => {
      const q = value as Record<string, unknown>;
      const tag = q.tag;
      return {
        value: {
          page: Number(q.page ?? 1),
          tags: tag === undefined ? [] : Array.isArray(tag) ? tag.map(String) : [String(tag)],
        },
      };
    },
  },
};

describe('queryParams with a Standard Schema', () => {
  it('validates the parsed record and stores the output on state', async () => {
    const app = createApp();
    get(app, '/', queryParams(listSchema), (ctx) => json(ctx, ctx.state.validated));
    const res = await handle(app, new Request('http://localhost/?page=7&tag=a&tag=b'));
    res.status.should.equal(200);
    (await res.json()).should.deep.equal({ page: 7, tags: ['a', 'b'] });
  });

  it('maps schema issues to a 422 HttpError', async () => {
    const app = createApp();
    get(
      app,
      '/',
      queryParams({
        '~standard': {
          version: 1,
          vendor: 's200-test',
          validate: () => ({
            issues: [{ message: 'page out of range', path: ['page'] }],
          }),
        },
      }),
      () => new Response('unreached')
    );
    const res = await handle(app, new Request('http://localhost/?page=999'));
    res.status.should.equal(422);
    (await res.json()).should.deep.equal({ error: 'page out of range' });
  });

  it('brands the client query with the schema input', () => {
    const app = createApp();
    const full = get(app, '/list', queryParams(listSchema), () => new Response('ok'));
    // Stubbed fetch: the compile-time assertions below must not hit the network.
    const client = createClient(full, { fetch: async () => new Response('ok') });

    expectTypeOf<typeof client.get>().toExtend<
      (
        path: '/list',
        init?: ClientInit & { query: ListIn }
      ) => Promise<ClientResponse<unknown>>
    >();
    void client.get('/list', { query: { page: '2', tag: ['a', 'b'] } });
    // @ts-expect-error -- tag is a string or string array on this route, not a number
    void client.get('/list', { query: { page: '2', tag: 7 } });
  });
});
