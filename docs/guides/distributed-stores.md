# Distributed Stores

s200's `rateLimit` and `createSession` batteries ship with in-process defaults: a per-key timestamp deque, a map with lazy expiry. Those defaults are per-*process* — run three instances behind a load balancer and each enforces its own limit, remembers its own sessions, and a client that hops instances starts from zero every hop. The fix is not more code in the framework; it is the seam both batteries already have: inject a store the whole fleet shares.

This guide wires that seam to Redis with the official recipes in [`recipes/redis-stores.ts`](https://github.com/wmzy/s200/blob/main/recipes/redis-stores.ts) — repository-level TypeScript, deliberately **not** a package export (s200 is zero-dependency by contract). Vendor the one file into your project, bring your own Redis client, and inject.

```ts
import { Redis } from 'ioredis';
import { createRedisRateLimitStore, createRedisSessionStore } from './redis-stores'; // vendored

const redis = new Redis(process.env.REDIS_URL!);
const rl = createRedisRateLimitStore(redis);
const sessions = createRedisSessionStore(redis, 'myapp:sess:');
```

## The two seams

Both contracts are small enough to read in one breath:

```ts
// rateLimit: one method, and it must be atomic per key
type RateLimitStore = {
  hit(key: string, now: number, limit: number, windowMs: number):
    RateLimitHit | Promise<RateLimitHit>; // { count, retryAt }
};

// createSession: three methods; set receives the cookie's TTL
type SessionStore = {
  get(id: string): SessionData | undefined | Promise<SessionData | undefined>;
  set(id: string, data: SessionData, ttlSeconds: number): void | Promise<void>;
  delete(id: string): void | Promise<void>;
};
```

Anything that fulfills these over shared state works — Redis here, a SQL table, a KV namespace. The store decides where state lives; the battery keeps its behavior (429 + `Retry-After` in place, cookie handshake, expiry-on-read) untouched.

## `RedisLike`: bring your own client

The recipes don't import a Redis library; they declare the four commands they need as a structural type:

```ts
type RedisLike = {
  eval(script: string, numKeys: number, ...keysAndArgs: Array<string | number>):
    unknown[] | Promise<unknown[]>;
  get(key: string): string | null | Promise<string | null>;
  setex(key: string, seconds: number, value: string): unknown | Promise<unknown>;
  del(key: string): unknown | Promise<unknown>;
};
```

**ioredis** satisfies it as-is — pass the client directly.

**node-redis** (v4+) differs on two spellings: `eval` takes an options object (`{ keys, arguments }`) rather than the positional form, and SETEX is camel-cased. Four lines reconcile it:

```ts
import { createClient } from 'redis';

const client = createClient({ url: process.env.REDIS_URL });
await client.connect();

const redis = {
  eval: (script: string, numKeys: number, ...rest: Array<string | number>) =>
    client.eval(script, {
      keys: rest.slice(0, numKeys).map(String),
      arguments: rest.slice(numKeys).map(String),
    }) as Promise<unknown[]>,
  get: (key: string) => client.get(key),
  setex: (key: string, seconds: number, value: string) =>
    client.setEx(key, seconds, value),
  del: (key: string) => client.del(key),
};
```

## Rate limiting: one EVAL, atomic by construction

```ts
import { createApp, get, use } from 's200';
import { rateLimit } from 's200/rate-limit';
import { createRedisRateLimitStore } from './redis-stores'; // vendored

const store = createRedisRateLimitStore(redis); // keys under 's200:rl:'
const app = createApp();
use(app, rateLimit({ windowMs: 60_000, limit: 100, store }));
get(app, '/', (ctx) => new Response('ok'));
```

The store's entire accounting is one Lua script, executed as one `EVAL`:

```lua
local count = redis.call("INCR", KEYS[1])
local ttl = redis.call("PTTL", KEYS[1])
if ttl < 0 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { count, ttl }
```

**Why one script and not two commands.** The naive port — `INCR key`, then `EXPIRE key windowMs` if the reply was `1` — has the classic race: two instances increment concurrently, both can see intermediate values (or miss the `1` entirely, leaving the TTL unarmed), and a process dying between the two commands leaves an immortal counter that blocks a key forever. Redis executes each script serially, so the increment, the TTL check, and the (conditional) `PEXPIRE` land as a single unit — every instance of every process observes the same `count`, and the window is armed exactly once, by whoever's increment created the key. The `ttl < 0` branch also self-heals: a stray TTL-less key written by some other tool gets armed rather than counting forever. `rateLimit` turns the reported `PTTL` into `retryAt`, which the battery renders as `Retry-After` — blocked callers are told the true remainder of the window, not a guess.

**Window semantics — know what you deploy.** The in-process default is a *true* sliding window: each hit expires exactly `windowMs` after it landed, so the limit is burst-proof at window edges. The Redis recipe is a *fixed window anchored at the first hit*: the counter expires wholesale. Two consequences:

- at a window edge, a client can place up to `limit` requests just before expiry and another `limit` just after — the fixed-window burst;
- the limit holds *exactly* across the fleet — which is the property multi-instance deployment actually needs and the in-memory default cannot offer.

If edge bursting matters at your limits, shrink `windowMs` proportionally (a 30s window at half the limit approximates a 60s sliding budget), or graduate the script to a sorted-set window (`ZREMRANGEBYSCORE` + `ZADD` + `ZCARD` + `PEXPIRE`, still one EVAL) — the store contract takes any implementation that reports an honest `{ count, retryAt }`.

**Keys and prefixes.** The key is whatever the battery's `key` option produces (first `x-forwarded-for` hop by default — meaningful only behind a proxy that overwrites it), prefixed `s200:rl:`. Several apps sharing one Redis should pass distinct prefixes: `createRedisRateLimitStore(redis, 'api-a:rl:')`.

## Sessions: records that die with their cookies

```ts
import { createSession } from 's200/session';
import { createRedisSessionStore } from './redis-stores'; // vendored

const { middleware } = createSession({
  secret: process.env.SESSION_SECRET!,
  store: createRedisSessionStore(redis), // keys under 's200:sess:'
});
```

The mapping is three commands:

- `set(id, data, ttlSeconds)` → `SETEX s200:sess:<id> <ttlSeconds> <json>` — the TTL the battery passes *is* the cookie's `maxAge`, so the record in Redis and the cookie in the browser die together. No id outlives its credential; no sweep job required.
- `get(id)` → `GET s200:sess:<id>`, `JSON.parse` — Redis has already evicted expired records, and a record that fails to parse counts as no session: the middleware mints a fresh one instead of failing the request.
- `delete(id)` → `DEL s200:sess:<id>` — what `session.destroy()` triggers.

**Sliding expiry.** `session.touch()` renews on the unwind: the middleware re-runs `set` with the same `maxAge`, and the fresh `SETEX` slides the record's (and cookie's) death forward — idle sessions expire, active ones live as long as they stay active. Mutations (`set`/`delete`/`clear`) persist the same way; a request that only reads leaves no write and no `Set-Cookie`, so Redis is not hammered by traffic that never touches its session.

