import type { App } from '../src/app';

import { describe, it, vi } from 'vitest';

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
      // After next() settles, ctx.res is always set (handler response or
      // the materialized 404/405/500 fallback). Writing here overwrites it,
      // proving the unwind completes before handle() resolves and that the
      // outermost layer gets the last word.
      text(ctx, 'after');
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

  it('logs unknown errors to the console when onError is absent', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const app = createApp();
      get(app, '/boom', () => {
        throw new Error('kaboom');
      });
      const res = await handle(app, new Request('http://localhost/boom'));
      res.status.should.equal(500);
      spy.should.have.been.calledOnce;
      const logged = spy.mock.calls[0]?.[0] as Error;
      logged.message.should.equal('kaboom');
    } finally {
      spy.mockRestore();
    }
  });

  it('does not log intentional HttpErrors', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const app = createApp();
      get(app, '/nope', () => {
        throw httpError(404, 'gone');
      });
      const res = await handle(app, new Request('http://localhost/nope'));
      res.status.should.equal(404);
      spy.should.not.have.been.called;
    } finally {
      spy.mockRestore();
    }
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

describe('405 method misses', () => {
  it('answers a method miss with 405 and an Allow header in registration order', async () => {
    const app = createApp();
    get(app, '/x', () => new Response('get'));
    put(app, '/x', () => new Response('put'));
    const res = await handle(app, new Request('http://localhost/x', { method: 'DELETE' }));
    res.status.should.equal(405);
    (res.headers.get('allow') ?? '').should.equal('GET, PUT');
    (await res.json()).should.deep.equal({ error: 'Method Not Allowed' });
  });

  it('lets middlewares answer a method miss before the 405 fallback', async () => {
    const app = createApp();
    get(app, '/x', () => new Response('get'));
    use(app, (ctx, next) => {
      if (ctx.req.method === 'OPTIONS') {
        text(ctx, 'auto-options');
        return;
      }
      return next();
    });
    const res = await handle(app, new Request('http://localhost/x', { method: 'OPTIONS' }));
    res.status.should.equal(200);
    (await res.text()).should.equal('auto-options');
  });

  it('does not call onNotFound for a method miss', async () => {
    let notFoundRan = false;
    const app = createApp({ onNotFound: () => { notFoundRan = true; } });
    post(app, '/x', () => new Response('post'));
    const res = await handle(app, new Request('http://localhost/x', { method: 'GET' }));
    res.status.should.equal(405);
    notFoundRan.should.be.false;
    await handle(app, new Request('http://localhost/missing'));
    notFoundRan.should.be.true;
  });

  it('strips the body of a HEAD 405 but keeps the Allow header', async () => {
    const app = createApp();
    post(app, '/x', () => new Response('post'));
    const res = await handle(app, new Request('http://localhost/x', { method: 'HEAD' }));
    res.status.should.equal(405);
    (res.headers.get('allow') ?? '').should.equal('POST');
    (res.body === null).should.be.true;
  });
});

describe('chain caching', () => {
  it('applies middlewares registered after the first request', async () => {
    const app = createApp();
    get(app, '/x', (ctx) => text(ctx, 'plain'));
    const first = await handle(app, new Request('http://localhost/x'));
    first.status.should.equal(200);
    use(app, async (ctx, next) => {
      await next();
      ctx.res?.headers.set('x-added-later', 'yes');
    });
    const res = await handle(app, new Request('http://localhost/x'));
    (res.headers.get('x-added-later') ?? '').should.equal('yes');
  });

  it('reuses the cached route chain across repeated hits', async () => {
    let runs = 0;
    const app = createApp();
    get(
      app,
      '/count',
      async (_ctx, next) => {
        await next();
      },
      (ctx) => {
        runs += 1;
        text(ctx, String(runs));
      },
    );
    for (let i = 0; i < 3; i++) {
      const res = await handle(app, new Request('http://localhost/count'));
      res.status.should.equal(200);
      (await res.text()).should.equal(String(i + 1));
    }
    runs.should.equal(3);
  });
});

