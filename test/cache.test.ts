import { describe, it } from 'vitest';

import { createApp, get, use, handle  } from '../src/app';
import { cache } from '../src/cache';
import { json, send } from '../src/respond';

describe('cache', () => {
  it('serves the second request from the store without running the handler', async () => {
    let runs = 0;
    const app = createApp();
    use(app, cache());
    get(app, '/data', (ctx) => {
      runs += 1;
      return json(ctx, { n: runs });
    });

    const first = await handle(app, new Request('http://localhost/data'));
    first.status.should.equal(200);
    (await first.json()).should.deep.equal({ n: 1 });

    const second = await handle(app, new Request('http://localhost/data'));
    (await second.json()).should.deep.equal({ n: 1 });
    runs.should.equal(1);
  });

  it('expires entries after the ttl', async () => {
    let runs = 0;
    const app = createApp();
    use(app, cache({ ttl: 0 })); // expires immediately
    get(app, '/data', () => {
      runs += 1;
      return new Response('ok');
    });

    await handle(app, new Request('http://localhost/data'));
    await handle(app, new Request('http://localhost/data'));
    runs.should.equal(2);
  });

  it('keys by method + path + query', async () => {
    let runs = 0;
    const app = createApp();
    use(app, cache());
    get(app, '/data', () => {
      runs += 1;
      return new Response(String(runs));
    });

    await handle(app, new Request('http://localhost/data?x=1'));
    await handle(app, new Request('http://localhost/data?x=2'));
    await handle(app, new Request('http://localhost/data?x=1'));
    runs.should.equal(2);
  });

  it('never caches responses with set-cookie', async () => {
    let runs = 0;
    const app = createApp();
    use(app, cache());
    get(app, '/login', (ctx) => {
      runs += 1;
      return send(ctx, 'ok', { headers: { 'set-cookie': 'sid=abc' } });
    });

    await handle(app, new Request('http://localhost/login'));
    await handle(app, new Request('http://localhost/login'));
    runs.should.equal(2);
  });

  it('skips the store for authorized requests and no-cache requests', async () => {
    let runs = 0;
    const app = createApp();
    use(app, cache());
    get(app, '/private', () => {
      runs += 1;
      return new Response(String(runs));
    });

    await handle(app, new Request('http://localhost/private', { headers: { authorization: 'Bearer t' } }));
    await handle(app, new Request('http://localhost/private', { headers: { authorization: 'Bearer t' } }));
    runs.should.equal(2);

    await handle(app, new Request('http://localhost/private'));
    await handle(app, new Request('http://localhost/private', { headers: { 'cache-control': 'no-cache' } }));
    runs.should.equal(4);
  });

  it('evicts the oldest entry beyond max and clones before storing', async () => {
    let runs = 0;
    const app = createApp();
    use(app, cache({ max: 1 }));
    get(app, '/a', () => {
      runs += 1;
      return new Response(`a${runs}`);
    });
    get(app, '/b', () => {
      runs += 1;
      return new Response(`b${runs}`);
    });

    // Store /a (runs=1), then /b evicts /a (runs=2).
    (await (await handle(app, new Request('http://localhost/a'))).text()).should.equal('a1');
    (await (await handle(app, new Request('http://localhost/b'))).text()).should.equal('b2');
    // /a was evicted: handler runs again.
    (await (await handle(app, new Request('http://localhost/a'))).text()).should.equal('a3');
  });

  it('skips storage when the body exceeds the size limit', async () => {
    let runs = 0;
    const app = createApp();
    use(app, cache({ sizeLimit: 4 }));
    get(app, '/big', () => {
      runs += 1;
      return new Response('large-body');
    });

    await handle(app, new Request('http://localhost/big'));
    await handle(app, new Request('http://localhost/big'));
    runs.should.equal(2);
  });
});
