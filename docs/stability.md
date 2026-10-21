# Stability & versioning

s200 is heading to 1.0. This page is the contract: what freezes at 1.0, how
versions are cut, and — just as important — what is honestly **not** frozen
yet. If you build on s200, this is the page to check before upgrading.

## Frozen surface (the 1.0 contract) {#frozen-surface-the-10-contract}

The core contract below is contractual from 1.0 on: it changes only in a
major release (before 1.0, in a flagged minor — see the
[semver policy](#semver-policy)). It is deliberately the surface real apps
touch; internals (private helpers, chunk layout, undocumented objects)
stay free to move. Package entries freeze in two tiers — a core list
together with this contract, and the remaining entries on the looser
stable tier (see [Battery entries](#battery-entries)).

### App creation

```ts
const app = createApp(options?);
```

| Option | Contract |
|---|---|
| `match` | Replaces the whole matching strategy (a `MatchFn` over the route table). The shipped matcher stays the default. |
| `strict` | Trailing-slash policy for the default matcher. Default `true` (strict: `/a/` does not match `/a`); `false` tolerates one trailing slash. |
| `onError` | Owns the error → response mapping. When unset, unhandled `HttpError`s render as `{ status, body: { "error": message } }` and anything else is logged (`logError`, default `console.error`) and rendered as a generic 500 that never leaks internals. |
| `onNotFound` | Owns the unmatched-path response. Default: `404 {"error":"Not Found"}`. |
| `logError` | Swaps the error sink while keeping the default mapping. Receives `(error, ctx)` — the second parameter is additive, so `(error) => void` sinks keep working. Default: one context line `[s500] <method> <pathname>[ <request id>]`, then the error, via `console.error` — the id is the request-id battery's `state.requestId` (whatever header name it uses), falling back to a literal `x-request-id` header. |

`createApp` also takes the per-app `State` interface (`createApp<AdminState>()`)
— that generic shape is part of the contract.

### Registrars

`use`, `get`, `post`, `put`, `patch`, `del`, `head`, `options`, `all`,
`addRoute`, `removeRoute`, `mount` (plus `usePlugin` for
function-shaped plugins). The behavioral contracts they carry:

- `use(app, mw)` appends an app-level middleware; `use(app, '/admin', mw)`
  scopes a group to a segment-boundary-aware prefix (param prefixes use the
  router's own matching). Nesting follows registration order.
- Route registrars accept any number of scoped middlewares between the
  pattern and the terminal handler; they run after the app-level chain and
  unwind inside it.
- `all` matches every method; `addRoute(app, 'PURGE', …)` registers any
  method string.
- `removeRoute(app, 'GET', '/users/:id')` erases by method + pattern; the
  route table is snapshot-immutable (registration replaces frozen arrays, a
  direct `push` throws), so dispatch caches can never go stale.
- `mount(app, '/v1', sub)` is a pure data transform: `sub` is copied, never
  mutated, and its app-level middlewares become route-scoped on the mounted
  routes.

### The `Ctx` contract

```ts
type Ctx = { req, url, params, query, state, signal, res };
```

- **`params` are pre-decoded** — captured values reach handlers
  percent-decoded (`/users/foo%20bar` → `'foo bar'`), while matching runs on
  the raw path, so an encoded `/` can never fake a segment boundary.
- **`url` is parsed once per request** and cached — reuse it, never re-parse.
- **`signal` is cooperative cancellation**: it aborts when the client
  disconnects (node adapter default; `abortOnDisconnect: false` restores a
  shared never-aborted signal), the `timeout` battery aborts it at the
  deadline, and long-running work should race it (the body readers do).
  Middlewares may swap it on the way in and restore it on the unwind.
- **`state` is a fresh mutable bag per request** — the typed hand-off
  channel, extendable by declaration merging or a per-app interface.
- **`res` is always materialized after `await next()` settles** — the
  handler's response, the 404/405/500 fallback, **or the mapped error
  response**: an error boundary inside the chain maps thrown errors before
  the unwind, so middlewares observe (and may overwrite) the real response
  even for 500s. Before anything is written, `res` is `undefined`.
- **`onFinish(ctx, fn)`** — registers a once-per-request callback receiving
  `{ aborted }`: `false` after the response is fully written, `true` when
  the connection ends first (see the adapters' pages for the per-runtime
  triggers).

### Responding

`json`, `text`, `html`, `send`, `redirect`, and `newResponse` write
`ctx.res` in place (init headers always win over defaults) and return the
written `Response`. The surrounding contracts:

- Handlers may simply **return** a `Response` — it is written when nothing
  has been written yet. They may also **return an `HttpError`** — sugar for
  throwing it: the value flows through the same in-chain error boundary
  (`onError` mapping included), and the return type carries the status and
  body shape into `s200/client`'s `res.status` / `res.json()` unions.
- A matched chain that finishes without writing answers
  `500 {"error":"No response written"}`; an unmatched, unwritten request
  goes to `onNotFound`.
- **The `content-length` contract**: the helpers set `content-length`
  explicitly whenever the size is known (platforms serialize lazily, so a
  bare `new Response('…')` carries none). HEAD responses keep the would-be
  size, and size-aware middlewares (`compress`'s `minBytes`, `s200/etag`'s
  byte-backed detection) rely on it. The one exception is `304`: the header
  is omitted — not the would-be size, not `0` (RFC 9110 §15.4.5), both in
  `send` and in the conditional layers (static files, `s200/etag`).
- `html` does **not** escape — `escapeHtml` exists for that, and the
  non-escaping semantics are part of the contract.

### Errors

```ts
httpError(422, 'Invalid article');          // → HttpError (tagged data)
isHttpError(e);                              // structural check, no instanceof
toErrorResponse(e);                          // → the default-mapped Response
throws(401, 404);                            // client-facing error-branch gate
throws({ 422: { issues: string[] } });       // with structured body shapes
```

Errors are tagged data checked structurally, so they survive bundle
boundaries. `httpError(status, message, body?)` carries an optional payload
rendered verbatim; without one the response keeps the `{ error: message }`
envelope. Handlers may throw or **return** them — a returned `HttpError`
takes the exact error-boundary path a thrown one does, and its type infers
the client's error branch (no declaration needed). The `throws` gate is the
declaration channel for branches the type layer cannot see (thrown from
helpers): it merges the statuses (and body shapes) a route may answer with
into `s200/client`'s status-discriminated `res.status` / `res.json()` —
a pure pass-through at runtime for request handling (the declaration is
readable off the gate, which is how `s200/openapi` and `s200/codegen`
pick up the error branches).

### Routing semantics

- Patterns: `:name` params, `:name?` optional segments, terminal `*name`
  wildcard. Duplicate capture names are rejected at registration.
- **Wildcard capture is final-segment-only** — `*name` must be the last
  segment of the pattern (registration throws otherwise); mid-path
  wildcards are outside the matching contract.
- **First registration wins** when several patterns match.
- **`HEAD` falls back to `GET` routes.**
- A path match with no method match answers **`405` with an `Allow` header**
  listing the methods that would have matched (RFC 9110) — middlewares can
  still answer such requests first (a CORS preflight short-circuits).
- **Strict trailing slashes by default**; `strict: false` opts into
  tolerance per app. Optional params are greedy with backtracking
  (`/x/:a?/y` matches `/x/y` and `/x/1/y`), chained optionals resolving
  left-to-right.

### Battery entries

At 1.0 the freeze covers the **core contract above plus the core
entries** — the module surface real apps build on today. Earlier drafts
of this page froze the full ~50-entry map; that was walked back
deliberately: freezing fifty entries before any external usage freezes
unreviewed API. The remaining entries stay on the stable tier below.

#### Frozen at 1.0: core entries

Each independently importable, tree-shakable, zero runtime dependencies.
An existing entry keeps its name and its exported identifiers; option
shapes may gain fields. New batteries may be **added** (a minor).

```
s200                (the core barrel: createApp, registrars, respond
                     helpers, error model, routing)
s200/node  s200/bun  s200/deno  s200/cloudflare          (adapters)
s200/cors  s200/logger  s200/cookies  s200/validate  s200/query
s200/rate-limit  s200/compress  s200/etag  s200/request-id  s200/timeout
s200/websocket  s200/websocket/node  s200/websocket/bun
s200/test  s200/dev
```

#### Stable, not yet frozen

Every other entry below is stable and semantic-versioned, but its surface
may still adjust within minors — each change ships a migration note —
until the entry accrues real-world usage and graduates to the frozen list
(a promotion, itself a minor). The no-silent-break spirit that applies
today and at 1.0:

- Entry names and exported identifiers keep working — nothing is renamed
  or removed under you.
- Option shapes gain fields; within this tier, existing fields are never
  silently repurposed or dropped.
- The behavioral contracts above (the `Ctx` contract, responding,
  errors, routing semantics) apply across every entry — a battery is
  middleware over the same core.

```
s200/route-table  s200/streaming  s200/secure-headers  s200/auth  s200/accepts
s200/serialize  s200/client  s200/csrf  s200/jwt  s200/cache  s200/meta
s200/openapi  s200/trust-proxy  s200/otel  s200/codegen  s200/multipart
s200/session  s200/swagger  s200/upload  s200/lifecycle  s200/health
s200/config  s200/schedule  s200/version  s200/events  s200/als
s200/shard*  s200/gateway*  s200/shard-dev*  s200/executor*  s200/unit-metrics*
```

The five `*`-marked sharding entries are **experimental**: their APIs may
change or be withdrawn in any minor, they are not yet battle-tested in
production, and the thread-executor fast path depends on Node-internal
listener-transfer behavior (Node ≥26.6). See
[Sharding & Scheduling](./guides/sharding.md).

## Semver policy {#semver-policy}

Releases are automated. [`.releaserc.json`](https://github.com/wmzy/s200/blob/main/.releaserc.json) wires
[semantic-release](https://semantic-release.gitbook.io) over conventional
commits on `main`: `fix:` → patch, `feat:` → minor, `BREAKING CHANGE` (footer
or `!`) → major, release notes and the npm/GitHub publishes included. The
`0.0.0-development` version in `package.json` is the placeholder
semantic-release overwrites — versions are never hand-edited.

- **Before 1.0 (0.x):** the semver 0.x allowance is used deliberately.
  **Any minor — and in practice any release — may change behavior**, and a
  change that breaks user code ships with a migration note in its release
  notes. If you need stability before 1.0, pin the exact version.
- **1.0 and after:** strict semver. The
  [frozen surface](#frozen-surface-the-10-contract) — the core contract
  plus the core entries — changes only in majors. The remaining entries
  are stable and semantic-versioned but may adjust within minors with
  migration notes; experimental entries (the sharding layer) may change
  or be withdrawn in any minor. New capabilities land as minors, fixes as
  patches.
- **Deprecation rhythm (post-1.0):** a deprecation is announced by marking
  the API (`@deprecated` JSDoc + README) with a migration guide, stays
  functional for **two minor releases**, and is then removed — removals land
  in a major.

## Not yet frozen

An honest list. These areas may still change within minors, including
before the 1.0 cutover:

- **Light mode details** — `serve(app, { light: true })` in `s200/node` is
  an opt-in fast path with duck-typed request/response objects. The
  *default* Web Standard contract is frozen; the light path's coverage and
  internals may still grow and shift.
- **JSR publishing flow** — `jsr.json` and `pnpm publish:jsr` exist, but
  the published module graph and cadence are not yet pinned.
- **Codegen output format** — `generateClient(app)` emits a standalone
  TypeScript module today; the emitted shape may change (it is generated
  code — regenerate rather than hand-edit).

## Migration guides & extensions

- [Migrating from Express](./migration-from-express.md)
- [Migrating from Koa](./migration-from-koa.md)
- [Migrating from Hono](./migration-from-hono.md)
- [Authoring batteries](https://github.com/wmzy/s200/blob/main/docs/guides/battery-authoring.md) — the
  conventions new modules follow, including the type brands that flow into
  `s200/client`.
