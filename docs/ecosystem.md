# Ecosystem

Batteries are s200's unit of middleware reuse: an opt-in module behind its
own package entry, options in, `Middleware` out (see
[Authoring Batteries](https://github.com/wmzy/s200/blob/main/docs/guides/battery-authoring.md) for the full contract). This
page is the registry — what ships in the box, and how a third-party battery
joins the list.

## Official

Everything below ships in the `s200` package itself: one source file per
entry, imported as `import { … } from
's200/<entry>'` — pulling one entry never pulls another. All entries are
zero-runtime-dependency except `s200/events`, which builds on
[`@for-fun/event-emitter`](https://www.npmjs.com/package/@for-fun/event-emitter)
(its only dependency — the core stays dependency-free). Entry sizes
are tracked per release by the repo's
[`size-limit`](https://github.com/wmzy/s200/blob/main/package.json)
budgets (`pnpm size`).

### Middleware

| Entry                 | Gives you                                                    |
| --------------------- | ------------------------------------------------------------ |
| `s200/cors`           | `cors` — preflights answered in place, headers stamped on the unwind (fallbacks included) |
| `s200/logger`         | `logger` — one line per request, every request (500s included) |
| `s200/request-id`     | `requestId` — seeds an id, stamps `x-request-id` on the unwind |
| `s200/timeout`        | `timeout` — narrows `ctx.signal`, races the chain against a deadline |
| `s200/etag`           | `etag` — If-None-Match revalidation over byte-backed bodies   |
| `s200/compress`       | `compress` — gzip/deflate/br via `CompressionStream`         |
| `s200/secure-headers` | `secureHeaders` — the OWASP header set                        |
| `s200/cache`          | `cache` — response caching with freshness validators          |
| `s200/rate-limit`     | `rateLimit` — sliding-window limiter with an injectable store |
| `s200/trust-proxy`    | `trustProxy` — honest client IPs behind a proxy               |
| `s200/version`        | `apiVersion` — header/Accept API versioning gate, `ctx.state.version` |

### Auth & sessions

| Entry           | Gives you                                                       |
| --------------- | --------------------------------------------------------------- |
| `s200/auth`     | `basicAuth`, `bearerAuth` — challenge-carrying gates            |
| `s200/jwt`      | `signJwt`, `verifyJwt`, `jwtAuth` — JWS over WebCrypto           |
| `s200/csrf`     | `createCsrf` — double-submit tokens                              |
| `s200/session`  | `createSession` — cookie sessions with an injectable store       |
| `s200/cookies`  | `getCookie`, `setCookie`, `getSignedCookie`, `setSignedCookie`   |

### Bodies & streaming

| Entry            | Gives you                                                        |
| ---------------- | ---------------------------------------------------------------- |
| `s200/accepts`   | `accepts` — RFC 9110 content negotiation                         |
| `s200/query`     | `parseQuery`, `queryParams` — typed query strings                |
| `s200/validate`  | `validate`, `jsonBody` — schema or hand-rolled parse fns         |
| `s200/serialize` | `serialize`, `jsonRaw` — declarative response shapes             |
| `s200/multipart` | `streamForm` — streaming multipart parts, per-part callbacks     |
| `s200/upload`    | `uploadForm` — gated uploads into an injected sink               |
| `s200/streaming` | `stream`, `streamSSE` — stream and SSE responses                 |

### Realtime

| Entry                   | Gives you                                                |
| ----------------------- | -------------------------------------------------------- |
| `s200/websocket`        | `upgradeWebSocket` — runtime-neutral WS upgrade          |
| `s200/websocket/node`   | `createUpgradeHandler` — the node http server side       |
| `s200/websocket/bun`    | `createBunWebSocketBridge` — the Bun side                |

### Introspection & tooling

| Entry             | Gives you                                                     |
| ----------------- | ------------------------------------------------------------- |
| `s200/route-table`| `createRouteTable` — the app as JSON, no execution             |
| `s200/meta`       | `describeRoute`, `describeApp` — route annotations             |
| `s200/openapi`    | `openapiSpec`, `openapiJson` — the OpenAPI 3.1 document        |
| `s200/swagger`    | `swaggerUi` — serve the docs UI                                |
| `s200/codegen`    | `generateClient` — typed clients from a route table            |
| `s200/client`     | `createClient` — the typed fetch client                        |
| `s200/test`       | `request`, `testClient`, `probeApp` — in-process app driving   |
| `s200/otel`       | `trace` — OTel spans per request                               |
| `s200/dev`        | `createHotApp`, `importFresh`, `watchAndReload` — hot table    |

### Operations

The application-lifecycle layer — NestJS's `enableShutdownHooks`,
`Terminus`, `@nestjs/config`, `@nestjs/schedule`, and `EventEmitter`
support, in data + functions form:

| Entry             | Gives you                                                        |
| ----------------- | ---------------------------------------------------------------- |
| `s200/lifecycle`  | `lifecycle` — signal-driven graceful shutdown: flip readiness, stop listening, drain in-flight, run cleanup |
| `s200/health`     | `health`, `readiness`, `createGate` — liveness/readiness probes over injectable checks |
| `s200/config`     | `parseEnv`, `createConfig` — Standard-Schema-typed, fail-fast config |
| `s200/schedule`   | `createScheduler`, `nextRun` — cron (5-field) and interval jobs, injectable clock |
| `s200/events`     | `createBus` — typed event bus over `@for-fun/event-emitter` (sync emit, `emitAsync`) |

### Sharding & scaling

The horizontal-scaling layer — one app, partitioned across
units, with the dispatch seam kept runtime-neutral:

| Entry               | Gives you                                                        |
| ------------------- | ---------------------------------------------------------------- |
| `s200/shard`        | `policy`, `shardSpecs`, `shardApp`, `matchShard` — route policy annotations, the serializable shard descriptor, partition, and the dispatch seam |
| `s200/gateway`      | `nginxConf`, `gatewayRoutes`, `albRules` — pure generators: the same specs → nginx.conf / Gateway API HTTPRoute / ALB listener rules |
| `s200/shard-dev`    | `createDispatcher` — in-process dispatcher with the same prefix semantics — local parity without nginx |
| `s200/executor`     | `runShards` — executors (`inline` / `thread` / `process` / `external`) + supervisor: lazy thread spawn with Node ≥26.6 listener transfer, forked process shims, restart with backoff |
| `s200/unit-metrics` | `createUnitMetrics`, `unitMetricsEndpoint` — the scheduler's eyes: in-flight, queue depth, event-loop utilization, RSS, warm/cold — as middleware + endpoint |

Full guide: [Sharding & Scheduling](/guides/sharding).

### Runtime adapters

Not middleware — one line each to serve the same app on another runtime:

| Entry             | Gives you                                                        |
| ----------------- | ---------------------------------------------------------------- |
| `s200/node`       | `serve` (light mode, TLS/HTTP2, WSS upgrade) + file readers      |
| `s200/bun`        | `serve` + the Bun file readers                                   |
| `s200/deno`       | `serve` over `Deno.serve`                                        |
| `s200/cloudflare` | `createHandler` — the module worker's default export             |

### Recipes

Repository-level TypeScript, deliberately **not** package exports — vendor
the file, bring your own client, inject:

| Recipe                   | For                                                             |
| ------------------------ | --------------------------------------------------------------- |
| [`recipes/redis-stores.ts`](https://github.com/wmzy/s200/blob/main/recipes/redis-stores.ts) | shared `rateLimit`/`createSession` stores over Redis — full guide: [Distributed Stores](./guides/distributed-stores.md) |

## Submit your battery

The registry below is for third-party batteries — anything importable that
follows the battery contract. Before you submit, check whether one of the
official entries above already covers it; a smaller core with a healthy
ecosystem around it is the point.

### Inclusion criteria

- **Data + functions paradigm.** A factory takes options and returns a
  `Middleware` (or data) — no classes, no `this`, no module-level
  registration side effects. [Authoring Batteries](https://github.com/wmzy/s200/blob/main/docs/guides/battery-authoring.md)
  walks the two runtime shapes (gates and unwind stampers) with examples
  from the built-ins.
- **Tree-shakable.** One entry per capability, ESM, side-effect-free module
  scope — importing your battery must not pull anything the importer did
  not name.
- **Zero runtime dependencies preferred.** Everything else is Web Standard
  or injected by the caller (stores, schemas, clocks, verifiers, sinks) —
  this is how the built-ins stay zero-dependency. A battery with a
  dependency can still be listed; the dependency column exists so
  importers see the cost.
- **Honest size.** The number in your row is the gzipped byte cost of the
  entry as an importer actually pulls it (e.g. `size-limit`, or
  `gzip -9 < dist/entry.mjs | wc -c`), measured, not estimated.

### Submission template

Open a PR against this page adding one row to the registry table, filled
per this template:

```md
| Name | Entry | Depends on | Size (gz) | Notes |
| ---- | ----- | ---------- | --------- | ----- |
| your-battery | `your-battery` | — | 0.4 kB | one line: what it does, and which seam it plugs (gate / unwind stamper / data) |
```

- **Name** — the npm package name, prefixed `s200-battery-` if you want the
  namespace read as an ecosystem convention (not required).
- **Entry** — the subpath importers write, e.g. `s200-battery-og/image`
  (one row per entry; multi-entry packages get one row each).
- **Depends on** — runtime dependencies, `—` when none. Peer dependencies
  count, with the version range.
- **Size (gz)** — measured gzipped entry size (see criteria above).
- **Notes** — one line, present tense: what it does. Link the repo docs in
  the Name cell.

### Process

1. Author per the [Authoring Batteries](https://github.com/wmzy/s200/blob/main/docs/guides/battery-authoring.md) guide; ship
   tests and a README with the measured size.
2. Open a PR that adds your row to the registry table below — the table is
   the review surface, and landing the PR is the listing.
3. Rows whose package stops resolving or whose size drifts un-communicated
  get one notice PR, then removal.

## Registry — third-party batteries

| Name | Entry | Depends on | Size (gz) | Notes |
| ---- | ----- | ---------- | --------- | ----- |

The table starts empty on purpose — no placeholder rows. Each cell follows
the submission template above; the first real entry sets the precedent.
