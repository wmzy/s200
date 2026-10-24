import { describe, it } from 'vitest';

import { createApp, get, handle, use } from '../src/app';
import { rateLimit } from '../src/rate-limit';
import { isHttpError } from '../src/errors';
import { json, setHeader } from '../src/respond';

function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe('rateLimit', function () {
  it('allows requests up to the limit, then answers 429 in place', async function () {
    const time = clock();
    const app = createApp();
    use(app, rateLimit({ windowMs: 1000, limit: 2, now: time.now }));
    get(app, '/', () => new Response('ok'));

    (await (await handle(app, new Request('http://localhost/'))).text()).should.equal('ok');
    (await (await handle(app, new Request('http://localhost/'))).text()).should.equal('ok');
    const blocked = await handle(app, new Request('http://localhost/'));
    blocked.status.should.equal(429);
    (await blocked.json()).should.deep.equal({ error: 'Too Many Requests' });
    // Retry-After: the rest of the current window, at least one second.
    (blocked.headers.get('retry-after') ?? '').should.equal('1');
  });

  it('never calls next() past the limit — the handler stays out of it', async function () {
    let handled = 0;
    const time = clock();
    const app = createApp();
    use(app, rateLimit({ windowMs: 1000, limit: 1, now: time.now }));
    get(app, '/', () => {
      handled += 1;
      return new Response('ok');
    });
    await handle(app, new Request('http://localhost/'));
    const blocked = await handle(app, new Request('http://localhost/'));
    blocked.status.should.equal(429);
    handled.should.equal(1);
  });

  it('resets the count when the window rolls over', async function () {
    const time = clock();
    const app = createApp();
    use(app, rateLimit({ windowMs: 1000, limit: 1, now: time.now }));
    get(app, '/', () => new Response('ok'));
    await handle(app, new Request('http://localhost/'));
    (await handle(app, new Request('http://localhost/'))).status.should.equal(429);
    time.advance(1000);
    (await handle(app, new Request('http://localhost/'))).status.should.equal(200);
  });

  it('keys buckets by x-forwarded-for by default, and by a custom key fn', async function () {
    const time = clock();
    const app = createApp();
    use(app, rateLimit({ windowMs: 1000, limit: 1, now: time.now }));
    get(app, '/', () => new Response('ok'));
    const a = (headers: Record<string, string>) =>
      new Request('http://localhost/', { headers });
    (await handle(app, a({ 'x-forwarded-for': '1.1.1.1' }))).status.should.equal(200);
    (await handle(app, a({ 'x-forwarded-for': '2.2.2.2' }))).status.should.equal(200);
    (await handle(app, a({ 'x-forwarded-for': '1.1.1.1, 10.0.0.1' }))).status.should.equal(429);

    const custom = createApp();
    use(
      custom,
      rateLimit({
        windowMs: 1000,
        limit: 1,
        now: time.now,
        key: (ctx) => ctx.req.headers.get('authorization') ?? 'anon',
      })
    );
    get(custom, '/', () => new Response('ok'));
    (await handle(custom, a({ authorization: 'u1' }))).status.should.equal(200);
    (await handle(custom, a({ authorization: 'u2' }))).status.should.equal(200);
    (await handle(custom, a({ authorization: 'u1' }))).status.should.equal(429);
  });

  it('rejects non-positive window and limit at creation', function () {
    (() => rateLimit({ windowMs: 0 })).should.throw(/must be positive/);
    (() => rateLimit({ limit: 0 })).should.throw(/must be positive/);
  });

  it('tags the IETF RateLimit-* headers alongside Retry-After', async function () {
    const time = clock();
    const app = createApp();
    use(app, rateLimit({ windowMs: 10_000, limit: 3, now: time.now }));
    get(app, '/', () => new Response('ok'));
    for (let i = 0; i < 3; i += 1) {
      await handle(app, new Request('http://localhost/'));
    }
    time.advance(2_000); // oldest blocking hit still has 8s to live
    const blocked = await handle(app, new Request('http://localhost/'));
    blocked.status.should.equal(429);
    (blocked.headers.get('retry-after') ?? '').should.equal('8');
    (blocked.headers.get('ratelimit-limit') ?? '').should.equal('3');
    (blocked.headers.get('ratelimit-remaining') ?? '').should.equal('0');
    // Reset is the same seconds remainder as Retry-After.
    (blocked.headers.get('ratelimit-reset') ?? '').should.equal('8');
  });

  it('hands the 429 rejection to a configured onError, RateLimit-* on the error', async function () {
    const seen: unknown[] = [];
    const time = clock();
    const app = createApp({
      onError: (ctx, error) => {
        seen.push(error);
        json(ctx, { error: 'slow down' }, { status: 429 });
      },
    });
    use(app, rateLimit({ windowMs: 1000, limit: 1, now: time.now }));
    get(app, '/', () => new Response('ok'));
    await handle(app, new Request('http://localhost/'));
    const blocked = await handle(app, new Request('http://localhost/'));
    // The policy owns the wire answer — no gate headers unless it adds them.
    blocked.status.should.equal(429);
    (await blocked.json()).should.deep.equal({ error: 'slow down' });
    (blocked.headers.get('retry-after') ?? '').should.equal('');
    const err = seen[0];
    isHttpError(err).should.be.true;
    if (isHttpError(err)) {
      err.status.should.equal(429);
      (err.headers?.['retry-after'] ?? '').should.equal('1');
      (err.headers?.['ratelimit-limit'] ?? '').should.equal('1');
      (err.headers?.['ratelimit-remaining'] ?? '').should.equal('0');
    }
  });

  it('drains setHeader-pending headers onto the 429 (newResponse funnel regression)', async function () {
    const time = clock();
    const app = createApp();
    use(app, async (ctx, next) => {
      setHeader(ctx, 'x-request-scope', 'abc');
      await next();
    });
    use(app, rateLimit({ windowMs: 1000, limit: 1, now: time.now }));
    get(app, '/', () => new Response('ok'));
    await handle(app, new Request('http://localhost/'));
    const blocked = await handle(app, new Request('http://localhost/'));
    blocked.status.should.equal(429);
    (blocked.headers.get('x-request-scope') ?? '').should.equal('abc');
    (blocked.headers.get('ratelimit-limit') ?? '').should.equal('1');
  });
});

