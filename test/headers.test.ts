import { describe, it } from 'vitest';

import { createApp, get, handle, post, use } from '../src/app';
import { httpError } from '../src/errors';
import { json, setHeader, setHeaders, text } from '../src/respond';

const quiet = { logError: () => undefined };

describe('setHeader / setHeaders', () => {
  it('sets directly on the materialized response on the unwind', async () => {
    const app = createApp();
    use(app, async (ctx, next) => {
      await next();
      setHeader(ctx, 'x-powered-by', 's200');
    });
    get(app, '/', (ctx) => {
      json(ctx, { ok: true });
    });
    const res = await handle(app, new Request('http://localhost/'));
    (res.headers.get('x-powered-by') ?? '').should.equal('s200');
  });

  it('defers a header set before next() onto the handler response', async () => {
    const app = createApp();
    use(app, async (ctx, next) => {
      setHeader(ctx, 'x-powered-by', 's200');
      await next();
    });
    get(app, '/', (ctx) => {
      text(ctx, 'hello');
    });
    const res = await handle(app, new Request('http://localhost/'));
    (res.headers.get('x-powered-by') ?? '').should.equal('s200');
    (await res.text()).should.equal('hello');
  });

  it('applies deferred headers at materialization, so unwind readers see them', async () => {
    const app = createApp();
    const seen: (string | null)[] = [];
    use(app, async (ctx, next) => {
      setHeader(ctx, 'x-tag', 'outer');
      await next();
    });
    use(app, async (ctx, next) => {
      await next();
      seen.push(ctx.res?.headers.get('x-tag') ?? null);
    });
    get(app, '/', (ctx) => {
      json(ctx, {});
    });
    const res = await handle(app, new Request('http://localhost/'));
    (res.headers.get('x-tag') ?? '').should.equal('outer');
    seen.should.deep.equal(['outer']);
  });

  it('rides a returned bare Response (adoption bypasses newResponse)', async () => {
    const app = createApp();
    use(app, async (ctx, next) => {
      setHeader(ctx, 'x-powered-by', 's200');
      await next();
    });
    get(app, '/', () => new Response('raw'));
    const res = await handle(app, new Request('http://localhost/'));
    (res.headers.get('x-powered-by') ?? '').should.equal('s200');
    (await res.text()).should.equal('raw');
  });

  it('a deferred header overrides the response header of the same name', async () => {
    const app = createApp();
    use(app, async (ctx, next) => {
      setHeader(ctx, 'cache-control', 'no-store');
      await next();
    });
    get(app, '/', (ctx) => {
      json(ctx, {}, { headers: { 'cache-control': 'max-age=60' } });
    });
    const res = await handle(app, new Request('http://localhost/'));
    (res.headers.get('cache-control') ?? '').should.equal('no-store');
  });

  it('rides the 404/405 fallbacks', async () => {
    const app = createApp();
    use(app, async (ctx, next) => {
      setHeader(ctx, 'x-powered-by', 's200');
      await next();
    });
    get(app, '/known', (ctx) => {
      json(ctx, {});
    });
    const miss = await handle(app, new Request('http://localhost/missing'));
    miss.status.should.equal(404);
    (miss.headers.get('x-powered-by') ?? '').should.equal('s200');
    const wrongMethod = await handle(
      app,
      new Request('http://localhost/known', { method: 'POST' })
    );
    wrongMethod.status.should.equal(405);
    (wrongMethod.headers.get('x-powered-by') ?? '').should.equal('s200');
  });

  it('rides a thrown-error response and a returned httpError response', async () => {
    const thrown = createApp(quiet);
    use(thrown, async (ctx, next) => {
      setHeader(ctx, 'x-request-id', 'abc');
      await next();
    });
    get(thrown, '/', () => {
      throw new Error('boom');
    });
    const thrownRes = await handle(thrown, new Request('http://localhost/'));
    thrownRes.status.should.equal(500);
    (thrownRes.headers.get('x-request-id') ?? '').should.equal('abc');

    const returned = createApp(quiet);
    use(returned, async (ctx, next) => {
      setHeader(ctx, 'x-request-id', 'abc');
      await next();
    });
    get(returned, '/', () => httpError(404, 'nope'));
    const returnedRes = await handle(returned, new Request('http://localhost/'));
    returnedRes.status.should.equal(404);
    (returnedRes.headers.get('x-request-id') ?? '').should.equal('abc');
  });

  it('rides a response written by a custom onError', async () => {
    const app = createApp({
      onError: (ctx) => {
        ctx.res = new Response('handled', { status: 502 });
      },
    });
    use(app, async (ctx, next) => {
      setHeader(ctx, 'x-trace', 't1');
      await next();
    });
    get(app, '/', () => {
      throw new Error('boom');
    });
    const res = await handle(app, new Request('http://localhost/'));
    res.status.should.equal(502);
    (res.headers.get('x-trace') ?? '').should.equal('t1');
  });

  it('setHeaders writes many at once, last write per name wins', async () => {
    const app = createApp();
    use(app, async (ctx, next) => {
      setHeaders(ctx, { 'x-a': '1', 'x-b': '2' });
      setHeader(ctx, 'x-a', '1b');
      await next();
    });
    get(app, '/', (ctx) => {
      json(ctx, {});
    });
    const res = await handle(app, new Request('http://localhost/'));
    (res.headers.get('x-a') ?? '').should.equal('1b');
    (res.headers.get('x-b') ?? '').should.equal('2');
  });

  it('a deferred header survives the HEAD response rebuild', async () => {
    const app = createApp();
    use(app, async (ctx, next) => {
      setHeader(ctx, 'x-powered-by', 's200');
      await next();
    });
    get(app, '/', (ctx) => {
      text(ctx, 'body');
    });
    const res = await handle(app, new Request('http://localhost/', { method: 'HEAD' }));
    (res.headers.get('x-powered-by') ?? '').should.equal('s200');
    (res.headers.get('content-length') ?? '').should.equal('4');
  });

  it('works from a route-level middleware', async () => {
    const app = createApp();
    get(
      app,
      '/r',
      async (ctx, next) => {
        setHeader(ctx, 'x-mw', 'route');
        await next();
      },
      (ctx) => {
        json(ctx, {});
      }
    );
    const res = await handle(app, new Request('http://localhost/r'));
    (res.headers.get('x-mw') ?? '').should.equal('route');
  });

  it('post-next setHeader lands on a recovered response', async () => {
    const app = createApp(quiet);
    use(app, async (ctx, next) => {
      // The in-chain boundary below already mapped the throw to a 500.
      await next();
      // Rebuild first, patch after — a helper that runs after setHeader
      // would replace the response (and its headers) entirely.
      text(ctx, 'recovered');
      setHeader(ctx, 'x-recovered', 'yes');
    });
    post(app, '/r', () => {
      throw new Error('boom');
    });
    const res = await handle(app, new Request('http://localhost/r', { method: 'POST' }));
    (res.headers.get('x-recovered') ?? '').should.equal('yes');
    (await res.text()).should.equal('recovered');
  });
});
