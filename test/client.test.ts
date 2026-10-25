import { describe, expectTypeOf, it } from 'vitest';

import { createApp, get, post, all, del, mount, removeRoute, use } from '../src/app';
import {
  createClient,
  type ClientInit,
  type ClientMiddleware,
  type ClientResponse,
} from '../src/client';
import { json } from '../src/respond';
import { bodyShape } from '../src/validate';

// vitest's should chain has no rejectedWith; capture manually instead.
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined; // resolved — property assertions below will fail
}

describe('client (typed fetch)', () => {
  function capture() {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response('{"ok":true}', { status: 200 });
    };
    return { calls, fetch };
  }

  it('fills static paths and encodes params', async () => {
    const app = createApp();
    const withGet = get(app, '/users/:id', (ctx) => new Response(ctx.params.id));
    const { calls, fetch } = capture();
    const client = createClient(withGet, { baseUrl: 'http://x.test', fetch });

    await client.get('/users/:id', { id: 'foo bar' });
    calls[0]?.url.should.equal('http://x.test/users/foo%20bar');
    calls[0]?.init.method?.should.equal('GET');
  });

  it('keeps slashes in wildcard captures but encodes each piece', async () => {
    const app = createApp();
    const withGet = get(app, '/files/*path', () => new Response('ok'));
    const { calls, fetch } = capture();
    const client = createClient(withGet, { baseUrl: 'http://x.test', fetch });

    await client.get('/files/*path', { path: 'a/b c' });
    calls[0]?.url.should.equal('http://x.test/files/a/b%20c');
  });

  it('appends query params, repeating arrays and skipping undefined', async () => {
    const app = createApp();
    const withGet = get(app, '/list', () => new Response('ok'));
    const { calls, fetch } = capture();
    const client = createClient(withGet, { fetch });

    await client.get('/list', { query: { page: 2, tag: ['a', 'b'], skip: undefined, on: true } });
    calls[0]?.url.should.equal('/list?page=2&tag=a&tag=b&on=true');
  });

  it('sends the right method per group and offers ALL routes on every method', async () => {
    const app = createApp();
    const withPost = post(app, '/p', () => new Response('post'));
    const withAll = all(withPost, '/any', () => new Response('any'));
    const full = del(withAll, '/d/:id', () => new Response('del'));
    const { calls, fetch } = capture();
    const client = createClient(full, { fetch });

    await client.post('/p');
    calls[0]?.init.method?.should.equal('POST');
    await client.put('/any');
    calls[1]?.init.method?.should.equal('PUT');
    await client.delete('/d/:id', { id: '7' });
    calls[2]?.url.should.equal('/d/7');
    calls[2]?.init.method?.should.equal('DELETE');
  });

  it('JSON-encodes a plain-object body on a bodyShape route', async () => {
    const app = createApp();
    const withShape = post(
      app,
      '/shaped',
      bodyShape<{ a: number }>(),
      () => new Response('ok')
    );
    const { calls, fetch } = capture();
    const client = createClient(withShape, { baseUrl: 'http://x.test', fetch });

    // The encoding follows the runtime value: the declared structured type
    // is `{ a: number }`, so the client sends it as JSON, not as a
    // pass-through object.
    await client.post('/shaped', { body: { a: 1 } });
    (calls[0]?.init.body as string).should.equal('{"a":1}');
    new Headers(calls[0]?.init.headers).get('content-type')?.should.equal('application/json');
  });

  it('throws on missing params and unknown patterns', async () => {
    const app = createApp();
    const withGet = get(app, '/users/:id', () => new Response('ok'));
    const { fetch } = capture();
    const client = createClient(withGet, { fetch });

    await client.get('/users/:id', { id: '1' });
    // Call-time param errors throw synchronously (they are caller bugs,
    // not network failures) — the unknown-pattern guard matches. '/nope'
    // is not a registered literal, so the typed surface rejects it at
    // compile time; drop to the loose shape to exercise the runtime guard.
    const loose = client as { get: (pattern: string, ...rest: unknown[]) => Promise<Response> };
    (() => client.get('/users/:id', {} as { id: string })).should.throw(/Missing param 'id'/);
    (() => loose.get('/nope', undefined)).should.throw(/No GET route '\/nope'/);
  });

  it('survives route removal at runtime', async () => {
    const app = createApp();
    const withA = get(app, '/a', () => new Response('a'));
    const withB = get(withA, '/b', () => new Response('b'));
    // Removal happens before client creation: the runtime table no longer
    // carries /a, so the call throws even though `withB`'s type (a stale
    // snapshot) still offers it. Threading removeRoute's own return would
    // erase /a from the type instead — both honest, this tests the stale
    // corner.
    removeRoute(withB, 'GET', '/a');
    const { calls, fetch } = capture();
    const client = createClient(withB, { fetch });

    await client.get('/b');
    calls.length.should.equal(1);
    (() => client.get('/a', undefined)).should.throw(/No GET route/);
  });

  it('follows mounted routes through the phantom log', async () => {
    const sub = createApp();
    const subWithGet = get(sub, '/users/:id', () => new Response('ok'));
    const app = createApp();
    const mounted = mount(app, '/v1', subWithGet);
    const { calls, fetch } = capture();
    const client = createClient(mounted, { fetch });

    await client.get('/v1/users/:id', { id: '3' });
    calls[0]?.url.should.equal('/v1/users/3');
  });

  it('types paths, params and query through the app', () => {
    // The phantom route log accumulates through the registrars' return
    // types — thread the returns to keep it (the value is the same app).
    const app = createApp();
    const withMw = use(app, async (ctx, next) => next());
    const withGet = get(withMw, '/users/:id', (ctx) => new Response(ctx.params.id));
    const full = post(withGet, '/users/:id?', () => new Response('ok'));
    // Stubbed fetch: the compile-time calls below must not hit the network
    // (a relative URL would reject unhandled and pollute the suite).
    const client = createClient(full, { fetch: async () => new Response('ok') });
    type Get = typeof client.get;
    // A required-param route demands typed args (the optional-param route
    // is also callable for that path — contravariance keeps the union
    // assignable to this signature).
    expectTypeOf<Get>().toExtend<
      (path: '/users/:id', args: { id: string }, init?: ClientInit) => Promise<Response>
    >();
    // Compile-time calls: wrong shapes fail the build.
    void client.get('/users/:id', { id: 'x' }, { query: { a: '1' } });
    void client.post('/users/:id?', {});
  });

  it('types response bodies from json-branded handlers', () => {
    const app = createApp();
    // Sync and async handlers both resolve: the brand survives the
    // Promise unwrap in ResolveOut.
    const withSync = get(app, '/users/:id', (ctx) =>
      json(ctx, { id: Number(ctx.params.id), name: 'ada' })
    );
    const withAsync = get(withSync, '/ping', async (ctx) => json(ctx, { ok: true }));
    // A plain Response handler stays untyped (unknown, not any).
    const full = get(withAsync, '/plain', () => new Response('ok'));
    // Stubbed fetch: the typed call below must not hit the network.
    const client = createClient(full, { fetch: async () => new Response('ok') });
    void client.get('/users/:id', { id: '1' });

    expectTypeOf<typeof client.get>().toExtend<
      (
        path: '/users/:id',
        args: { id: string },
        init?: ClientInit
      ) => Promise<ClientResponse<{ id: number; name: string }>>
    >();
    expectTypeOf<typeof client.get>().toExtend<
      (path: '/ping', init?: ClientInit) => Promise<ClientResponse<{ ok: boolean }>>
    >();
    expectTypeOf<typeof client.get>().toExtend<
      (path: '/plain', init?: ClientInit) => Promise<ClientResponse<unknown>>
    >();
  });

  it('keeps response-body types through mount', () => {
    const sub = createApp();
    const subWithGet = get(sub, '/item/:id', (ctx) => json(ctx, { id: ctx.params.id }));
    const app = createApp();
    const mounted = mount(app, '/v1', subWithGet);
    const client = createClient(mounted, { fetch: async () => new Response('ok') });
    void client.get('/v1/item/:id', { id: '7' });

    expectTypeOf<typeof client.get>().toExtend<
      (
        path: '/v1/item/:id',
        args: { id: string },
        init?: ClientInit
      ) => Promise<ClientResponse<{ id: string }>>
    >();
  });
});

