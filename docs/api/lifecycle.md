# Lifecycle, Health, Timeout & Hot Reload (`s200/lifecycle`, `s200/health`, `s200/timeout`, `s200/dev`)

Graceful shutdown, liveness/readiness probes, request timeouts, live route-table swapping, and dev-mode 404 hints.

## Lifecycle (`s200/lifecycle`)

NestJS' `enableShutdownHooks` + `onApplicationShutdown` equivalent: one graceful drain shared by `stop()` and the OS signals. The order is the load-balancer-safe one: flip the readiness gate **first** (probes go 503, traffic stops arriving), then stop accepting new connections, wait out in-flight requests within the budget, hard-kill the stragglers, and only then run the app's own `onShutdown`.

```ts
import { lifecycle } from 's200/lifecycle';
import { createGate } from 's200/health';

const gate = createGate();
const handle = lifecycle(server, { readiness: gate, onShutdown: () => pool.end() });
await handle.stop();        // or: SIGTERM / SIGINT
```

`lifecycle(server, options?)` → `LifecycleHandle`:

| Member | Meaning |
| --- | --- |
| `stop()` | Begins (or joins) the drain — the same path a signal takes, idempotent |
| `stopped` | Resolves once the drain has settled — never rejects: a signal-path `onShutdown` failure is `console.error`'d instead |

`LifecycleServer`: `{ close(): Promise<void>; server?: unknown }` — every adapter `serve()` result satisfies it structurally; the raw `server` (when the adapter exposes it) unlocks the graceful paths. Runtime-agnostic by duck typing: a raw server with `closeIdleConnections` (node http/https/http2) gets `close()` plus CONTINUOUS idle reaping — a one-shot reap misses keep-alive sockets that go idle mid-drain — then `closeAllConnections()` on deadline; a raw server with `stop` (Bun) gets `stop(false)` graceful / `stop()` forced; anything else falls back to the adapter's own `close()`.

`LifecycleOptions`:

| Field | Default | Meaning |
| --- | --- | --- |
| `signals` | `['SIGTERM', 'SIGINT']` | Signals that trigger the same drain as `stop()`; `[]` keeps signal handling to yourself. A second signal **during** a drain hard-kills immediately |
| `timeout` | `10_000` | Drain budget in ms — in-flight requests get this long before their connections are force-closed |
| `readiness` | — | Flipped closed with `'draining'` as the FIRST step — pass a `createGate()` from `s200/health` (structural: anything with `close(reason?)` works) |
| `onShutdown` | — | Runs after connections drained (or the budget expired) — the `onApplicationShutdown` hook |

Signal listeners are removed once the drain settles — no leaks, no second lifecycle fighting over the same process.

## Health (`s200/health`)

The NestJS Terminus equivalent: `health` is the liveness probe (a process that answers at all is alive), `readiness` runs a named check set concurrently under one per-check budget, and `createGate` is the resettable switch `s200/lifecycle` flips first in a graceful drain — probes answer 503 the instant draining starts, before any socket closes.

```ts
import { health, readiness, createGate } from 's200/health';
get(app, '/healthz', health);
get(app, '/ready', readiness({ db: () => pool.query('select 1') }));
```

| Function | Meaning |
| --- | --- |
| `health()` | Liveness handler: `200 {"status":"ok"}` with zero dependencies |
| `readiness(checks, options?)` | Runs every named check concurrently under one per-check budget; `200 {"status":"ok","checks":{…}}` or `503 {"status":"fail",…}` |
| `createGate()` | A resettable drain switch: wire `gate.check` into a readiness probe and `gate` itself into `lifecycle` |

`HealthCheck`: `() => void | Promise<void>` — returns/resolves when healthy, throws/rejects with the reason when not. `ReadinessOptions`: `{ timeout?: number }` — per-check budget in ms (default 1000); each check is also raced against the request's abort signal, so a hung dependency cannot pin the handler. Failure reasons are truncated to 200 chars.

