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
| Runtimes | Node, Bun, Deno/edge via core | everything + adapter matrix | Node only | Node only | Node only | Bun-first; Node/web-standard/Cloudflare via adapters |
| Middleware model | koa onion, in-chain error boundary | hono onion | connect-style | hook system | koa onion | lifecycle hooks (derive/resolve) + plugins |
| Router | static-prefix trie, every static segment indexed | RegExpRouter / TrieRouter | path-to-regexp | find-my-way radix | koa-router (path-to-regexp) | static map + memoirist radix, JIT-compiled handlers |
| Optional params `:id?` | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| Typed params from pattern literal | ✅ `ParamsOf` | ✅ (infer) | ❌ | ✅ (typebox schemas) | ❌ | ✅ (inferred) |
| Typed HTTP client from the app | ✅ paths + params + query + JSON bodies + status/error branches | ✅ `hc` (full RPC) | ❌ | ❌ | ❌ | ✅ Eden treaty (full RPC) |
| Route removal | ✅ `removeRoute` | ❌ | partial | ❌ | ❌ | ❌ |
| Route table as data | ✅ JSON-exportable + OpenAPI | ❌ | ❌ | ✅ | ❌ | ❌ |
| HTTPS / HTTP/2 in adapter | ✅ | ✅ | ✅ | ✅ | 3rd-party | via runtime (Bun.serve) |
| WebSocket | ✅ zero-dep RFC 6455 node + bun (subprotocols, permessage-deflate, heartbeat) | ✅ | 3rd-party | 3rd-party | 3rd-party | ✅ built-in `.ws()` (Bun API; crossws on node) |
| Batteries | 31 opt-in (cors, cookies, csrf, jwt, cache, etag, compress, rate-limit, session, upload, …) | ~20 (incl. csrf/jwt/cache) | ecosystem | plugin ecosystem | ecosystem | ~15 official plugins (openapi, jwt, cors, rate-limit, …) |
| Throughput class (see benchmarks) | Web Standard object class; opt-in light mode ~1.3–1.4× | same (patched: 1.5×) | ~0.6× | patched class | below | patched class; top of it on Bun |
| Core size (min+gz) | size-limit-gated: ~4 kB minimal core / ~8 kB full barrel | ~10 kB+ | — | — | tiny, no batteries | 1.1 MB unpacked; 141 kB min hello-world (v2 beta) |
| Validation integration | generic gate over any parser | zod/valibot/typebox built-in | ecosystem | JSON Schema native | ecosystem | TypeBox built-in (`t`) + standard schema |
| OpenAPI | ✅ native 3.1 from the route table | zod-openapi (dep) | ❌ | swagger plugin | ❌ | ✅ plugin (Scalar/Swagger UI) |
| JSX / SSG / dev server | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ (html plugin) |
| Ecosystem size | young | large | huge | large | large | fast-growing (9th most used, SoJS 2025) |

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
Bun, its first-class runtime. The trade-offs are the mirror image: an app is
an opaque class chain, not data plus functions — it can't be exported as
JSON or inspected without the framework — and there is no documented
route-removal API. The core is ~1.1 MB unpacked with [4 runtime
dependencies](https://www.npmjs.com/package/elysia) (TypeBox ships as a peer),
and everything outside Bun (node, web-standard, Cloudflare Workers) goes
through adapters rather than Hono's battle-tested matrix — there is no
Deno/edge story to speak of, and middleware is [lifecycle
hooks](https://elysiajs.com/essential/life-cycle) (derive/resolve), not the
onion s200 and Koa share. If your target is Bun and you want tRPC-grade
inference with server-side schemas, Elysia is the rational pick; s200 is
betting on runtime-agnostic data + functions instead.

## Where s200 wins

- **Zero dependencies** including the WebSocket server — no undici/hono-node-server bridge, no ws, no path-to-regexp.
- **In-chain error boundary**: a route handler that throws is mapped to a
  response *before* the middleware unwind, so logger/cors/request-id stamp
  the real 404/405/500. Express needs a last-registered error middleware;
  Hono's `onError` sits outside the chain.
- **Every static segment indexed**: `/:tenant/resourceN` tables don't
  degrade to linear scans (see `docs/benchmarks.md` router numbers).
- **The app is data**: export the route table as JSON, emit the OpenAPI 3.1
  document from it, type a fetch client from it, or translate it to another
  language — no execution needed. No schema library: route annotations reuse
  the `SerializeSchema` DSL that already compiles serializers and infers types.
- **Replaceable everything**: custom matcher, custom error/404 policy,
  injected I/O for static files — the batteries prove the pattern.

## Where s200 trades away (honest gaps)

- **No JSX/SSG/dev-server story** — Hono's frontend-adjacent features are
  out of scope; s200 is a server framework.
- **No full RPC inference** — `s200/client` types paths, params, query-
  building, JSON response bodies, and status literals — a handler's
  `json(ctx, err, { status: 404 })` branch shows up as
  `res.status: 200 | 404` with the unioned body. Gate inputs flow from any
  [Standard Schema](https://standardschema.dev) value (zod / valibot /
  typebox) or a `jsonBody`/`queryParams` parse function, with the schema's
  **input** type on the caller's side (`init.body`/`init.query`) and the
  parsed output on the handler's — input ≠ output transforms infer
  end to end. Error branches are declarable: a `throws(401, 404)` (or
  `throws({ 422: shape })`) gate merges the statuses and body shapes into
  `res.status` and `res.json()` — a pass-through declaration the checker
  does not verify. What is still missing vs Hono `hc`/Elysia Eden: error
  types are not inferred from the handler's thrown `httpError` calls
  (they must be declared with `throws`), and `json()` is not
  status-discriminated — narrowing `res.status` does not narrow the body
  union.
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

## Migration guides

- [From Express](./migration-from-express.md)
- [From Koa](./migration-from-koa.md)
- [From Hono](./migration-from-hono.md)

## Raw numbers

See [benchmarks](./benchmarks.md) — same machine, same client, one process
per framework, methodology caveats included.
