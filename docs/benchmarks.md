# Benchmarks

Two benchmarks, both runnable locally and both honest about what they measure:

- `pnpm bench` — router dispatch in isolation (`scripts/bench-router.mjs`): the
  cost of matching a pathname against a route table, out of context.
- `pnpm bench:http` — whole-request throughput (`scripts/bench-http.mjs`):
  a keep-alive HTTP client against each framework's real server, measuring
  everything from socket accept to response drain.

## Whole-request throughput

```
node v22.23.2 | concurrency=32 requests=30000/scenario

s200          hello     9119 req/s   param     9131 req/s
hono          hello    10040 req/s   param     9769 req/s
hono-patched  hello    14484 req/s   param    14025 req/s
express       hello     6447 req/s   param     6359 req/s
fastify       hello    14242 req/s   param    14272 req/s
elysia        hello    14011 req/s   param    13944 req/s
```

Machine: AMD Ryzen 7 8745HS, Fedora 42, Node 22.23.2, 2026-09-21.
`pnpm bench:http` re-runs every row in a clean child process.

Scenarios:

- `hello` — `GET /` → `{ "message": "hello" }`
- `param` — `GET /users/:id` → `{ "id": "42", "name": "ada" }`

Readings:

- **s200 ≈ hono on the real Web Standard path.** `hono` here runs
  `@hono/node-server` with `overrideGlobalObjects: false` — i.e. real
  `Request`/`Response` objects, which is what s200 always uses. Within the
  same class, s200 wins `param`, hono wins `hello`.
- **`hono-patched` is hono's default fast path**: the adapter replaces the
  global `Request`/`Response` with its own minimal classes. It is ~1.5×
  faster than either framework on real Web Standard objects — the cost is
  measured per-request in undici's full-featured `Request`/`Response`
  constructors, not in routing or dispatch. s200 will not patch globals:
  the core's contract is the platform's `Request`/`Response`.
- **`fastify` and `elysia` land in the same ~14k class** as `hono-patched`:
  fastify plumbs raw `IncomingMessage`s (no Web Standard objects at all),
  and elysia's srvx adapter ships its own lightweight request classes.
  Both avoid undici's constructor cost the way hono's patch does — that
  cost is the whole gap between the two classes in this benchmark.
- **express trails both** — its routing (path-to-regexp) and per-request
  stream plumbing cost roughly double at saturation.

## Router dispatch

```
routes=200 iterations=100000 (min of 3 rounds)
first hit        0.44 µs/req   x1.0
last hit         0.49 µs/req   x1.1
miss             0.19 µs/req   x0.4
param-first      0.45 µs/req   x1.0

routes=2000 iterations=100000 (min of 3 rounds)
first hit        0.46 µs/req   x1.0
last hit         0.48 µs/req   x1.0
miss             0.19 µs/req   x0.4
param-first      0.46 µs/req   x1.0
```

Dispatch cost is flat from 200 to 2000 routes: the walk visits only the
trie nodes the request's own segments spell out, so table size never
enters the hot path. (Earlier snapshots showed 2.2 µs at 2000 routes —
an artifact of 20k-iteration GC noise; the runs above use 100k
iterations and are stable across rounds.)

`param-first` is the shape other trie routers degrade on
(`/:tenant/resourceN` style); s200's index keys on every static segment, so
matching cost tracks URL depth, not route count. The residual linear case is
a table with no static segments at all (`/:a/:b/:c`).

## Methodology caveats

- Same machine, same client (`node:http` keep-alive agent), same payloads,
  one server per framework, warmed up first. Numbers are snapshots, not
  guarantees — re-run on your hardware.
- All servers run in separate child processes so no framework's global
  patching contaminates another's measurement.
- These are two-route apps with zero middlewares: they measure dispatch +
  adapter floor, not middleware-heavy workloads. Add your own routes to the
  scripts to model your traffic.
- Not a TechEmpower-style harness (no multi-core contention modeling, no
  kernel tuning). Use it for relative comparison, not capacity planning.
