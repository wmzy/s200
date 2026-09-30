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
- The `hello`/`param` rows are two-route apps with zero middlewares: they
  measure dispatch + adapter floor, not middleware-heavy workloads. The
  later `mw` scenario (see the last section) covers the middleware side;
  those rows leave `hello`/`param` middleware-free. Add your own routes to
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

## 2026-09-30 update (lazy request headers on the light path)

The light path stopped paying for headers nobody reads: `LightHeaders` now
builds its index **lazily** — the node adapter hands it `req.rawHeaders`
by reference (the intermediate pairs array is gone), and the slot/index
machinery materializes on the first structural access (`get`/`set`/
iteration/…). A request whose handler never touches `req.headers` — the
`hello`/`param` shape — builds nothing at all. The response side gained
`fillRecord`, a direct slots→record fill for `writeHead` (replacing the
`forEach` closure over the same data); http2 pseudo-header filtering and
every wire-visible semantic (case-insensitivity, insertion order,
`", "` merging, unmerged `set-cookie`) are pinned by
`test/light-batteries.test.ts`.

Honest measurement, because the wall clock could not see it: the official
benchmark client saturates around ~14.5k req/s on this machine (an
independent keep-alive client drives the same `s200-light` server to
25–26k), so `hello`/`param` walls are **client-bound** and stay flat.
The server-side signal is CPU per request, measured with interleaved
same-condition A/B runs (10 pairs, unchanged `s200` row as drift control):

- **server CPU/request −6.3% (median)**, lazy faster in 9/10 pairs;
- **`mw` wall +3–4%** (`fillRecord` scales with response-header count,
  and the chain reads a request header — the lazy build pays for itself
  there too);
- light-vs-normal ratio holds at **~1.43×** on both `hello` and `mw`.

## Middleware-heavy scenario (2026-09-30)

`scripts/bench-http.mjs` grew a third scenario, `mw` (`--only mw` runs it
alone): the same `{"message":"hello"}` JSON route as `hello`, but reached
through a five-link middleware chain where every link

- reads the `x-test` request header,
- sets its own response header at unwind,
- and — in the third link — stores a `performance.now()` delta into the
  per-request context.

The chain is scoped to `/mw` in every framework, so the `hello`/`param`
rows keep measuring the middleware-free floor and the `mw` row's delta
against `hello` isolates the chain itself.

Same machine as the reference table (AMD Ryzen 7 8745HS, Fedora 42), now
on **Node v26.10.0** — absolute numbers are not comparable to the Node 22
reference above. This table is the canonical run against the **final
2026-09-30 dist** (lazy light headers included; an earlier pre-lazy run
agreed on ordering, with `mw` cells within ~±4% and `s200-light mw` ~4%
lower):

| framework     | hello (same run) | mw      | mw vs hello |
| ------------- | ---------------- | ------- | ----------- |
| s200          | 10308 req/s      | 9590    | −7%         |
| s200-light    | 14760 req/s      | 13718   | −7%         |
| hono          | 12278 req/s      | 10250   | −17%        |
| hono-patched  | 17904 req/s      | 9313    | −48%        |
| express       | 11840 req/s      | 10841   | −8%         |
| fastify       | 17590 req/s      | 16681   | −5%         |
| elysia        | 16846 req/s      | 15428   | −8%         |

`s200-deno` auto-skipped (no `deno` binary on this machine, same as the
reference run). Individual `hello` cells wobble up to ~±10% run to run, so
read single-cell deltas as approximate and the ordering as the signal.

### What it measures — and what it does not

This scenario measures the **per-request cost of unwinding a five-link
chain**: chain dispatch, one request-header read and one response-header
write per link, one timing store. It does not re-measure the adapter
floor — `hello` already does that — which is why the fast-class
frameworks (`fastify`, `elysia`, `hono-patched`) stay at the top on
absolute numbers even as their middleware costs differ wildly.

The per-framework shapes are each framework's idiomatic middleware, kept
work-equivalent (same reads, writes, and timing store) but not
mechanically identical, and that honesty matters when reading the table:

- **express** (`app.use('/mw', …)`) and **fastify** (async `onRequest`
  hooks in an encapsulated `register` scope) write headers into a store
  applied when the response is serialized. **elysia** writes
  `set.headers` the same way, but inside `guard({ beforeHandle })` — its
  `onRequest` hooks cannot be scoped (they fire for the whole instance,
  verified), so the post-routing hook is the scoped equivalent.
- **hono** (`app.use('/mw/*', …)` with `await next(); c.header(…)`) and
  **s200** (`use(app, '/mw', …)` with `ctx.res.headers.set` after
  `next()`) do the true unwind: they mutate the already-materialized
  response after the handler ran.

That asymmetry is the story of the `mw vs hello` column. **fastify**
loses almost nothing (~0–5% across runs): its hook chain is plain
function calls appending to a header store. **elysia** (−8%) and
**express** (−8%) pay a modest chain cost. **hono** drops −17–18%:
`c.header()` after `await next()` re-materializes the response — once
per header write — and on the patched fast path that rebuild cost
dominates everything else: `hono-patched` collapses −46% and lands
*below* unpatched `hono` under middleware load. **s200** (−7–9% across
runs) also writes headers after the handler, but mutates the existing
`Response`'s headers in place — no rebuild — landing in express's
neighborhood despite the richer per-request context.

**s200-light** keeps its own floor almost untouched (−7%, within the
hello-cell noise) and holds the light-vs-normal ratio at **~1.43×** under
middleware load: the light path's cheap `LightHeaders` writes make the
chain nearly free on top of an already-cheap response.

The same methodology caveats as the whole-request section apply —
snapshots, not guarantees; one server per child process; re-run on your
hardware (`node scripts/bench-http.mjs --only mw`).