describe('rateLimit sliding window', () => {
  it('is burst-proof at window edges, unlike a fixed-window counter', async () => {
    const time = clock();
    const app = createApp();
    use(app, rateLimit({ windowMs: 1000, limit: 1, now: time.now }));
    get(app, '/', () => new Response('ok'));

    (await handle(app, new Request('http://localhost/'))).status.should.equal(200);
    // 900ms later the first hit is still inside the window — blocked.
    time.advance(900);
    (await handle(app, new Request('http://localhost/'))).status.should.equal(429);
    // Even after the FIRST hit ages out, the t=900 hit still blocks...
    time.advance(101);
    (await handle(app, new Request('http://localhost/'))).status.should.equal(429);
    // ...only once every in-window hit aged out does a retry pass.
    time.advance(1000);
    (await handle(app, new Request('http://localhost/'))).status.should.equal(200);
  });

  it('computes Retry-After from the oldest blocking hit', async () => {
    const time = clock();
    const app = createApp();
    use(app, rateLimit({ windowMs: 1000, limit: 1, now: time.now }));
    get(app, '/', () => new Response('ok'));

    await handle(app, new Request('http://localhost/'));
    time.advance(400);
    const blocked = await handle(app, new Request('http://localhost/'));
    // The first hit expires 600ms from now → ceil to 1s minimum.
    blocked.headers.get('retry-after')!.should.equal('1');
    time.advance(1000);
    (await handle(app, new Request('http://localhost/'))).status.should.equal(200);
  });

  it('runs an injected async store and 429s per its verdict', async () => {
    const time = clock();
    const hits: string[] = [];
    const app = createApp();
    use(
      app,
      rateLimit({
        windowMs: 1000,
        limit: 1,
        now: time.now,
        store: {
          async hit(key, now, _limit, windowMs) {
            hits.push(key);
            const allowed = hits.length <= 1;
            return { count: hits.length, retryAt: allowed ? now : now + windowMs };
          },
        },
      }),
    );
    get(app, '/', () => new Response('ok'));
    (await handle(app, new Request('http://localhost/'))).status.should.equal(200);
    const blocked = await handle(app, new Request('http://localhost/'));
    blocked.status.should.equal(429);
    blocked.headers.get('retry-after')!.should.equal('1');
    hits.should.deep.equal(['unknown', 'unknown']);
  });
});
