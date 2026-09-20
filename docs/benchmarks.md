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

s200          hello     9249 req/s   param     9161 req/s
hono          hello     9901 req/s   param     8040 req/s
hono-patched  hello    13730 req/s   param    13400 req/s
express       hello     6443 req/s   param     5080 req/s
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
  global `Request`/`Response` with its own minimal classes. It is ~1.4×
  faster than either framework on real Web Standard objects — the cost is
  measured per-request in undici's full-featured `Request`/`Response`
  constructors, not in routing or dispatch. s200 will not patch globals:
  the core's contract is the platform's `Request`/`Response`.
- **express trails both** — its routing (path-to-regexp) and per-request
  stream plumbing cost roughly double at saturation.

## Router dispatch

```
routes=200 iterations=100000
first hit        0.89 µs/req   x1.0
last hit         0.95 µs/req   x1.1
miss             0.39 µs/req   x0.4
param-first      0.97 µs/req   x1.1

routes=2000 iterations=20000
first hit        2.22 µs/req   x1.0
last hit         0.88 µs/req   x0.4
miss             0.98 µs/req   x0.4
param-first      2.41 µs/req   x1.1
```

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
