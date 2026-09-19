import type { App } from '../src/app';

import { describe, it } from 'vitest';

import {
  addRoute,
  all,
  createApp,
  del,
  get,
  handle,
  head,
  options,
  patch,
  post,
  put,
  use,
  usePlugin,
} from '../src/app';
import { html, json, redirect, send, text } from '../src/respond';
import { httpError } from '../src/errors';

describe('app dispatch', () => {
  it('dispatches a matched route and returns its response', async () => {
    const app = createApp();
    get(app, '/hello', (ctx) => {
      json(ctx, { hello: 'world' });
    });
    const res = await handle(app, new Request('http://localhost/hello'));
    res.status.should.equal(200);
    (await res.json()).should.deep.equal({ hello: 'world' });
  });

  it('runs middlewares in onion order around the handler', async () => {
    const order: string[] = [];
    const app = createApp();
    use(app, async (ctx, next) => {
      order.push('a-in');
      await next();
      order.push('a-out');
      // Writing after next() proves the unwind completes before handle()
      // resolves and that the outermost layer gets the last word.
      if (ctx.res === undefined) {
        text(ctx, 'after');
      }
    });
    use(app, async (_ctx, next) => {
      order.push('b-in');
      await next();
      order.push('b-out');
    });
    get(app, '/chain', () => {
      order.push('handler');
    });
    const res = await handle(app, new Request('http://localhost/chain'));
    (await res.text()).should.equal('after');
    order.should.deep.equal(['a-in', 'b-in', 'handler', 'b-out', 'a-out']);
  });

  it('runs middlewares even when no route matches; a middleware may respond', async () => {
    let middlewareRan = false;
    let notFoundRan = false;
    const app = createApp({
      onNotFound: (ctx) => {
        notFoundRan = true;
        text(ctx, 'custom 404', { status: 404 });
      },
    });
    use(app, async (ctx, next) => {
      middlewareRan = true;
      if (ctx.req.url.endsWith('/static')) {
        text(ctx, 'static');
        return;
      }
      await next();
    });
    const hit = await handle(app, new Request('http://localhost/static'));
    hit.status.should.equal(200);
    (await hit.text()).should.equal('static');
    middlewareRan.should.be.true;
    notFoundRan.should.be.false;

    const miss = await handle(app, new Request('http://localhost/other'));
    miss.status.should.equal(404);
    (await miss.text()).should.equal('custom 404');
    notFoundRan.should.be.true;
  });

  it('defaults unmatched requests to a JSON 404', async () => {
    const app = createApp();
    get(app, '/only', () => new Response('here'));
    const res = await handle(app, new Request('http://localhost/missing'));
    res.status.should.equal(404);
    (await res.json()).should.deep.equal({ error: 'Not Found' });
  });

  it('passes state between middleware and handler', async () => {
    const app = createApp();
    use(app, (ctx, next) => {
      ctx.state.user = 'alice';
      return next();
    });
    get(app, '/me', (ctx) => {
      json(ctx, { user: ctx.state.user });
    });
    const res = await handle(app, new Request('http://localhost/me'));
    (await res.json()).should.deep.equal({ user: 'alice' });
  });

  it('provides fresh params and query per request', async () => {
    const app = createApp();
    addRoute(app, 'GET', '/users/:id', (ctx) => {
      json(ctx, {
        id: ctx.params.id,
        page: ctx.query.get('page'),
        tags: ctx.query.getAll('tag'),
      });
    });
    const first = await handle(app, new Request('http://localhost/users/42?page=3&tag=a&tag=b'));
    (await first.json()).should.deep.equal({ id: '42', page: '3', tags: ['a', 'b'] });
    // The second request must see a fresh ctx — no params leak from the first.
    const second = await handle(app, new Request('http://localhost/users/7'));
    (await second.json()).should.deep.equal({ id: '7', page: null, tags: [] });
  });

  it('captures wildcard params joined with /', async () => {
    const app = createApp();
    get(app, '/files/*path', (ctx) => {
      text(ctx, ctx.params.path);
    });
    const res = await handle(app, new Request('http://localhost/files/a/b/c.txt'));
    (await res.text()).should.equal('a/b/c.txt');
  });

  it('writes a handler-returned Response when ctx.res is undefined', async () => {
    const app = createApp();
    get(app, '/ret', () => new Response('returned', { status: 201 }));
    const res = await handle(app, new Request('http://localhost/ret'));
    res.status.should.equal(201);
    (await res.text()).should.equal('returned');
  });

  it('does not override a response already written to ctx.res', async () => {
    const app = createApp();
    use(app, async (ctx, next) => {
      text(ctx, 'written-by-middleware');
      await next();
    });
    get(app, '/', () => new Response('returned-by-handler'));
    const res = await handle(app, new Request('http://localhost/'));
    (await res.text()).should.equal('written-by-middleware');

    const app2 = createApp();
    get(app2, '/', (ctx) => {
      send(ctx, 'written');
      return new Response('returned');
    });
    const res2 = await handle(app2, new Request('http://localhost/'));
    (await res2.text()).should.equal('written');
  });

  it('reports a matched handler that produces no response', async () => {
    const app = createApp();
    get(app, '/silent', () => 'not a response');
    const res = await handle(app, new Request('http://localhost/silent'));
    res.status.should.equal(500);
    (await res.json()).should.deep.equal({ error: 'No response written' });
  });

  it('routes a thrown error to onError with the original error', async () => {
    const boom = new Error('boom');
    let caught: Error | undefined;
    const app = createApp({
      onError: (ctx, error) => {
        caught = error as Error;
        json(ctx, { handled: true }, { status: 418 });
      },
    });
    get(app, '/throw', () => {
      throw boom;
    });
    const res = await handle(app, new Request('http://localhost/throw'));
    caught!.should.equal(boom);
    res.status.should.equal(418);
    (await res.json()).should.deep.equal({ handled: true });
  });

  it('maps thrown errors via toErrorResponse when onError is absent', async () => {
    const app = createApp();
    get(app, '/http', () => {
      throw httpError(422, 'Invalid input');
    });
    get(app, '/plain', () => {
      throw new Error('unexpected');
    });
    const http = await handle(app, new Request('http://localhost/http'));
    http.status.should.equal(422);
    (await http.json()).should.deep.equal({ error: 'Invalid input' });
    const plain = await handle(app, new Request('http://localhost/plain'));
    plain.status.should.equal(500);
    (await plain.json()).should.deep.equal({ error: 'Internal Server Error' });
  });

  it('also catches middleware throws', async () => {
    const app = createApp();
    use(app, async () => {
      throw httpError(503, 'maintenance');
    });
    get(app, '/x', () => new Response('never'));
    const res = await handle(app, new Request('http://localhost/x'));
    res.status.should.equal(503);
    (await res.json()).should.deep.equal({ error: 'maintenance' });
  });

  it('falls back to a 500 when onError itself throws', async () => {
    const app = createApp({
      onError: () => {
        throw new Error('error-handler bug');
      },
    });
    get(app, '/throw', () => {
      throw new Error('original');
    });
    const res = await handle(app, new Request('http://localhost/throw'));
    res.status.should.equal(500);
    (await res.json()).should.deep.equal({ error: 'Internal Server Error' });
  });

  it('registers each method helper under its HTTP method', async () => {
    const app = createApp();
    get(app, '/r', () => new Response('GET'));
    post(app, '/r', () => new Response('POST'));
    put(app, '/r', () => new Response('PUT'));
    patch(app, '/r', () => new Response('PATCH'));
    del(app, '/r', () => new Response('DELETE'));
    options(app, '/r', () => new Response('OPTIONS'));
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const) {
      const res = await handle(app, new Request('http://localhost/r', { method }));
      res.status.should.equal(200);
      (await res.text()).should.equal(method);
    }
    // A HEAD-registered route answers HEAD with the body stripped…
    head(app, '/r', () => new Response('HEAD'));
    const headRes = await handle(app, new Request('http://localhost/r', { method: 'HEAD' }));
    headRes.status.should.equal(200);
    (headRes.body === null).should.be.true;
    // …and does not serve GET.
    const getRes = await handle(app, new Request('http://localhost/r'));
    (await getRes.text()).should.equal('GET');
  });

  it('matches an ALL route for every method', async () => {
    const app = createApp();
    all(app, '/any', (ctx) => {
      text(ctx, ctx.req.method);
    });
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'] as const) {
      const res = await handle(app, new Request('http://localhost/any', { method }));
      res.status.should.equal(200);
      if (method === 'HEAD') {
        (res.body === null).should.be.true;
      } else {
        (await res.text()).should.equal(method);
      }
    }
  });

  it('strips the body for HEAD but keeps content-length', async () => {
    const app = createApp();
    get(app, '/file', (ctx) => {
      send(ctx, 'hello', {
        headers: { 'content-type': 'text/plain', 'content-length': '5' },
      });
    });
    const headRes = await handle(app, new Request('http://localhost/file', { method: 'HEAD' }));
    headRes.status.should.equal(200);
    (headRes.headers.get('content-length') ?? '').should.equal('5');
    (headRes.headers.get('content-type') ?? '').should.equal('text/plain');
    (headRes.body === null).should.be.true;
    const getRes = await handle(app, new Request('http://localhost/file'));
    (getRes.headers.get('content-length') ?? '').should.equal('5');
    (await getRes.text()).should.equal('hello');
  });

  it('use chains and usePlugin applies plugins to the app', async () => {
    const plugin = (a: App) => {
      get(a, '/plugin', (ctx) => text(ctx, `user=${String(ctx.state.user ?? 'none')}`));
    };
    const app = use(usePlugin(createApp(), plugin), (ctx, next) => {
      ctx.state.user = 'alice';
      return next();
    });
    const res = await handle(app, new Request('http://localhost/plugin'));
    (await res.text()).should.equal('user=alice');
  });

  it('honors a custom match function', async () => {
    const app = createApp({ match: () => undefined });
    get(app, '/x', () => new Response('never'));
    const res = await handle(app, new Request('http://localhost/x'));
    res.status.should.equal(404);
    (await res.json()).should.deep.equal({ error: 'Not Found' });
  });
});

