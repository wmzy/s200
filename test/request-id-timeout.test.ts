import { describe, it } from 'vitest';

import { createApp, get, handle, use } from '../src/app';
import { requestId } from '../src/request-id';
import { timeout } from '../src/timeout';

describe('requestId', function () {
  it('generates an id, stamps the response and exposes it on state', async function () {
    const app = createApp();
    use(app, requestId());
    get(app, '/', (ctx) => new Response(ctx.state.requestId as string));
    const res = await handle(app, new Request('http://localhost/'));
    res.status.should.equal(200);
    const header = res.headers.get('x-request-id');
    header!.should.match(/^[0-9a-f-]{36}$/);
    (await res.text()).should.equal(header);
  });

  it('honors an incoming id from a proxy', async function () {
    const app = createApp();
    use(app, requestId());
    get(app, '/', () => new Response('ok'));
    const res = await handle(
      app,
      new Request('http://localhost/', { headers: { 'x-request-id': 'trace-123' } }),
    );
    res.headers.get('x-request-id')!.should.equal('trace-123');
  });

  it('stamps error responses too — the error boundary materializes them inside the chain', async function () {
    const app = createApp();
    use(app, requestId());
    get(app, '/', () => {
      throw new Error('boom');
    });
    const res = await handle(app, new Request('http://localhost/'));
    res.status.should.equal(500);
    res.headers.get('x-request-id')!.should.match(/^[0-9a-f-]{36}$/);
  });

  it('uses a custom header name and generator', async function () {
    const app = createApp();
    use(app, requestId({ header: 'x-trace', generator: () => 'gen-1' }));
    get(app, '/', () => new Response('ok'));
    const res = await handle(app, new Request('http://localhost/'));
    res.headers.get('x-trace')!.should.equal('gen-1');
    res.headers.has('x-request-id').should.be.false;
  });
});

describe('timeout', function () {
  it('answers 503 when the deadline wins', async function () {
    const app = createApp();
    use(app, timeout(5));
    get(app, '/', async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return new Response('late');
    });
    const res = await handle(app, new Request('http://localhost/'));
    res.status.should.equal(503);
    (await res.json()).should.deep.equal({ error: 'Request timeout' });
  });

  it('passes fast responses through untouched', async function () {
    const app = createApp();
    use(app, timeout(1000));
    get(app, '/', () => new Response('fast'));
    const res = await handle(app, new Request('http://localhost/'));
    res.status.should.equal(200);
    (await res.text()).should.equal('fast');
  });

  it('rejects non-positive deadlines at creation', function () {
    (() => timeout(0)).should.throw(/must be positive/);
    (() => timeout(Number.NaN)).should.throw(/must be positive/);
  });

  it('does not surface a losing chain rejection as unhandledRejection', async function () {
    const app = createApp();
    use(app, timeout(10));
    get(app, '/', async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      throw new Error('late failure');
    });

    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown): void => {
      unhandled.push(error);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const res = await handle(app, new Request('http://localhost/'));
      res.status.should.equal(503);
      // Let the losing chain actually reject and settle.
      await new Promise((resolve) => setTimeout(resolve, 80));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    unhandled.should.deep.equal([]);
  });
});
