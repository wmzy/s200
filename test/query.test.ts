import type { QueryOf } from '../src/types';

import { describe, expectTypeOf, it } from 'vitest';

import { createApp, get, handle, use } from '../src/app';
import { httpError } from '../src/errors';
import { parseQuery, queryParams, type QueryRecord } from '../src/query';
import { json } from '../src/respond';

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
    seen!.should.deep.equal({ page: '1', tag: ['a', 'b'] });
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
    seen!.should.deep.equal({});
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