describe('respond helpers', () => {
  it('send writes body and init through to ctx.res', async () => {
    const app = createApp();
    get(app, '/send', (ctx) => {
      send(ctx, 'created', { status: 201, headers: { 'x-marker': 'yes' } });
    });
    const res = await handle(app, new Request('http://localhost/send'));
    res.status.should.equal(201);
    (res.headers.get('x-marker') ?? '').should.equal('yes');
    (await res.text()).should.equal('created');
  });

  it('json serializes with an application/json content type', async () => {
    const app = createApp();
    get(app, '/json', (ctx) => {
      json(ctx, { a: 1 }, { status: 201 });
    });
    const res = await handle(app, new Request('http://localhost/json'));
    res.status.should.equal(201);
    String(res.headers.get('content-type')).should.match(/application\/json/);
    (await res.json()).should.deep.equal({ a: 1 });
  });

  it('text and html default their content type; explicit headers win', async () => {
    const app = createApp();
    get(app, '/text', (ctx) => {
      text(ctx, 'plain');
    });
    get(app, '/html', (ctx) => {
      html(ctx, '<b>bold</b>');
    });
    get(app, '/csv', (ctx) => {
      text(ctx, 'a,b', { headers: { 'content-type': 'text/csv' } });
    });
    const textRes = await handle(app, new Request('http://localhost/text'));
    (textRes.headers.get('content-type') ?? '').should.equal('text/plain; charset=utf-8');
    (await textRes.text()).should.equal('plain');
    const htmlRes = await handle(app, new Request('http://localhost/html'));
    (htmlRes.headers.get('content-type') ?? '').should.equal('text/html; charset=utf-8');
    (await htmlRes.text()).should.equal('<b>bold</b>');
    const csvRes = await handle(app, new Request('http://localhost/csv'));
    (csvRes.headers.get('content-type') ?? '').should.equal('text/csv');
    (await csvRes.text()).should.equal('a,b');
  });

  it('redirect defaults to 302 and honors an explicit status', async () => {
    const app = createApp();
    get(app, '/temp', (ctx) => {
      redirect(ctx, '/new');
    });
    get(app, '/perm', (ctx) => {
      redirect(ctx, '/new', 301);
    });
    const temp = await handle(app, new Request('http://localhost/temp'));
    temp.status.should.equal(302);
    (temp.headers.get('location') ?? '').should.equal('/new');
    (temp.body === null).should.be.true;
    const perm = await handle(app, new Request('http://localhost/perm'));
    perm.status.should.equal(301);
    (perm.headers.get('location') ?? '').should.equal('/new');
  });
});