describe('client signal, timeout & baseUrl guard', () => {
  /** A fetch that never settles on its own — only an abort can end it. */
  const hangingFetch = (input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    });

  it('applies the client-level signal to every request', async () => {
    const app = get(createApp(), '/x', () => new Response('ok'));
    const controller = new AbortController();
    const signals: (AbortSignal | undefined)[] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      return new Response('ok');
    };
    const client = createClient(app, { baseUrl: 'http://x.test', fetch, signal: controller.signal });
    await client.get('/x');
    await client.get('/x');
    signals[0]!.should.equal(controller.signal);
    signals[1]!.should.equal(controller.signal);
  });

  it('lets a per-call init.signal override the client signal', async () => {
    const app = get(createApp(), '/x', () => new Response('ok'));
    const clientSignal = new AbortController().signal;
    const callSignal = new AbortController().signal;
    const signals: (AbortSignal | undefined)[] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      return new Response('ok');
    };
    const client = createClient(app, { baseUrl: 'http://x.test', fetch, signal: clientSignal });
    await client.get('/x', { signal: callSignal });
    signals[0]!.should.equal(callSignal);
  });

  it('aborts a hanging request at timeoutMs (TimeoutError)', async () => {
    const app = get(createApp(), '/hang', () => new Response('ok'));
    const client = createClient(app, {
      baseUrl: 'http://x.test',
      fetch: hangingFetch,
      timeoutMs: 10,
    });
    const error = (await rejectionOf(client.get('/hang'))) as DOMException;
    error.name.should.equal('TimeoutError');
  });

  it('races the user signal with the timeout (linked, not replaced)', async () => {
    const app = get(createApp(), '/x', () => new Response('ok'));
    const controller = new AbortController();
    const signals: (AbortSignal | undefined)[] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      return new Response('ok');
    };
    const client = createClient(app, {
      baseUrl: 'http://x.test',
      fetch,
      signal: controller.signal,
      timeoutMs: 60_000, // far away — only the user signal decides here
    });
    await client.get('/x');
    signals[0]!.should.not.equal(controller.signal); // a linked composite
    controller.abort(new Error('gone'));
    signals[0]!.aborted.should.equal(true);
    ((signals[0]!.reason as Error).message as string).should.equal('gone');
  });

  it('throws at creation with a baseUrl hint when Node has no location', async () => {
    const app = get(createApp(), '/x', () => new Response('ok'));
    // Node (this suite's runtime) defines no globalThis.location — the
    // guard's exact target. The message must name the remedy, and must
    // fire at createClient time, not on the first request.
    (typeof globalThis.location).should.equal('undefined');
    const error = (await rejectionOf(
      Promise.resolve().then(() => createClient(app))
    )) as Error;
    error.message.should.contain('baseUrl');
    // An injected fetch owns URL resolution itself — no guard.
    const shim = createClient(app, { fetch: async () => new Response('ok') });
    (await shim.get('/x')).status.should.equal(200);
  });

  it('keeps relative URLs working when globalThis.location exists', async () => {
    const app = get(createApp(), '/x', () => new Response('ok'));
    const original = (globalThis as { location?: unknown }).location;
    Object.defineProperty(globalThis, 'location', {
      value: new URL('http://browser.test/'),
      configurable: true,
    });
    try {
      const calls: string[] = [];
      const fetch = async (input: string | URL | Request) => {
        calls.push(String(input));
        return new Response('ok');
      };
      const client = createClient(app, { fetch }); // no baseUrl, no throw
      await client.get('/x');
      calls[0]!.should.equal('/x');
    } finally {
      delete (globalThis as { location?: unknown }).location;
      if (original !== undefined) {
        Object.defineProperty(globalThis, 'location', { value: original, configurable: true });
      }
    }
  });
});