describe('route middleware', () => {
  it('runs between the app chain and the handler, unwinding in reverse', async () => {
    const order: string[] = [];
    const app = createApp();
    use(app, async (_ctx, next) => {
      order.push('app-in');
      await next();
      order.push('app-out');
    });
    get(
      app,
      '/x',
      async (_ctx, next) => {
        order.push('route-in');
        await next();
        order.push('route-out');
      },
      () => {
        order.push('handler');
        // A matched chain that writes nothing is a 500 by contract — write.
        return new Response('ok');
      },
    );
    const res = await handle(app, new Request('http://localhost/x'));
    res.status.should.equal(200);
    order.should.deep.equal(['app-in', 'route-in', 'handler', 'route-out', 'app-out']);
  });

  it('supports several route middlewares in registration order', async () => {
    const order: string[] = [];
    const app = createApp();
    get(
      app,
      '/x',
      async (_ctx, next) => {
        order.push('m1-in');
        await next();
        order.push('m1-out');
      },
      async (_ctx, next) => {
        order.push('m2-in');
        await next();
        order.push('m2-out');
      },
      (ctx) => {
        order.push('handler');
        text(ctx, 'ok');
      },
    );
    const res = await handle(app, new Request('http://localhost/x'));
    res.status.should.equal(200);
    order.should.deep.equal(['m1-in', 'm2-in', 'handler', 'm2-out', 'm1-out']);
  });

  it('short-circuits: a responding route middleware skips the handler, app unwind still runs', async () => {
    const order: string[] = [];
    const app = createApp();
    use(app, async (_ctx, next) => {
      await next();
      order.push('app-out');
    });
    get(
      app,
      '/secret',
      (ctx, next) => {
        if (ctx.query.get('token') !== 's200') {
          text(ctx, 'denied', { status: 401 });
          return; // no next(): the handler never runs
        }
        return next();
      },
      (ctx) => {
        order.push('handler');
        json(ctx, { ok: true });
      },
    );
    const denied = await handle(app, new Request('http://localhost/secret'));
    denied.status.should.equal(401);
    (await denied.text()).should.equal('denied');
    order.should.deep.equal(['app-out']);

    const allowed = await handle(app, new Request('http://localhost/secret?token=s200'));
    allowed.status.should.equal(200);
    (await allowed.json()).should.deep.equal({ ok: true });
    order.should.deep.equal(['app-out', 'handler', 'app-out']);
  });

  it('maps an HttpError thrown from a route middleware to its status', async () => {
    const app = createApp();
    get(
      app,
      '/admin',
      () => {
        throw httpError(403, 'Login required');
      },
      (ctx) => json(ctx, { ok: true }),
    );
    const res = await handle(app, new Request('http://localhost/admin'));
    res.status.should.equal(403);
    (await res.json()).should.deep.equal({ error: 'Login required' });
  });

  it('is scoped: route middlewares do not run for other routes or unmatched requests', async () => {
    let ran = false;
    const app = createApp();
    get(
      app,
      '/a',
      async (_ctx, next) => {
        ran = true;
        await next();
      },
      (ctx) => text(ctx, 'a'),
    );
    get(app, '/b', (ctx) => text(ctx, 'b'));
    await handle(app, new Request('http://localhost/b'));
    ran.should.be.false;
    await handle(app, new Request('http://localhost/nowhere'));
    ran.should.be.false;
    const hit = await handle(app, new Request('http://localhost/a'));
    (await hit.text()).should.equal('a');
    ran.should.be.true;
  });

  it('rejects a double next() inside a route middleware', async () => {
    const app = createApp();
    get(
      app,
      '/x',
      async (_ctx, next) => {
        await next();
        await next();
      },
      (ctx) => text(ctx, 'x'),
    );
    const res = await handle(app, new Request('http://localhost/x'));
    res.status.should.equal(500);
    (await res.json()).should.deep.equal({ error: 'Internal Server Error' });
  });

  it('accepts route middlewares through addRoute with a custom method', async () => {
    const order: string[] = [];
    const app = createApp();
    addRoute(
      app,
      'PURGE',
      '/cache/:key',
      async (_ctx, next) => {
        order.push('mw');
        await next();
      },
      (ctx) => json(ctx, { purged: ctx.params.key }),
    );
    const res = await handle(app, new Request('http://localhost/cache/imgs', { method: 'PURGE' }));
    (await res.json()).should.deep.equal({ purged: 'imgs' });
    order.should.deep.equal(['mw']);
  });

  it('keeps ctx.params typed for the terminal handler behind middlewares', async () => {
    const app = createApp();
    get(
      app,
      '/users/:id/posts/:postId',
      async (_ctx, next) => {
        await next();
      },
      // ctx.params.id / ctx.params.postId compile only through ParamsOf inference
      (ctx) => json(ctx, { id: ctx.params.id, postId: ctx.params.postId }),
    );
    const res = await handle(app, new Request('http://localhost/users/7/posts/9'));
    (await res.json()).should.deep.equal({ id: '7', postId: '9' });
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

describe('error boundary inside the chain', () => {
  it('middleware unwind code observes error responses (headers, status)', async () => {
    const app = createApp();
    use(app, async (ctx, next) => {
      await next();
      // The handler threw — but the error boundary below the middlewares
      // already materialized the response, so the unwind sees the real one.
      ctx.res!.headers.set('x-observed-status', String(ctx.res!.status));
    });
    get(app, '/boom', () => {
      throw new Error('kaboom');
    });
    const res = await handle(app, new Request('http://localhost/boom'));
    res.status.should.equal(500);
    res.headers.get('x-observed-status')!.should.equal('500');
    (await res.json()).should.deep.equal({ error: 'Internal Server Error' });
  });

  it('still routes a middleware-own throw to onError (outer boundary)', async () => {
    const boom = new Error('early');
    let caught: Error | undefined;
    const app = createApp({
      onError: (_ctx, error) => {
        caught = error as Error;
        return Promise.resolve();
      },
    });
    use(app, async () => {
      throw boom;
    });
    const res = await handle(app, new Request('http://localhost/x'));
    caught!.should.equal(boom);
    res.status.should.equal(404); // onError wrote nothing → fallback applies
  });

  it('exposes the parsed URL and a fresh state bag on ctx', async () => {
    const app = createApp();
    get(app, '/u/:id', (ctx) => {
      ctx.state.seen = ctx.url.pathname;
      return new Response(`${ctx.state.seen}|${ctx.url.searchParams.get('q') ?? ''}`);
    });
    const res = await handle(app, new Request('http://localhost/u/7?q=z'));
    (await res.text()).should.equal('/u/7|z');
  });

  it('honors the strict option on createApp', async () => {
    const tolerant = createApp({ strict: false });
    get(tolerant, '/a', () => new Response('tolerant'));
    (await handle(tolerant, new Request('http://localhost/a/'))).status.should.equal(200);

    const strict = createApp();
    get(strict, '/a', () => new Response('strict'));
    (await handle(strict, new Request('http://localhost/a/'))).status.should.equal(404);
  });
});
