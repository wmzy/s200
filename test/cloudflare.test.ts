import type { WorkerHandler } from '../src/cloudflare';

import { describe, expectTypeOf, it } from 'vitest';

import { createApp, get, use } from '../src/app';
import { createHandler } from '../src/cloudflare';
import { json } from '../src/respond';
import { neverSignal } from '../src/signal';

/** The env binding record Workers passes to fetch — unused by the shape. */
const env: Record<string, unknown> = {};

/** The execution context Workers passes to fetch (waitUntil only here). */
const workerCtx = { waitUntil: () => undefined };

describe('cloudflare createHandler', () => {
  it('returns the module-worker fetch shape', () => {
    const worker = createHandler(createApp());
    expectTypeOf(worker).toEqualTypeOf<WorkerHandler>();
    (typeof worker.fetch).should.equal('function');
    Object.keys(worker).should.deep.equal(['fetch']);
  });

  it('dispatches fetch(request) through the full handle chain', async () => {
    const app = createApp();
    // Same probe as the deno smoke: after next() resolves the response
    // must already exist, so the unwind can observe and re-stamp it.
    use(app, async (ctx, next) => {
      await next();
      if (ctx.res !== undefined) {
        const headers = new Headers(ctx.res.headers);
        headers.set('x-s200', 'cloudflare');
        ctx.res = new Response(ctx.res.body, {
          status: ctx.res.status,
          statusText: ctx.res.statusText,
          headers,
        });
      }
    });
    get(app, '/hello', (ctx) => json(ctx, { hello: 'workerd' }));
    get(app, '/users/:id', (ctx) => json(ctx, { id: ctx.params.id }));

    const worker = createHandler(app);
    const hello = await worker.fetch(new Request('http://worker/hello'), env, workerCtx);
    hello.status.should.equal(200);
    (await hello.json()).should.deep.equal({ hello: 'workerd' });
    (hello.headers.get('x-s200') ?? '').should.equal('cloudflare');

    const user = await worker.fetch(new Request('http://worker/users/42'), env, workerCtx);
    user.status.should.equal(200);
    (await user.json()).should.deep.equal({ id: '42' });
  });

  it('materializes the 404 fallback inside the chain', async () => {
    const app = createApp();
    let stamped = 0;
    use(app, async (ctx, next) => {
      await next();
      if (ctx.res !== undefined) {
        stamped += 1;
      }
    });
    const res = await createHandler(app).fetch(new Request('http://worker/nope'), env, workerCtx);
    res.status.should.equal(404);
    (await res.json()).should.deep.equal({ error: 'Not Found' });
    stamped.should.equal(1);
  });

  it('threads the request signal as ctx.signal (feature detection)', async () => {
    const controller = new AbortController();
    const app = createApp();
    let seen: AbortSignal | undefined;
    use(app, async (ctx, next) => {
      seen = ctx.signal;
      await next();
    });
    // RequestInit.signal is cloned per the fetch spec, so the identity the
    // adapter must preserve is with the REQUEST's own signal.
    const request = new Request('http://worker/any', { signal: controller.signal });
    await createHandler(app).fetch(request, env, workerCtx);
    seen!.should.equal(request.signal);
  });

  it('aborts ctx.signal when the fetch request disconnects', async () => {
    const controller = new AbortController();
    const app = createApp();
    let armed: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      armed = resolve;
    });
    get(
      app,
      '/slow',
      (ctx) =>
        new Promise<void>((resolve) => {
          armed();
          ctx.signal.addEventListener('abort', () => {
            json(ctx, { aborted: ctx.signal.aborted });
            resolve();
          });
        }),
    );
    const pending = createHandler(app).fetch(
      new Request('http://worker/slow', { signal: controller.signal }),
      env,
      workerCtx,
    );
    await gate;
    controller.abort();
    const res = await pending;
    res.status.should.equal(200);
    (await res.json()).should.deep.equal({ aborted: true });
  });

  it('shares the never-aborted signal when the runtime Request has none', async () => {
    const app = createApp();
    let seen: AbortSignal | undefined;
    use(app, async (ctx, next) => {
      seen = ctx.signal;
      await next();
    });
    get(app, '/hello', (ctx) => json(ctx, { hello: 'workerd' }));
    // A structural Request without a signal property — the shape runtimes
    // whose Request lacks the fetch-disconnect signal present, which
    // signalInit feature-detects to return no init at all.
    const bare = {
      url: 'http://worker/hello',
      method: 'GET',
      headers: new Headers(),
    } as unknown as Request;
    const res = await createHandler(app).fetch(bare, env, workerCtx);
    res.status.should.equal(200);
    (await res.json()).should.deep.equal({ hello: 'workerd' });
    seen!.should.equal(neverSignal);
  });
});
