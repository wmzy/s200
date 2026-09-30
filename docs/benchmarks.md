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

s200          hello     9254 req/s   param     9095 req/s
s200-light    hello    11844 req/s   param    11744 req/s
hono          hello    10067 req/s   param     9956 req/s
hono-patched  hello    14130 req/s   param    13762 req/s
express       hello     6476 req/s   param     6355 req/s
fastify       hello    14115 req/s   param    14064 req/s
elysia        hello    14420 req/s   param    14135 req/s
s200-deno  not measured on the reference machine (auto-skipped: deno not installed)
```

Machine: AMD Ryzen 7 8745HS, Fedora 42, Node 22.23.2, 2026-09-21.
`pnpm bench:http` re-runs every row in a clean child process.

Scenarios:

- `hello` — `GET /` → `{ "message": "hello" }`
- `param` — `GET /users/:id` → `{ "id": "42", "name": "ada" }`

### The `s200-deno` scenario

`pnpm bench:http` also knows an eighth scenario, `s200-deno`: the **same
built core** (`dist/index.mjs`) served through `Deno.serve`. s200's core is
plain Web Standard code, so the identical bundle runs on Deno with no
adapter. The script writes a small entry file to the OS temp dir (importing
the built core by `file://` URL), spawns `deno run` on it as its own
process, and measures it with the same node keep-alive client as every other
row — the only structural difference is that client and server sit in two
processes instead of one.

The scenario **auto-skips** when no `deno` binary is on `PATH`: the run
prints one skip line (the row above is that line, from the reference
machine) and continues; it never fails the benchmark. To enable it, install
[Deno](https://deno.com) ≥ 2.x and re-run `pnpm bench:http`.

Readings:

- **s200 ≈ hono on the real Web Standard path.** `hono` here runs
  `@hono/node-server` with `overrideGlobalObjects: false` — i.e. real
  `Request`/`Response` objects, which is what s200 uses by default. Within
  the same class, s200 wins `param`, hono wins `hello`.
- **`s200-light` is the opt-in fast path** (`serve(app, { light: true })`):
  the node adapter constructs light-weight `Request`/`Response` objects
  (nothing global is patched) and writes byte-backed bodies straight to the
  socket. It lands ~1.3× over the default class and beats hono on real Web
  Standard objects by ~18% — the remaining gap to the patched class is
  `Headers` construction and the adapter floor.
- **`hono-patched` is hono's default fast path**: the adapter replaces the
  global `Request`/`Response` with its own minimal classes. It is ~1.5×
  faster than either framework on real Web Standard objects — the cost is
  measured per-request in undici's full-featured `Request`/`Response`
  constructors, not in routing or dispatch. s200 does not patch globals:
  the default contract is the platform's `Request`/`Response`, and the
  opt-in light mode pays for its speed with narrower caveats (see README).
- **`fastify` and `elysia` land in the same ~14k class** as `hono-patched`:
  fastify plumbs raw `IncomingMessage`s (no Web Standard objects at all),
  and elysia's srvx adapter ships its own lightweight request classes.
  Both avoid undici's constructor cost the way hono's patch and s200's
  light mode do — that cost is the whole gap between the two classes in
  this benchmark.
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
  adapter floor, not middleware-heavy workloads. Add your own routes to
  the scripts to model your traffic.
- Not a TechEmpower-style harness (no multi-core contention modeling, no
  kernel tuning). Use it for relative comparison, not capacity planning.

## 2026-09-29 update (LightHeaders + default disconnect-abort)

Two later changes moved the s200 rows on a different machine (Node 26,
same-session before/after, so relative deltas hold even though absolute
numbers are not comparable to the reference table above):

- **`LightHeaders`** — the light path's request/response headers are now a
  duck-typed `Headers` (case-insensitive, insertion-ordered, wire-identical
  output), replacing two undici `Headers` constructions per request with
  one pair-indexed build. `s200-light` gained **+5.8% (hello) / +4.0%
  (param)**; the light-vs-normal ratio rose from ~1.23–1.26× to
  **~1.35×**.
- **Disconnect-abort by default** — `ctx.signal` now aborts on client
  disconnect out of the box (`abortOnDisconnect: false` restores the old
  shared never-aborted signal). The per-request `AbortController` + socket
  listener costs **~7.7%** on the two-route floor; every framework row
  pays its own disconnect policy, so treat cross-framework deltas measured
  before this change as one policy cheaper.

## 2026-09-29 addendum (light-mode coverage extension)

The light path's surface coverage was extended and pinned by tests —
plain `stream` responses, `compress` over streamed light bodies, all
`serveStatic` shapes (byte bodies, `stream: true` files, `readRange`
206s, HEAD/304/416/301), and the request body readers
(`readJson`/`readText`/`readForm`/`readStream`) over light requests
(`test/light-batteries.test.ts`). None of it touches the `hello`/`param`
hot path (the `json()` byte fast path), so throughput is flat, as
expected — same-session snapshot, Node v26, for the s200 rows:

```
s200          hello    10768 req/s   param    10639 req/s
s200-light    hello    15016 req/s   param    14638 req/s
```

The light-vs-normal ratio holds at **~1.39× (hello) / ~1.38× (param)**,
in line with the ~1.35× after `LightHeaders` (machine noise). One real
bug surfaced by the coverage work and fixed: a HEAD request against a
streamed static file advertised `content-length: 0` (both modes) —
`serveStream` now lets the stat-derived size survive (`handle`'s HEAD
rewrite strips the body afterward).
