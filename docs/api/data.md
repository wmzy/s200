# Data & Config (`s200/cache`, `s200/config`, `s200/events`, `s200/schedule`)

Response caching, typed fail-fast configuration, a typed event bus, and a cron/interval scheduler.

## Cache (`s200/cache`)

Response cache with TTL + LRU-ish eviction and a bounded body size. Read-through: on a miss the chain below runs and a cacheable response is stored; on a hit the handler never runs.

```ts
use(app, cache({ ttl: 60, max: 1000 }));
use(app, cache({ store: redisCacheStore }));   // shared store across instances
```

Safe by default: only `GET` responses with status 200 and a body are stored; responses carrying `Set-Cookie` are never cached (a cached session cookie is a session leak), requests carrying `Authorization` are never served, and request `Cache-Control: no-cache` forces a revalidation pass. The body is cloned before storing, so the response delivered to the storing request is untouched.

`CacheOptions`:

| Field | Default | Meaning |
| --- | --- | --- |
| `ttl` | `60` | Entry lifetime in seconds |
| `max` | `1000` | Maximum entries, oldest evicted beyond it (the in-memory store's concern only) |
| `sizeLimit` | 1 MiB | Maximum cached body size in bytes |
| `methods` | `['GET']` | Methods served from the cache |
| `key` | `` `${method} ${pathname}${search}` `` | Custom cache key `(ctx) => string` |
| `skip` | — | Extra skip predicate (runs before every lookup and store) |
| `store` | bounded in-memory Map, refresh-on-hit | `CacheStore` (below) — shared cache across instances |

`CacheStore`: `get(key)`, `set(key, entry)`, `delete(key)` — `get`/`delete` may be async (a networked store is); `set` stores the whole entry atomically. `CacheEntry`: `{ exp, status, headers: [string, string][], body: Uint8Array }`. Expiry is checked by the middleware on every read; the store may also evict early.

## Config (`s200/config`)

Typed, fail-fast configuration over the same Standard Schema channel `s200/validate` uses. `parseEnv` is a pure `.env` parser; `createConfig` validates the merged record **at construction** — failure throws one `Error` aggregating every issue, so a bad deploy dies at boot with the full list, not the first.

```ts
import { parseEnv, createConfig } from 's200/config';
const { valid } = createConfig(schema, { ...parseEnv(await readFile('.env', 'utf8')), ...process.env });
// valid: schema.types.output — fully typed from here on
```

| Function | Meaning |
| --- | --- |
| `parseEnv(text)` | Pure `.env` parser → `Record<string, string>`: comments, blank lines, `export ` prefix, quoted values with escapes, duplicate keys last-wins; no multi-line values |
| `createConfig<S>(schema, input)` | Validates once; returns `{ valid: OutputOf<S> }` |

`Config<S>`: `{ readonly valid: OutputOf<S> }` — the only handle callers get, and only after the fail-fast gate passed.

Env values arrive as strings — declare the schema's input side as strings and coerce in the output (input ≠ output inference, same as `jsonBody`). I/O stays injected: `parseEnv` takes text, you read the file (the core never touches a filesystem).

## Events (`s200/events`)

Typed event bus — a thin, per-key-typed facade over `@for-fun/event-emitter` (the battery's single dependency). The API is a bundle of bound functions, no class.

```ts
import { createBus } from 's200/events';
type M = { 'user:created': [userId: string]; 'order:shipped': [orderId: string, tracking: string] };
const bus = createBus<M>();
const off = bus.on('user:created', (userId) => …);
bus.emit('user:created', 'u-1');
await bus.emitAsync('order:shipped', 'o-1', '1Z999');
```

`Bus<M>`:

| Member | Meaning |
| --- | --- |
| `on(key, handler)` / `once(key, handler)` | Subscribe (once removes itself before it runs); return the unsubscribe function |
| `off(key?)` / `off(key, handler)` | Drop all listeners, one key's, or one subscription |
| `emit(key, …args)` | Synchronous fan-out in registration order |
| `emitAsync(key, …args)` | Invokes the snapshot of listeners, resolves once every one has settled (allSettled semantics) |
| `onError(handler)` | Subscribe to the shared error channel both emit flavors route through |
| `setMaxListeners(n)` | Raises/lowers the per-key leak-warning ceiling; `0` silences it. Purely diagnostic |

Error contract (shared by `emit`/`emitAsync`): synchronous error **collection**, not fail-fast — a throwing listener never stops its peers; afterwards every collected error goes through `onError` in listener order, or — with no subscriber — the first collected error is rethrown to the emit caller (or rejects the `emitAsync` promise).

`BusOptions`: `{ maxListeners?: number }`. `EventsMap`: `Record<string, unknown[]>` — event name → listener argument tuple.

## Schedule (`s200/schedule`)

A zero-dependency take on `@nestjs/schedule`: cron expressions and fixed intervals on plain data and functions.

`nextRun(expr, from)` is a pure 5-field cron matcher (minute hour day-of-month month day-of-week) interpreted in **UTC**. Supported field syntax: `*`, `a`, `a-b`, steps (`*` or `a-b` with `/n`), comma-joined mixes (`5,10-20/3,45`). No day names, no `L`/`W`/`#` extensions. Day-of-week runs 0–7 with 0 and 7 both Sunday; when both day-of-month and day-of-week are restricted, a date matches when **either** does (the Vixie cron rule).

`createScheduler` runs jobs on a `setTimeout` chain re-armed from each job's next absolute occurrence, so ticks never accumulate drift — delays past the ~24.8-day timer ceiling are re-armed in chunks. Jobs are concurrency-1: a tick landing while the previous run is still going is skipped, not queued, and the next tick lands on the next grid point after the run settles. A throwing or rejecting job routes to `onError` without ever breaking the loop.

```ts
const scheduler = createScheduler({ onError: (err, expr) => console.error(expr, err) });
scheduler.cron('*/5 * * * *', () => cleanup());
scheduler.interval(60_000, () => heartbeat());
scheduler.start();
await scheduler.stop();   // cancels all timers, waits for the in-flight run
```

`createScheduler(options?)` → `Scheduler`:

| Member | Meaning |
| --- | --- |
| `scheduler.cron(expr, fn)` | Registers a cron job (validated eagerly — unsatisfiable expressions like `0 0 31 2 *` throw here); registering on a running scheduler arms immediately |
| `scheduler.interval(ms, fn)` | Fixed-interval job; the first run lands `ms` after arming, later runs stay on that absolute grid |
| `scheduler.start()` | Arms every registered job; throws if already started or after a `stop` (schedulers are single-use) |
| `scheduler.stop()` | Cancels all timers, resolves once the in-flight run finished; no-op on a never-started scheduler, idempotent |

`SchedulerOptions`: `{ now? (default `Date.now`), onError? (default `console.error`) }` — `onError` receives every thrown/rejected value plus the job's label (the cron expression, or `interval:<ms>`). `JobFn`: `() => void | Promise<void>`.