describe('client middleware', () => {
  it('injects headers around the built request (outer layer sees init headers too)', async () => {
    const app = get(createApp(), '/users/:id', (ctx) => new Response(ctx.params.id));
    const seen: { url: string; auth: string | null; accept: string | null }[] = [];
    const fetch = async (input: string | URL | Request) => {
      const req = input as Request;
      seen.push({
        url: req.url,
        auth: req.headers.get('authorization'),
        accept: req.headers.get('accept'),
      });
      return new Response('ok');
    };
    const client = createClient(app, {
      baseUrl: 'http://x.test',
      fetch,
      middleware: [
        async (req, next) => {
          // The merge pattern the client itself uses for content-type: a
          // Headers copy over the incoming set, so nothing is dropped.
          const headers = new Headers(req.headers);
          headers.set('authorization', 'Bearer t0k3n');
          return next(new Request(req, { headers }));
        },
      ],
    });
    const res = await client.get('/users/:id', { id: '7' }, { headers: { accept: 'text/*' } });
    res.status.should.equal(200);
    seen[0]?.url.should.equal('http://x.test/users/7');
    (seen[0]?.auth ?? '').should.equal('Bearer t0k3n');
    (seen[0]?.accept ?? '').should.equal('text/*');
  });

  it('hands the chain the fully built request (query, JSON body, method)', async () => {
    const app = post(createApp(), '/echo', bodyShape<{ a: number }>(), () => new Response('ok'));
    const seen: { method: string; url: string; type: string | null; body: string }[] = [];
    const client = createClient(app, {
      baseUrl: 'http://x.test',
      fetch: async (input) => {
        const req = input as Request;
        seen.push({
          method: req.method,
          url: req.url,
          type: req.headers.get('content-type'),
          body: await req.text(),
        });
        return new Response('ok');
      },
      middleware: [async (req, next) => next(req)],
    });
    await client.post('/echo', { body: { a: 1 }, query: { b: '2' } });
    seen[0]?.method.should.equal('POST');
    seen[0]?.url.should.equal('http://x.test/echo?b=2');
    (seen[0]?.type ?? '').should.equal('application/json');
    seen[0]?.body.should.equal('{"a":1}');
  });

  it('retries an idempotent GET on 503, bounded', async () => {
    const app = get(createApp(), '/x', () => new Response('ok'));
    const statuses = [503, 503, 200];
    const urls: string[] = [];
    const fetch = async (input: string | URL | Request) => {
      urls.push((input as Request).url);
      return new Response('busy', { status: statuses[urls.length - 1] ?? 200 });
    };
    const retryOn503: ClientMiddleware = async (req, next) => {
      for (let attempt = 1; ; attempt++) {
        const res = await next(req);
        if (res.status !== 503 || attempt >= 3) return res;
      }
    };
    const client = createClient(app, {
      baseUrl: 'http://x.test',
      fetch,
      middleware: [retryOn503],
    });
    const res = await client.get('/x');
    res.status.should.equal(200);
    urls.should.toEqual(['http://x.test/x', 'http://x.test/x', 'http://x.test/x']);
  });

  it('runs the first registered middleware outermost', async () => {
    const app = get(createApp(), '/x', () => new Response('ok'));
    const events: string[] = [];
    const fetch = async () => {
      events.push('fetch');
      return new Response('ok');
    };
    const outermost: ClientMiddleware = async (req, next) => {
      events.push('outer>');
      const res = await next(req);
      events.push('outer<');
      return res;
    };
    const innermost: ClientMiddleware = async (req, next) => {
      events.push('inner>');
      const res = await next(req);
      events.push('inner<');
      return res;
    };
    const client = createClient(app, {
      baseUrl: 'http://x.test',
      fetch,
      middleware: [outermost, innermost],
    });
    await client.get('/x');
    events.should.toEqual(['outer>', 'inner>', 'fetch', 'inner<', 'outer<']);
  });

  it('propagates a middleware-thrown error untouched', async () => {
    const app = get(createApp(), '/x', () => new Response('ok'));
    const boom = new Error('middleware failed');
    const client = createClient(app, {
      baseUrl: 'http://x.test',
      fetch: async () => new Response('ok'),
      middleware: [
        async () => {
          throw boom;
        },
      ],
    });
    const error = await rejectionOf(client.get('/x'));
    (error as Error).should.equal(boom);
  });

  it('aborts the whole call — the signal on the request ends retries too', async () => {
    const app = get(createApp(), '/x', () => new Response('ok'));
    const controller = new AbortController();
    let attempts = 0;
    const signals: AbortSignal[] = [];
    const fetch = async (input: string | URL | Request): Promise<Response> => {
      attempts += 1;
      signals.push((input as Request).signal);
      // Attempt 1 settles 503 so the middleware issues a retry; attempt 2
      // hangs — only the abort can end it (the whole-call contract).
      if (attempts === 1) {
        return new Response('busy', { status: 503 });
      }
      return new Promise<Response>((_, reject) => {
        signals[signals.length - 1]!.addEventListener(
          'abort',
          () => reject(signals[signals.length - 1]!.reason),
          { once: true }
        );
      });
    };
    const retryOnce: ClientMiddleware = async (req, next) => {
      const first = await next(req);
      return first.status === 503 ? next(req) : first;
    };
    const client = createClient(app, {
      baseUrl: 'http://x.test',
      fetch,
      signal: controller.signal,
      middleware: [retryOnce],
    });
    const pending = client.get('/x');
    await new Promise((resolve) => setTimeout(resolve, 0)); // attempt 1 → retry starts
    controller.abort(new Error('gone'));
    const error = (await rejectionOf(pending)) as Error;
    error.message.should.equal('gone');
    attempts.should.equal(2);
    // One window per call: every attempt rides the same request signal.
    signals[0]!.should.equal(signals[1]!);
    signals[1]!.aborted.should.equal(true);
  });

  it('throws at creation on a non-function middleware entry', () => {
    const app = get(createApp(), '/x', () => new Response('ok'));
    const bad = ['not a function'] as unknown as readonly ClientMiddleware[];
    // Options-level misuse fails at createClient time with the remedy —
    // the same contract as the missing-baseUrl guard.
    (() =>
      createClient(app, {
        baseUrl: 'http://x.test',
        fetch: async () => new Response('ok'),
        middleware: bad,
      })).should.throw(/options.middleware\[0\] is not a function \(got string\)/);
  });

  it('keeps the typed call surface unchanged with middleware in place', async () => {
    const app = get(
      createApp(),
      '/users/:id',
      (ctx) => json(ctx, { id: ctx.params.id })
    );
    const plain = createClient(app, { fetch: async () => new Response('{"id":"7"}') });
    const hooked = createClient(app, {
      baseUrl: 'http://x.test',
      fetch: async () => new Response('{"id":"7"}'),
      middleware: [async (req, next) => next(req)],
    });
    // The hook is additive: the overloaded call signatures and the typed
    // response union are byte-for-byte the client's own.
    expectTypeOf(hooked.get).toEqualTypeOf(plain.get);
    expectTypeOf(hooked.get('/users/:id', { id: '7' })).toExtend<
      Promise<ClientResponse<{ id: string }>>
    >();
    const res = await hooked.get('/users/:id', { id: '7' });
    res.status.should.equal(200);
    (await res.json()).id.should.equal('7');
  });
});
