# Sharding & Scheduling

One s200 app is one event loop: routes and middlewares share a single-threaded runtime, exactly the model every isolate-based platform (Cloudflare Workers, Vercel Fluid instances) runs *inside* each unit. This guide is about the layer above that: turning one route table into independently schedulable **units** — separate processes, pods, or lazily spawned threads — without writing a second route definition or baking a scheduler into the framework.

The design stance, borrowed from how the platforms actually work:

- **The isolation axis is policy, not routes.** A 500-route app with uniform scaling/timeout/limits policy is one unit (replicated). Only outlier route groups — heavy compute, different timeouts, different trust — earn their own. Never shard 1:1 by route.
- **The router lives outside the units.** Whoever dispatches must read the URL; a unit that has read the request is past every cheap hand-off point. So dispatch happens at a gateway (nginx, Gateway API, ALB) or a dev dispatcher — never *inside* a shard.
- **The library provides the data plane; the scheduler stays yours.** s200 exports the unit descriptor, the dispatch seam, the executors and the metrics surface. Placement decisions belong to k8s, your supervisor config, or the platform you build later.

## The five pieces

| Module | Role |
|---|---|
| `s200/shard` | Route policy annotations + `ShardSpec` (the serializable unit descriptor) + `shardApp` partition + the `matchShard` dispatch seam |
| `s200/gateway` | Pure generators: the same specs → nginx.conf / Gateway API HTTPRoute / ALB listener rules |
| `s200/shard-dev` | In-process dispatcher with the same prefix semantics — local parity without nginx |
| `s200/executor` | Executors (`inline` / `thread` / `process` / `external`) + supervisor: lazy thread spawn with Node ≥26.6 listener transfer, forked process shims, restart with backoff |
| `s200/unit-metrics` | The scheduler's eyes: in-flight, queue depth, event-loop utilization, RSS, warm/cold — as middleware + endpoint |

One route table feeds all five. Declare once, deploy any shape.

## 1. Annotate policy, partition the app

```ts
import { createApp, get } from 's200';
import { policy, shardSpecs, shardApp, type ShardGroup } from 's200/shard';

const app = createApp();
get(app, '/catalog/*', catalogHandler);
get(app, '/reports/*', reportHandler);        // heavy: its own unit
get(app, '/health', healthHandler);

// Route-level policy — stored off-app (WeakMap), tree-shakable like s200/meta
policy(app, 'GET', '/reports/*', { timeoutMs: 300_000, memoryMb: 512, streaming: true });

const groups: readonly ShardGroup[] = [
  { id: 'reports', prefix: '/reports', entry: './reports-shard.ts' },
  { id: 'main', prefix: '/' },                // '/' is the catch-all
];

const specs = shardSpecs(app, groups);        // serializable, JSON-ready
```

`ShardSpec` is pure data: id, prefix, the route-table entries (method/pattern/params), the merged policy (group base + first-seen route overrides; `maxConcurrency` widens), and the optional `entry` module for thread/process execution. `shardSpecs` throws on orphan routes — a route that matches no group (and is claimed by no `policy(..., { shard })`) is listed by name, never silently dropped.

`shardApp(app, group)` is the inverse of `mount`: the group's routes with **absolute patterns unchanged**, all app-level middlewares carried (`use(app, prefix, ...)` guards self-scope by path, so they compose correctly), `match`/`onError`/`onNotFound` inherited. `mount(parent, '', shardApp(app, group))` round-trips to the original behavior.

## 2. Generate the gateway, not a second router

```ts
import { nginxConf, gatewayRoutes, albRules } from 's200/gateway';

nginxConf(specs);                    // upstream keepalive trio + location ^~ blocks
gatewayRoutes(specs, { hostname: 'api.example.com' });  // Gateway API HTTPRoute YAML
albRules(specs, { listenerArn, targetGroupArns: { reports: arn1, main: arn2 } });
```

The nginx view bakes in the three things every hand-rolled config gets wrong: upstream `keepalive`, `proxy_http_version 1.1`, and the `Connection ""` header clear (without them, every request pays a fresh TCP handshake to the shard). Policy maps to directives — `timeoutMs` → `proxy_read_timeout`, `streaming` → `proxy_buffering off` — and to Gateway/ALB equivalents. Same input, byte-identical output: diff your configs in CI.

