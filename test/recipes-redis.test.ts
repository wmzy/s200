import type { Ctx } from '../src/types';

import { describe, it } from 'vitest';

import { createApp, get, use } from '../src/app';
import { rateLimit } from '../src/rate-limit';
import { createSession, type Session } from '../src/session';
import { request } from '../src/test';
import {
  createRedisRateLimitStore,
  createRedisSessionStore,
  type RedisLike,
} from '../recipes/redis-stores';

function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

type FakeEntry = { value: string; expiresAt: number };

/**
 * In-memory stand-in for a Redis server: string values, millisecond
 * TTLs on a virtual clock, lazy expiry on read. `eval` implements the
 * semantics the rate-limit recipe's script relies on — INCR, then a
 * PTTL that arms PEXPIRE only for keys with no TTL — rather than
 * parsing Lua; `entries` stays exposed for seeding and inspection.
 */
function fakeRedis(time: { now: () => number }): RedisLike & {
  readonly entries: Map<string, FakeEntry>;
  readonly scripts: readonly string[];
} {
  const entries = new Map<string, FakeEntry>();
  const scripts: string[] = [];
  const live = (key: string): FakeEntry | undefined => {
    const entry = entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= time.now()) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  };
  return {
    entries,
    scripts,
    eval(script, _numKeys, ...keysAndArgs) {
      scripts.push(script);
      const key = String(keysAndArgs[0] ?? '');
      const windowMs = Number(keysAndArgs[1] ?? 0);
      const existing = live(key);
      const count = Number(existing?.value ?? '0') + 1;
      let expiresAt = existing?.expiresAt;
      let ttl: number;
      if (expiresAt === undefined || !Number.isFinite(expiresAt)) {
        // No TTL (fresh key, or a stray TTL-less one): PEXPIRE now.
        expiresAt = time.now() + windowMs;
        ttl = windowMs;
      } else {
        ttl = expiresAt - time.now();
      }
      entries.set(key, { value: String(count), expiresAt });
      return [count, ttl];
    },
    get(key) {
      const entry = live(key);
      return entry === undefined ? null : entry.value;
    },
    setex(key, seconds, value) {
      entries.set(key, { value, expiresAt: time.now() + seconds * 1000 });
      return 'OK';
    },
    del(key) {
      return entries.delete(key) ? 1 : 0;
    },
  };
}

function sessionOf(ctx: Ctx, key = 'session'): Session {
  return ctx.state[key] as Session;
}

/** The `name=value` pairs of a response's Set-Cookie lines, as a Cookie header. */
function cookieHeader(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((line) => line.split(';')[0] ?? '')
    .join('; ');
}

describe('createRedisRateLimitStore', function () {
  it('shares one counter across app instances and 429s past the limit', async function () {
    const time = clock();
    const redis = fakeRedis(time);
    const store = createRedisRateLimitStore(redis);
    const instance = () => {
      const app = createApp();
      use(app, rateLimit({ windowMs: 1000, limit: 2, now: time.now, store }));
      get(app, '/', () => new Response('ok'));
      return app;
    };
    const a = instance();
    const b = instance();

    (await request(a, '/')).status.should.equal(200);
    (await request(b, '/')).status.should.equal(200);
    const blocked = await request(b, '/');
    blocked.status.should.equal(429);
    (await blocked.json()).should.deep.equal({ error: 'Too Many Requests' });
  });

  it('derives Retry-After from the remaining window TTL', async function () {
    const time = clock();
    const app = createApp();
    use(
      app,
      rateLimit({
        windowMs: 3000,
        limit: 1,
        now: time.now,
        store: createRedisRateLimitStore(fakeRedis(time)),
      }),
    );
    get(app, '/', () => new Response('ok'));

    (await request(app, '/')).status.should.equal(200);
    time.advance(400);
    const blocked = await request(app, '/');
    blocked.status.should.equal(429);
    // 2600ms of window left → ceil to 3s.
    (blocked.headers.get('retry-after') ?? '').should.equal('3');
  });

  it('anchors the window at the first hit and frees after it expires', async function () {
    const time = clock();
    const app = createApp();
    use(
      app,
      rateLimit({
        windowMs: 2000,
        limit: 2,
        now: time.now,
        store: createRedisRateLimitStore(fakeRedis(time)),
      }),
    );
    get(app, '/', () => new Response('ok'));

    (await request(app, '/')).status.should.equal(200);
    time.advance(1500);
    // Second hit inside the anchored window keeps the original expiry.
    (await request(app, '/')).status.should.equal(200);
    const blocked = await request(app, '/');
    blocked.status.should.equal(429);
    (blocked.headers.get('retry-after') ?? '').should.equal('1');
    time.advance(600); // past the window anchored at t=0
    (await request(app, '/')).status.should.equal(200);
  });

  it('keeps a window per key', async function () {
    const time = clock();
    const app = createApp();
    use(
      app,
      rateLimit({
        windowMs: 1000,
        limit: 1,
        now: time.now,
        store: createRedisRateLimitStore(fakeRedis(time)),
      }),
    );
    get(app, '/', () => new Response('ok'));

    const alice = { headers: { 'x-forwarded-for': '203.0.113.9' } };
    const bob = { headers: { 'x-forwarded-for': '198.51.100.7' } };
    (await request(app, '/', alice)).status.should.equal(200);
    (await request(app, '/', bob)).status.should.equal(200);
    (await request(app, '/', alice)).status.should.equal(429);
    (await request(app, '/', bob)).status.should.equal(429);
  });

  it('runs one atomic EVAL per hit and re-arms TTL-less keys', async function () {
    const time = clock();
    const redis = fakeRedis(time);
    const store = createRedisRateLimitStore(redis, 'rl:');
    // A stray counter some other writer left without an expiry would
    // otherwise count forever — the script heals it with PEXPIRE.
    redis.entries.set('rl:unknown', { value: '5', expiresAt: Number.POSITIVE_INFINITY });
    const app = createApp();
    use(app, rateLimit({ windowMs: 1000, limit: 5, now: time.now, store }));
    get(app, '/', () => new Response('ok'));

    (await request(app, '/')).status.should.equal(429);
    redis.scripts.length.should.equal(1);
    (redis.scripts[0] ?? '').should.match(/INCR/);
    (redis.scripts[0] ?? '').should.match(/PTTL/);
    (redis.scripts[0] ?? '').should.match(/PEXPIRE/);
    Number.isFinite(redis.entries.get('rl:unknown')?.expiresAt).should.be.true;
  });
});

