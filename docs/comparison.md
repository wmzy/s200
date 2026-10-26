# Comparison

s200 against the frameworks people actually deploy. Honest about the gaps —
the left column is the pitch, the rest is where s200 trades away to get it.

## Positioning

s200 = **Hono's runtime portability + Koa's middleware model, on a
data-and-functions core**. The app is a plain value (routes, middlewares,
config); every capability is a top-level function. No class, no method
calls, zero dependencies, every module tree-shakable and replaceable.

## The table

| Dimension | s200 | Hono | Express 5 | Fastify 5 | Koa | Elysia |
|---|---|---|---|---|---|---|
| Paradigm | data + functions, zero deps | class-based, zero deps | OOP, ~30 deps | factory, ~20 deps | minimal core, zero deps | class-chain, TS-first, 4 deps |
| Runtimes | Node ≥ 20.3, Bun; Cloudflare/AWS Lambda/Vercel adapters | everything + adapter matrix (v5: 8 `@hono/*` pkgs) | Node only | Node only (v6 plans ≥ 24) | Node only | Bun-first; Node via srvx+crossws (h3's base), web-standard/Cloudflare via adapters |
| Middleware model | koa onion, in-chain error boundary | hono onion | connect-style | hook system | koa onion | lifecycle hooks (derive/resolve) + plugins |
| Router | static-prefix trie, every static segment indexed | RegExpRouter / TrieRouter | path-to-regexp | find-my-way radix | koa-router (path-to-regexp) | static map + memoirist radix, JIT-compiled handlers |
| Optional params `:id?` | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| Typed params from pattern literal | ✅ `ParamsOf` | ✅ (infer) | ❌ | ✅ (typebox schemas) | ❌ | ✅ (inferred) |
| Typed HTTP client from the app | ✅ paths + params + query + JSON bodies + status/error branches, `res.json()` discriminated by `res.status` | ✅ `hc` (full RPC) | ❌ | ❌ | ❌ | ✅ Eden treaty (full RPC) |
| Route removal | ✅ `removeRoute` | ❌ | partial | ❌ | ❌ | ❌ |
| Route table as data | ✅ JSON-exportable + OpenAPI | ❌ | ❌ | ✅ | ❌ | ❌ |
| HTTPS / HTTP/2 in adapter | ✅ | ✅ | ✅ | ✅ | 3rd-party | via runtime (Bun.serve) |
| WebSocket | ✅ zero-dep RFC 6455 node + bun (subprotocols, permessage-deflate, heartbeat) | ✅ | 3rd-party | 3rd-party | 3rd-party | ✅ built-in `.ws()` (Bun API; crossws on node) |
| Batteries | 38 opt-in (cors, cookies, csrf, jwt, oauth, cache, etag, compress, rate-limit, session, upload, response-check, mcp, …) | ~20 (incl. csrf/jwt/cache) | ecosystem | plugin ecosystem | ecosystem | ~15 official plugins (openapi, jwt, cors, rate-limit, …) |
| Throughput class (see benchmarks) | Web Standard object class; opt-in light mode ~1.3–1.4× | same (patched: 1.5×) | ~0.6× | patched class | below | patched class; top of it on Bun |
| Core size (min+gz) | size-limit-gated: ~4 kB minimal core / ~8 kB full barrel | ~10 kB+ | — | — | tiny, no batteries | 1.1 MB unpacked; 141 kB min hello-world (v2 rc) |
| Validation integration | generic gate over any parser + response contract checking (`s200/response-check`) | zod/valibot/typebox built-in (v5 roadmap: response validation) | ecosystem | JSON Schema native (v6 milestone: Ajv response validation) | ecosystem | TypeBox built-in (`t`) + standard schema |
| OpenAPI | ✅ native 3.1 from the route table | zod-openapi (dep) | ❌ | swagger plugin | ❌ | ✅ plugin (Scalar/Swagger UI) |
| JSX / SSG / dev server | ❌ (route-table hot reload via `s200/dev`) | ✅ | ❌ | ❌ | ❌ | ❌ (html plugin) |
| Ecosystem size | young | large | huge | large | large | fast-growing (9th most used, SoJS 2025) |

Counting rule for the batteries row: the package exposes 56 entries — the
root barrel plus 55 subpaths. Five subpaths are runtime adapters (`node`,
`bun`, `cloudflare`, `aws-lambda`, `vercel`) and nine are
tooling/meta entries (`client`, `codegen`, `dev`, `meta`, `openapi`,
`route-table`, `swagger`, `test`, `version`); the remaining 41 feature
subpaths are 38 distinct opt-in batteries once `websocket/node`,
`websocket/bun` and `websocket/cloudflare` fold into the `websocket`
battery.

### Elysia in one paragraph

Elysia is the strongest entry in the TypeScript end-to-end weight class, and
the table doesn't hide it: [Eden Treaty](https://elysiajs.com/eden/treaty/overview)
infers paths, params, bodies, queries, and error branches from the server
type with no codegen; validation is [TypeBox built into the route
DSL](https://elysiajs.com/patterns/typebox) (`t` plus standard-schema for
zod/valibot); [OpenAPI docs](https://elysiajs.com/plugins/openapi) fall out
of the same definitions; WebSocket is a first-class `.ws()` route following
[Bun's API](https://elysiajs.com/patterns/websocket) (crossws on the node
adapter); and routing is a static map plus a [memoirist radix
tree](https://github.com/saltyaom/memoirist) behind JIT-compiled per-route
handlers — in our benchmark it lands in the patched ~14k req/s class on the
node adapter ([docs/benchmarks.md](./benchmarks.md)), and higher still on
Bun, its first-class runtime. The v2 RC quantifies what that inference
costs at rest: [10.7 kB of memory per route with no
validator](https://next.elysiajs.com/blog/elysia-20-rc/) (Hono 16, Fastify
26.7) and 16 kB with TypeBox schemas (Fastify's JSON-Schema serialization
weighs 93.3), and it now statically infers *every* error response a route
can produce, flowing them into Eden and OpenAPI automatically. The
trade-offs are the mirror image: an app is
an opaque class chain, not data plus functions — it can't be exported as
JSON or inspected without the framework — and there is no documented
route-removal API. The core is ~1.1 MB unpacked with [4 runtime
dependencies](https://www.npmjs.com/package/elysia) (TypeBox ships as a
peer), and outside Bun the story is adapters rather than Hono's matrix —
v2's Node adapter is rebuilt on srvx + crossws, the same foundation h3
sits on, so Node is hardly second-class, but web-standard and Cloudflare
still go through adapters and there is no edge story to speak of;
middleware is [lifecycle
hooks](https://elysiajs.com/essential/life-cycle) (derive/resolve), not the
onion s200 and Koa share. If your target is Bun and you want tRPC-grade
inference with server-side schemas, Elysia is the rational pick; s200 is
betting on runtime-agnostic data + functions instead.

## Where s200 wins

- **Zero dependencies** including the WebSocket server — no undici/hono-node-server bridge, no ws, no path-to-regexp.
- **A deliberately wide runtime envelope**: Hono v5 drops the CommonJS build and requires Node ≥ 22.12, Fastify v6 plans Node ≥ 24 — s200 publishes dual ESM+CJS and runs on Node ≥ 20.3, so one artifact embeds in CommonJS hosts and the oldest LTS still in fleets without a transpile step.
- **In-chain error boundary**: a route handler that throws is mapped to a
  response *before* the middleware unwind, so logger/cors/request-id stamp
  the real 404/405/500. Express needs a last-registered error middleware;
  Hono's `onError` sits outside the chain (Hono v5, in rc as of 2026-10,
  turns `onError`/`notFound` into routable, composable in-chain
  middleware — upstream converging on s200's model).
- **Every static segment indexed**: `/:tenant/resourceN` tables don't
  degrade to linear scans (see `docs/benchmarks.md` router numbers).
- **The app is data**: export the route table as JSON, emit the OpenAPI 3.1
  document from it, type a fetch client from it, or translate it to another
  language — no execution needed. No schema library: route annotations reuse
  the `SerializeSchema` DSL that already compiles serializers and infers types.
- **Replaceable everything**: custom matcher, custom error/404 policy,
  injected I/O for static files — the batteries prove the pattern.
- **Hot route reload from the same data model** — `s200/dev`'s
  `createHotApp`/`reload` swaps the table atomically on one stable app
  identity (in-flight requests finish on the old chain); the snapshot
  semantics that make it safe are the same ones that power
  `removeRoute`.

## Where s200 trades away (honest gaps)

- **No JSX/SSG/dev-server story** — Hono's frontend-adjacent features are
  out of scope; s200 is a server framework.
- **No full RPC inference** — `s200/client` types paths, params, query-
  building, JSON response bodies, and status literals — a handler's
  `json(ctx, err, { status: 404 })` branch shows up as
  `res.status: 200 | 404` with the unioned body. Error branches flow from
  two channels: a **returned** `httpError(status, message, body?)` is
  inferred end to end (returning one is sugar for throwing it — same
  in-chain error boundary, `onError` included), and a `throws(401, 404)`
  (or `throws({ 422: shape })`) gate declares branches a helper deep in
  the call stack may produce. The client response is a
  **status-discriminated union**: narrowing `res.status` narrows
  `res.json()`. Gate inputs flow from any
  [Standard Schema](https://standardschema.dev) value (zod / valibot /
  typebox) or a `jsonBody`/`queryParams` parse function, with the schema's
  **input** type on the caller's side (`init.body`/`init.query`) and the
  parsed output on the handler's — input ≠ output transforms infer
  end to end. What is still missing vs Hono `hc`/Elysia Eden: `throw
  httpError(...)` call sites inside a handler body are invisible to the
  type layer (TypeScript cannot inspect function bodies — return the
  error or declare it), and `throws` is a pass-through declaration the
  checker does not verify.
- **No mid-path wildcards** — `*name` must be the final segment
  (`/files/*path` is fine; `/a/*rest/b` throws at registration).
  Final-segment-only keeps capture semantics unambiguous and the
  static-segment index intact; it is part of the matching contract,
  revisited only in a major (see [routing](./guides/routing.md)).
- **Throughput behind the patched class** — s200 always uses the
  platform's real `Request`/`Response`; fastify/elysia/hono-patched avoid
  undici's constructor cost with lighter objects. The gap is per-request
  construction cost, not dispatch (measured in `docs/benchmarks.md`).
- **No WebSocket upgrade over HTTP/2** — WSS over HTTPS works in
  `s200/node` (`https` + `upgrade` together); HTTP/2 has no upgrade
  event, so `http2: true` excludes the `upgrade` option.
- **Young ecosystem** — the third-party battery registry just opened
  ([docs/ecosystem.md](./ecosystem.md)); the official batteries cover the
  common surface, the `use` pattern covers the rest.

## 2026-10 upstream notes

Three of the five comparators are mid-transition into a new major and two
are quiet incumbents; the facts below come from their own release docs and
trackers.

- **Hono v5 — still RC as of 2026-10-21** ([migration
  guide](https://hono.dev/docs/guides/migrating-to-v5), [v5 features
  list](https://github.com/honojs/hono/issues/5106)): rc.0 landed 2026-10-08
  and rc.1 two days later; stable has not shipped. `hono` goes ESM-only —
  the CommonJS build is removed — and requires Node ≥ 22.12; the runtime
  adapters split out into eight `@hono/*` packages (`@hono/bun`,
  `@hono/cloudflare-workers`, `@hono/vercel`, …); a
  non-`Error` throw no longer
  escapes `app.fetch()` — it reaches `onError` wrapped in an `Error`
  (original value on `c.error.cause`); wildcard matching gains mid-path
  segment-suffix forms (`/x*/y`), now consistent across every router; and
  **response validation** is on
  the v5 list (checked off there; `@hono/zod-validator` 0.8 already types
  the 400 branch into the RPC client) — the same axis s200's
  `response-check` battery covers today. The s200 contrast on the same
  axes: dual ESM+CJS publishing (attw-profiled in CI), Node ≥ 20.3, and
  adapters as first-party subpath entries (`s200/node`, `s200/bun`) that
  already exist without a major.
- **Elysia v2 RC** ([RC
  announcement](https://next.elysiajs.com/blog/elysia-20-rc/),
  [releases](https://github.com/elysiajs/elysia/releases)): the 1.4.x line
  is security-fix-only; 2.0.0-rc.0 (2026-10-19) headlines memory — 10.7
  kB per route with no validator (Hono 16, Fastify 26.7), 16 kB with
  TypeBox (Fastify 93.3) — plus faster startup, tree-shakable modules, AOT
  compilation, and statically inferred error responses flowing into
  Eden/OpenAPI. Two course corrections matter here: the Node adapter is
  rebuilt on srvx + crossws — the same foundation as h3 — and the
  lifecycle API kept the 1.x `on` prefix, so existing plugins carry into
  v2 without a rewrite. The rewrite cost was paid by the maintainers, not
  the users; s200's offer is never paying it — `sideEffects: false`, 55
  tree-shaken package entries, and size-limit budgets gating every release
  have been the package's shape since day one.
- **Fastify v6 — slipped** ([v6
  planning](https://github.com/fastify/fastify/issues/6834),
  [milestone](https://github.com/fastify/fastify/milestone/6)): the plan
  was an alpha in July and a stable in September; as of 2026-10-21 the
  line is still at 6.0.0-alpha.5. v6 does contain: minimum Node bumped to
  v24, and ["Validate response with Ajv before
  serializing"](https://github.com/fastify/fastify/issues/4653) finally in
  the v6 milestone (#6507 removes fast-json-stringify to get there) —
  response contract checking, the idea s200's `response-check` battery
  ships against the `SerializeSchema` contract. The stable line stays
  v5.12.x under the [LTS
  policy](https://fastify.dev/docs/latest/Reference/LTS/), while the
  alphas headline per-request cost work — optimized header handling,
  string bodies decoded once, a parsed-content-type cache. Per-request
  cost is the axis where s200's opt-in light mode earns its ~1.4×
  (fastify plumbs raw `IncomingMessage`s and never pays undici's
  constructor tax in the first place).
- **The quiet incumbents** ([Express
  releases](https://github.com/expressjs/express/releases), [Koa
  releases](https://github.com/koajs/koa/releases)): Express 5.3.0
  (2026-10-09) keeps the ~87M-weekly-download machine on slow, steady
  maintenance — still the default reflex and the install base everything
  else migrates from. Koa 3.2.1 (2026-05-21) is slower still but alive —
  3.2 added V8 startup-snapshot support. Neither moves a comparison axis
  anymore; they are why the migration guides exist.

## The wider 2026 field

The frame for reading the table: the TypeScript server ecosystem
consolidated around a few shared layers this year, and s200 plugs into all
of them rather than competing head-on.

- **[Standard Schema](https://standardschema.dev) won the validation
  layer.** zod, valibot, arktype, effect, and TypeBox all implement the
  interface; tRPC v11, TanStack Form, and React Hook Form consume it.
  s200's `validate` gate and `response-check` contract accept any Standard
  Schema value — no schema vendor is baked in.
- **[TypeScript 7
  shipped](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)** —
  the native Go port, 8–12× faster full builds. Deep type-level inference
  stopped being a compile-time luxury; Elysia 2's whole-route error
  inference is built on that headroom.
- **[Effect 4.0](https://effect.website/blog/releases/effect/40)** rebuilt
  on a zero-dependency ~7.1 kB core, with `@effect/platform`'s HttpRouter
  around 90k req/s on Node — the "typed everything" stack is
  performance-competitive now, not a tax.
- **[TanStack Start 1.0](https://tanstack.com/blog/tanstack-start-1-0)**
  (2026-10-13) made typed server functions a mainstream primitive, and
  type-safe RPC ([tRPC v11](https://trpc.io), oRPC) keeps rising — both
  want exactly one thing underneath: a typed, portable HTTP backend.
- **[MCP](https://modelcontextprotocol.io)** became the de facto standard
  for LLM integration ([TypeScript SDK v2
  stable](https://github.com/modelcontextprotocol/typescript-sdk));
  framework round-ups already list MCP support as a comparison dimension.
- **The OpenAPI 3.1 toolchain matured**:
  [openapi-typescript](https://github.com/openapi-ts/openapi-typescript),
  [Scalar](https://github.com/scalar/scalar), and
  [Stainless](https://stainlessapi.dev) turn a spec into types, docs, and
  SDKs.

s200's slot in that field is deliberately narrow: a **pure API/data
server** — not an RPC layer, not a meta-framework. The layers above are
complementary: they need a typed HTTP backend, and s200's route table
emits native [OpenAPI 3.1](./api/openapi.md), so the same toolchain plugs
in (Scalar via `s200/swagger`, typed clients via `s200/codegen`) without
adopting a full-stack framework to get it.

## Migration guides

- [From Express](./migration-from-express.md)
- [From Koa](./migration-from-koa.md)
- [From Hono](./migration-from-hono.md)

## Raw numbers

See [benchmarks](./benchmarks.md) — same machine, same client, one process
per framework, methodology caveats included.
