# Comparison

s200 against the frameworks people actually deploy. Honest about the gaps —
the left column is the pitch, the rest is where s200 trades away to get it.

## Positioning

s200 = **Hono's runtime portability + Koa's middleware model, on a
data-and-functions core**. The app is a plain value (routes, middlewares,
config); every capability is a top-level function. No class, no method
calls, zero dependencies, every module tree-shakable and replaceable.

## The table

| Dimension | s200 | Hono | Express 5 | Fastify 5 | Koa |
|---|---|---|---|---|---|
| Paradigm | data + functions, zero deps | class-based, zero deps | OOP, ~30 deps | factory, ~20 deps | minimal core, zero deps |
| Runtimes | Node, Bun, Deno/edge via core | everything + adapter matrix | Node only | Node only | Node only |
| Middleware model | koa onion, in-chain error boundary | hono onion | connect-style | hook system | koa onion |
| Router | static-prefix trie, every static segment indexed | RegExpRouter / TrieRouter | path-to-regexp | find-my-way radix | koa-router (path-to-regexp) |
| Optional params `:id?` | ✅ | ✅ | ✅ | ❌ | ✅ |
| Typed params from pattern literal | ✅ `ParamsOf` | ✅ (infer) | ❌ | ✅ (typebox schemas) | ❌ |
| Typed HTTP client from the app | ✅ paths + params + query + JSON bodies | ✅ `hc` (full RPC) | ❌ | ❌ | ❌ |
| Route removal | ✅ `removeRoute` | ❌ | partial | ❌ | ❌ |
| Route table as data | ✅ JSON-exportable + OpenAPI | ❌ | ❌ | ✅ | ❌ |
| HTTPS / HTTP/2 in adapter | ✅ | ✅ | ✅ | ✅ | 3rd-party |
| WebSocket | ✅ zero-dep RFC 6455 node + bun (subprotocols, permessage-deflate, heartbeat) | ✅ | 3rd-party | 3rd-party | 3rd-party |
| Batteries | 22 opt-in (cors, cookies, csrf, jwt, cache, etag, compress, rate-limit, …) | ~20 (incl. csrf/jwt/cache) | ecosystem | plugin ecosystem | ecosystem |
| Throughput class (see benchmarks) | Web Standard object class; opt-in light mode ~1.3× | same (patched: 1.5×) | ~0.6× | patched class | below |
| Core size (min+gz) | 2.9 kB | ~10 kB+ | — | — | tiny, no batteries |
| Validation integration | generic gate over any parser | zod/valibot/typebox built-in | ecosystem | JSON Schema native | ecosystem |
| OpenAPI | ✅ native 3.1 from the route table | zod-openapi (dep) | ❌ | swagger plugin | ❌ |
| JSX / SSG / dev server | ❌ | ✅ | ❌ | ❌ | ❌ |
| Ecosystem size | young | large | huge | large | large |

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
  building, and JSON response bodies (handlers returning `json(ctx, data)`
  brand the body type; plain `Response` handlers stay `unknown`), but input
  validation types and Hono `hc`/Elysia Eden-class end-to-end inference are
  a much larger type project.
- **Throughput behind the patched class** — s200 always uses the
  platform's real `Request`/`Response`; fastify/elysia/hono-patched avoid
  undici's constructor cost with lighter objects. The gap is per-request
  construction cost, not dispatch (measured in `docs/benchmarks.md`).
- **No HTTP/1.1 upgrade over HTTPS** — WebSocket upgrade and TLS can't
  combine in `s200/node` (HTTP/2 has no upgrade either); use a proxy or
  WSS through one when you need both.
- **Young ecosystem** — no third-party middleware registry yet; the
  batteries cover the common surface, the `use` pattern covers the rest.

## Migration guides

- [From Express](./migration-from-express.md)
- [From Koa](./migration-from-koa.md)
- [From Hono](./migration-from-hono.md)

## Raw numbers

See [benchmarks](./benchmarks.md) — same machine, same client, one process
per framework, methodology caveats included.