Response bodies: `HealthBody` = `{ status: 'ok' }` (liveness); `ReadinessBody` = `{ status: 'ok' | 'fail'; checks: Record<string, string> }` — each check's verdict is `'ok'`, or its failure reason (timeout, abort, or the thrown message, truncated to 200 chars).

`Gate`: `{ check(): void; close(reason?): void; open(): void }` — `check` throws the close reason while tripped (the probe reports it); `close` trips the gate; `open` resets it.

## Timeout (`s200/timeout`)

Races the rest of the chain against a deadline. When the deadline wins, the chain below rejects with a `503` `HttpError` — the app's error path renders it, and unwind middlewares (logger, cors) observe the real status.

```ts
use(app, timeout(5_000));
```

The deadline also aborts a per-request `AbortController` composed into `ctx.signal` for everything below, so cooperative work — body reads (`readJson` & co cancel their stream and reject with an `AbortError`), fetches racing `ctx.signal` — stops instead of buffering a corpse. Work that never observes `ctx.signal` keeps running detached (like hono's timeout); this only bounds the response time and signals the loss. `timeout(ms)` throws on a non-positive/non-finite `ms`.

## Hot reload (`s200/dev`)

Swap an app's route table live without restarting the server. This works because an `App` is a mutable data object — `serve` holds one object identity forever, while `handle` re-reads its fields on every request and the composed-chain caches version on array identity (frozen snapshots). Replacing the fields atomically switches every **new** request to the fresh table; requests already in flight keep running their captured chain to completion. Node-only entry (`node:fs` / `node:url`).

```ts
import { createHotApp, importFresh, watchAndReload } from 's200/dev';

const hot = createHotApp(app);
const server = await serve(hot.app, { port: 3000 });
const handle = watchAndReload({
  dirs: ['./src/routes'],
  load: async () => (await importFresh('./src/routes/app.ts')).app,
  hot,
});
await handle.close();
```

| Function | Meaning |
| --- | --- |
| `createHotApp(initial)` | `{ app, reload(next) }` — a stable identity whose table `reload` swaps atomically (routes, middlewares, matcher, error/404/logError policies); a reload passing identical references is a no-op |
| `importFresh(specifier)` | Imports a module bypassing the ESM cache (stamps a `?t=` query onto its file URL) — the loader half of hot reload |
| `watchAndReload(options)` | Watches `dirs` and reloads the hot app through `load` after a debounce window; only source files (`.ts`/`.mts`/`.cts`/`.js`/`.mjs`/`.cjs`/`.json`) outside `node_modules` and dot-directories trigger reloads, so an app writing logs or data files into its watched directory cannot feed reload events back into itself; a failing `load` keeps the previous table and reports through `onError`; loads are serialized |

`WatchAndReloadOptions`: `{ dirs: readonly string[]; load: () => Promise<App<S>>; hot: HotApp<S>; debounceMs? (default 50); onError? (default `console.error`) }`. `WatchAndReloadHandle`: `{ close(): Promise<void> }`.

### Dev-mode 404 route hints

`routeHints(app, options?)` returns a middleware that decorates the framework-default 404 body with what the route table knows — a miss tells the developer what exists. It takes the app as data (middlewares only receive `(ctx, next)`; `createRouteTable` and `createClient` are the precedent for app-consuming batteries), closes over the live app object, and reads `app.routes` per request — so hot-reload swaps are picked up without re-registration. The options type is `{ limit?: number }`: the maximum number of all-methods `routes` entries, default 3.

```ts
import { routeHints } from 's200/dev';

use(app, routeHints(app));
```

**Never-clobber rule**: only a 404 whose body parses to exactly `{"error":"Not Found"}` — the `createApp` fallback's default — is decorated. A custom `onNotFound`, a thrown or returned `httpError(404)` (whose envelope reads `{"error":"HTTP 404 Not Found"}`), or a body another middleware already rewrote passes through untouched. The decoration keeps the 404 status and the response's existing headers, and adds at most one field (`hint` or `routes`, never both) to the default shape `{ error: 'Not Found', hint?: string, routes?: string[] }`.

Ranking is boring and deterministic: routes by positional static-segment overlap with the request pathname (a literal segment counts only at the same index; params and wildcards never score), ties broken by registration order. Method compatibility mirrors the router — exact match, `'ALL'` routes, and `GET` routes for `HEAD` requests count as same-method.

| Outcome | Body |
| --- | --- |
| A same-method route's overlap is at least half the request's segments | `{ "error": "Not Found", "hint": "did you mean GET /users/:id?" }` |
| No same-method route overlaps at all, but some route does | `{ "error": "Not Found", "routes": ["POST /users/:id", "POST /users/:uid"] }` — top `limit` across ALL methods, same ranking |
| Neither (weak same-method candidates only, or nothing overlaps) | untouched |

Dev battery, not hot path: every default-404 body is cloned and parsed, and every miss scans the route table — cheap in development, pointless overhead in production.

### The dev runner & CLI

`s200 dev` (the `s200` bin) wires the hot-reload core into a runner: one server identity for the whole session, and the first load prints the route table — a count line plus the aligned `METHOD  PATTERN` lines (`createRouteTable` + `formatRouteTable`, registration order). Every reload keeps the one-line `reloaded (N routes)` count.

```sh
s200 dev ./app.ts --port 3000 --overlay
```

Route hints are on by default (`--no-hints` disables them): the runner wraps every loaded table in a derived copy carrying the `routeHints` middleware — the user's app object is never mutated, and a reload stays a pure table swap. The error overlay (`--overlay`, off by default) adds two more things through the same derived-copy seam:

- a middleware that injects an inline, zero-dependency `<script>` right before the closing `</body>` of **byte-backed** `text/html` responses — those carrying a `content-length`, the `json`/`text`/`html`/`send` contract. Streamed HTML (`stream()`/`streamSSE()`, no `content-length`) passes through untouched — documented behavior: buffering it to inject would defeat the streaming. The rebuilt response keeps status and headers with an honest new `content-length`; `HEAD` requests skip injection.
- the internal SSE route `/__s200/dev-events` (built on `streamSSE`), which exists only while the overlay is enabled and frames `reload` and `error {message, stack}` events. The injected script reloads the page on `reload` and shows a fixed-position, dismissible error box on `error`; a failed load keeps the previous table (as always) and surfaces in the overlay. The route is appended after the user's routes — first registration wins, so a user route on the same path takes precedence.

The runner-facing `s200/dev` exports:

| Export | Meaning |
| --- | --- |
| `createDevEventBus()` | `{ publish(event), subscribe(listener) }` — the synchronous fan-out the runner publishes reload/load-error events to; `subscribe` returns the unsubscribe function |
| `withRouteHints(userApp, live)` | Derived copy of `userApp` with `routeHints(live)` prepended to the middleware chain — the user's app data is never touched, and the middleware re-reads `live.routes` per request |
| `withDevOverlay(userApp, bus)` | Derived copy with the script-injection middleware prepended and the `/__s200/dev-events` route appended |
| `DEV_EVENTS_PATH` | `'/__s200/dev-events'` — where the overlay's events are served |

`DevEvent`: `{ type: 'reload' } | { type: 'error'; message: string; stack?: string }`. `DevEventBus`: `{ publish(event: DevEvent): void; subscribe(listener: (event: DevEvent) => void): () => void }`.

Beyond `dev`, two one-shot subcommands load their entry with the same loader (default export or named `app`, default `./app.ts`) and the same TypeScript floor:

```sh
s200 routes ./app.ts --json
s200 codegen ./app.ts --name makeApi --base-url https://api.test --out src/client.ts
```

`s200 routes [entry] [--json]` prints the aligned table (registration order; `(no routes)` when empty), or with `--json` the full serializable `createRouteTable` data — params and middleware counts included. `s200 codegen [entry] [--out file] [--name X] [--base-url U]` writes the `generateClient` module to stdout, or to `--out` (with a trailing newline). An unknown command exits non-zero with the usage text listing every command.