**Instance freedom.** Because the record — not the instance — is the source of truth, any instance can serve any request: sessions survive deploys, restarts, and load-balancer whims, and the signed-cookie handshake (`s200.sid` + `s200.sid.sig`) travels the client where the data cannot.

## KV variants (Upstash and friends)

The recipe's shape ports to any Redis-compatible edge:

- **Upstash Redis** speaks EVAL over its REST API, and `@upstash/redis` derives `numkeys` from separate key/arg arrays — adapt the one `eval` line: `(script, keys, args) => upstash.eval(script, keys, args)`. Its `Script` helper caches by SHA for fewer bytes over the wire, and the official `@upstash/ratelimit` package ships fixed-window, sliding-window, and token-bucket Lua if you want its client instead of the battery — the seams are interchangeable.
- **KV without Lua** (plain KV namespaces): you cannot have one atomic INCR-with-TTL. Either accept a tiny race (INCR, then set expiry only when the reply was `1` — a failed write between the two leaves an immortal counter a periodic cleanup must reap), or approximate with per-window keys (`rl:<key>:<floor(now/windowMs)>`) whose TTL *is* the atomicity — each window's counter dies on schedule no matter what. For sessions, KV `put` with `expirationTtl` maps to `set` one-to-one; `expirationTtl` has a 60-second floor, so sub-minute cookie TTLs need the record's expiry checked on read.

The general rule the recipes encode: keep the atomic decision in as few round trips as the backend allows, let TTLs do the cleanup, and align every expiry with the credential that fronts it.