describe('createRedisSessionStore', function () {
  it('persists and restores sessions through the Redis shape', async function () {
    const time = clock();
    const redis = fakeRedis(time);
    const tool = createSession({
      secret: 'sekret',
      store: createRedisSessionStore(redis),
      now: time.now,
      cookie: { maxAge: 2 },
    });
    const app = createApp();
    use(app, tool.middleware);
    get(app, '/', (ctx) => {
      const session = sessionOf(ctx);
      if (session.isNew) session.set('user', 'alice');
      return Response.json({ user: session.get('user'), isNew: session.isNew });
    });

    const first = await request(app, '/');
    const firstBody = (await first.json()) as { user: string; isNew: boolean };
    firstBody.isNew.should.equal(true);
    firstBody.user.should.equal('alice');
    const handshake = cookieHeader(first);
    const sid = handshake.match(/s200\.sid=([^;]+)/)?.[1] ?? '';
    sid.should.not.equal('');

    // The record is JSON under the prefixed key, TTL-aligned with the cookie.
    const entry = redis.entries.get(`s200:sess:${sid}`);
    (entry === undefined).should.be.false;
    JSON.parse(entry?.value ?? '{}').should.deep.equal({ user: 'alice' });
    (entry?.expiresAt ?? 0).should.equal(time.now() + 2000);

    const second = await request(app, '/', { headers: { cookie: handshake } });
    const secondBody = (await second.json()) as { user: string; isNew: boolean };
    secondBody.isNew.should.equal(false);
    secondBody.user.should.equal('alice');
  });

  it('expires the record with its cookie ttl and mints a fresh session', async function () {
    const time = clock();
    const redis = fakeRedis(time);
    const tool = createSession({
      secret: 'sekret',
      store: createRedisSessionStore(redis),
      now: time.now,
      cookie: { maxAge: 1 },
    });
    const app = createApp();
    use(app, tool.middleware);
    get(app, '/', (ctx) => Response.json({ isNew: sessionOf(ctx).isNew }));

    const first = await request(app, '/');
    const handshake = cookieHeader(first);
    const sid = handshake.match(/s200\.sid=([^;]+)/)?.[1] ?? '';
    ((await first.json()) as { isNew: boolean }).isNew.should.equal(true);

    time.advance(1500);
    const second = await request(app, '/', { headers: { cookie: handshake } });
    const secondBody = (await second.json()) as { isNew: boolean };
    secondBody.isNew.should.equal(true);
    // The expired record was lazily evicted on read.
    (redis.entries.get(`s200:sess:${sid}`) === undefined).should.be.true;
  });

  it('destroy() deletes the record and expires the cookie', async function () {
    const time = clock();
    const redis = fakeRedis(time);
    const tool = createSession({
      secret: 'sekret',
      store: createRedisSessionStore(redis),
      now: time.now,
    });
    const app = createApp();
    use(app, tool.middleware);
    const handler = async (ctx: Ctx) => {
      const session = sessionOf(ctx);
      if (ctx.url.pathname === '/out') {
        await session.destroy();
        return new Response('gone');
      }
      if (session.isNew) session.set('user', 'bob');
      return Response.json({ user: session.get('user') });
    };
    get(app, '/', handler);
    get(app, '/out', handler);

    const first = await request(app, '/');
    const handshake = cookieHeader(first);
    const sid = handshake.match(/s200\.sid=([^;]+)/)?.[1] ?? '';
    (redis.entries.get(`s200:sess:${sid}`) === undefined).should.be.false;

    const out = await request(app, '/out', { headers: { cookie: handshake } });
    out.status.should.equal(200);
    (redis.entries.get(`s200:sess:${sid}`) === undefined).should.be.true;
    out.headers
      .getSetCookie()
      .some((line) => /max-age=0/i.test(line))
      .should.be.true;
  });

  it('treats a corrupt record as no session and mints a fresh one', async function () {
    const time = clock();
    const redis = fakeRedis(time);
    const tool = createSession({
      secret: 'sekret',
      store: createRedisSessionStore(redis),
      now: time.now,
    });
    const app = createApp();
    use(app, tool.middleware);
    get(app, '/', (ctx) => {
      const session = sessionOf(ctx);
      if (session.isNew) session.set('user', 'carol');
      return Response.json({ user: session.get('user'), isNew: session.isNew });
    });

    const first = await request(app, '/');
    const handshake = cookieHeader(first);
    const sid = handshake.match(/s200\.sid=([^;]+)/)?.[1] ?? '';
    redis.entries.set(`s200:sess:${sid}`, {
      value: '{oops',
      expiresAt: time.now() + 60_000,
    });

    const second = await request(app, '/', { headers: { cookie: handshake } });
    const secondBody = (await second.json()) as { user: string; isNew: boolean };
    secondBody.isNew.should.equal(true);
    secondBody.user.should.equal('carol');
  });
});