Prefix granularity is the honest limit: gateways dispatch on path prefix, never method — `GET /users` and `POST /users` live in the same shard, by construction, in every view including the dev dispatcher below.

## 3. Develop against the same seam

```ts
import { createDispatcher } from 's200/shard-dev';

const dispatch = createDispatcher(
  groups.map((group) => ({ spec: shardSpecs(app, [group])[0]!, app: shardApp(app, group) })),
  fallbackApp,                                  // optional: unmatched prefixes
);
const res = await dispatch(new Request('http://local/reports/q4'));  // → handle(shardApp)
```

`createDispatcher` routes by the same `matchShard` longest-prefix seam the generated configs encode — dev behavior and production dispatch agree by construction, not by discipline. A miss goes to the fallback app (or a plain 404). This is also the `inline` executor's shape: all shards in one process, zero infrastructure.

## 4. Execute: threads for density, processes for isolation

```ts
import { runShards } from 's200/executor';

const supervisor = runShards([
  { spec: specs[0]!, executor: { kind: 'thread', entry: './reports-shard.ts' }, port: 31001 },
  { spec: specs[1]!, executor: { kind: 'external', address: '10.0.0.4:8080' } },
]);
await supervisor.start();                      // returns only when every unit can serve
await supervisor.stop();                       // drain within grace, then terminate
supervisor.units();                            // state/port/restarts/lastError per unit
```

- **`thread`** — one worker isolate per shard, spawned **lazily**: the supervisor pre-binds the port (idle listeners cost nothing), parks early connections, and on first traffic spawns the worker, then transfers the listening server *and* the parked sockets to it (Node ≥ 26.6, Unix; verified mechanics — a transferred listener keeps `pauseOnConnect`, so the worker resumes every socket). Route code loads inside the thread on first request (`await import(entry)`). Where transfer is unavailable (older node — worker-thread handle transfer is a Node ≥ 26 capability) the supervisor instead pipes accepted sockets byte-for-byte to the worker's private port: same lazy spawn, same first request served, the supervisor still never parses HTTP. `memoryMb` maps to worker `resourceLimits`.
- **`process`** — forks the shim built into the module (sentinel env `S200_ENTRY`/`S200_PORT`, `SIGTERM` drain). Real crash isolation, independent cgroup-ability; the shape your orchestrator sees when it schedules the shard as its own pod.
- **`inline`** — nothing to run; pair with `createDispatcher`.
- **`external`** — an address, not a lifecycle: the unit already runs elsewhere (another machine, another fleet); `units()` reports it for completeness.

Unexpected exits restart with exponential backoff (100ms doubling, capped 5s); `stop()` drains within 3s grace then force-kills. Threads share the process — a native segfault kills the whole supervisor; processes are the honest isolation boundary (see the platform comparisons in this guide's rationale: JS-level crash isolation ≠ native crash isolation).

## 5. Report what a scheduler needs

```ts
import { createUnitMetrics, unitMetricsEndpoint } from 's200/unit-metrics';

const metrics = createUnitMetrics({ maxConcurrency: 32, warmAfter: 1 });
use(app, metrics.middleware);
get(app, '/unit-metrics', unitMetricsEndpoint(metrics));
// { inFlight, queueDepth, requests, maxInFlight, eventLoopUtilization, rss, heapUsed, warm, startedAt }
```

`inFlight`/`queueDepth` (over-cap), event-loop utilization (snapshot-delta, no background timers), RSS/heap, and the warm/cold flag — the inputs scale-to-zero and least-loaded decisions consume. The same numbers work under k8s (wire the endpoint into probes) and under a control plane you build on top: the library's contract ends at honest self-reporting; placement stays outside.

## What this is not

There is no global resolver, warm pool, or cross-machine steering here — those are platform assets, and the deliberate boundary is that `s200` remains the data plane. Fleet-level sharding (multi-machine) is the same specs + Gateway/ALB views + your orchestrator; in-machine density for many units (hundreds of tenants) is the `thread` executor. The library refuses to grow a scheduler so one can be built *on* it.
