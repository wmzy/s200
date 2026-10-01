# Batteries

Opt-in modules in separate package entries — importing one pulls only it, the core stays lean. Two shapes recur across the surface: **gates** answer in place (`401` / `403` / `429` …) and the chain below never runs, while **unwind stampers** write headers after `await next()` — where the response always exists, fallbacks and error responses included, because they are materialized inside the chain.

```ts
import { cors } from 's200/cors';                          // 0.58 kB gz, zero runtime imports
import { basicAuth, bearerAuth } from 's200/auth';
import { rateLimit } from 's200/rate-limit';
import { stream, streamSSE } from 's200/streaming';
```

## Security

### Auth

`s200/auth` — `basicAuth` / `bearerAuth` gates: the injected `verify` function decides, failures answer `401` + `WWW-Authenticate` in place, and the chain below never runs.

Full reference: [auth — Batteries in the README](https://github.com/wmzy/s200#batteries).

### CSRF

`s200/csrf` — session-less synchronizer tokens, HMAC-signed (nonce + expiry) so only your secret can mint one. Delivered in a cookie; unsafe requests must carry it back in the header/form field **and** match the request `Origin` — both classic double-submit holes closed. The token lives on `ctx.state.csrfToken`, `csrf.token(ctx)` echoes it into server-rendered forms, and unsafe misses answer `403` in place.

Full reference: [csrf — Batteries in the README](https://github.com/wmzy/s200#batteries).

### JWT

`s200/jwt` — HS/RS/PS/ES × 256/384/512 over WebCrypto, zero dependencies. `verifyJwt` rejects `alg:none` unconditionally, enforces `exp`/`nbf`, checks `aud`/`iss` on request, and the key family must match the header algorithm — the key-confusion attack is structurally closed. `jwtAuth` is the gate (payload on `ctx.state.jwt`, `401` in place), taking keys from a secret, a `CryptoKey`, a JWK, a cached JWKS endpoint, or a custom `keyResolver`.

Full reference: [jwt — Batteries in the README](https://github.com/wmzy/s200#batteries).

### Secure headers

`s200/secure-headers` — a safe-by-default baseline stamped on the unwind, fallback responses included: nosniff, `DENY` framing, strict-origin-when-cross-origin. Handlers' own headers always win, `false` drops one, HSTS is opt-in.

Full reference: [secure headers — Batteries in the README](https://github.com/wmzy/s200#batteries).

### Rate limit

`s200/rate-limit` — a true sliding window per client key: every hit expires `windowMs` after it landed, so window edges can't burst. The over-limit request is answered in place with `429` + `Retry-After` and the chain below never runs. The default key reads `x-forwarded-for` (only meaningful behind a proxy that overwrites it — pass `key` for any other identity); counters are in-process, so inject a Redis-INCR-shaped `store` for limits shared across instances.

Full reference: [rate limit — Batteries in the README](https://github.com/wmzy/s200#batteries).

## Negotiation & caching

### CORS

`s200/cors` — app-level or per-route. Preflights are answered in place with a 204 (the handler never runs); actual responses get the allow-origin headers stamped on the unwind — fallback 404/405/500 included. The default `'*'` emits the literal wildcard; allowlists and resolvers reflect the request origin and set `Vary: Origin`. Browsers refuse credentialed wildcards (fail-closed) — pair `credentials` with an explicit origin.

Full reference: [cors — Batteries in the README](https://github.com/wmzy/s200#batteries).

### Accepts

`s200/accepts` — RFC 9110 content negotiation over `Accept` / `Accept-Encoding` / `Accept-Language`: q-values, wildcards, prefix ranges, and the specific-q=0-overrides-wildcard precedence. `accepts(ctx).type(['application/json', 'text/html'])` picks the winner.

Full reference: [accepts — Batteries in the README](https://github.com/wmzy/s200#batteries).

### ETag

`s200/etag` — stamps a weak (or strong) SHA-1 entity tag on byte-backed responses and answers `If-None-Match` hits with 304. Byte-backed means an explicit `content-length`: s200's respond helpers set it, a bare `new Response('…')` needs it set by hand. Chunked/streamed responses are skipped, not buffered.

Full reference: [etag — Batteries in the README](https://github.com/wmzy/s200#batteries).

### Cache

`s200/cache` — response cache with TTL + LRU-ish eviction and a bounded body size. Safe by default: GET/200-only, `Set-Cookie` responses never stored, `Authorization` requests never served, `Cache-Control: no-cache` forces a pass. The default store is in-process; a custom `store` (`get`/`set`/`delete` over `{ exp, status, headers, body }` entries) shares the cache across instances — expiry is still checked by the middleware on every read.

Full reference: [cache — Batteries in the README](https://github.com/wmzy/s200#batteries).

### Compress

`s200/compress` — gzip/deflate via the Web Standard `CompressionStream` (no `node:zlib` — works on Node 18+, Bun, Deno), plus opt-in brotli through an injected encoder (`s200/node` ships `brotliCompress`). Negotiates `Accept-Encoding` q-values, skips bodyless/already-encoded/`no-transform` responses and small bodies (when a content-length is known), and maintains `Vary: Accept-Encoding`. Brotli is a buffered path — byte-backed responses only; streamed responses fall back to gzip/deflate.

Full reference: [compress — Batteries in the README](https://github.com/wmzy/s200#batteries).

### Trust proxy

`s200/trust-proxy` — corrects `ctx.url`'s protocol/host from `X-Forwarded-Proto`/`X-Forwarded-Host` and records the client address in `ctx.state.proxy`, with hop counting for `X-Forwarded-For`. Register it before `s200/csrf`, `s200/secure-headers`, and anything that builds absolute URLs.

Full reference: [trust proxy — Batteries in the README](https://github.com/wmzy/s200#batteries).

## Observability

### Logger

`s200/logger` — one line per request (`ISO-time METHOD path status duration`) through a pluggable `sink`/`format`. The status is always the real one — fallbacks **and error responses** are materialized inside the chain, so the logger sees every request, including 500s.

Full reference: [logger — Batteries in the README](https://github.com/wmzy/s200#batteries).

### Request ID

`s200/request-id` — the canonical correlation id per request (`ctx.state.requestId`), honoring incoming ids and stamping them on responses — error responses included. Defaults to `x-request-id`; `header` and `generator` are options.

Full reference: [request id — Batteries in the README](https://github.com/wmzy/s200#batteries).

### OTel

`s200/otel` — `trace()` is an OpenTelemetry-compatible span middleware over duck-typed `Tracer`/`Span` interfaces (zero deps — bridge to `@opentelemetry/api` with a lambda). The span observes the real status of every request — handler, 404/405 fallback, and mapped 500 alike — because responses materialize inside the chain; rejections are recorded as exceptions and rethrown.

Full reference: [otel — Batteries in the README](https://github.com/wmzy/s200#batteries).

### Timeout

`s200/timeout` — races the chain against a deadline; a late handler gets `503 {"error":"Request timeout"}`, and since the deadline also aborts `ctx.signal`, cooperating work (body reads, downstream fetches) stops instead of running to completion in the background.

Full reference: [timeout — Batteries in the README](https://github.com/wmzy/s200#batteries).

### Versioning

`s200/version` — `apiVersion` is a versioning gate (header or Accept media-type strategy; URI versioning is just `mount`). The resolved version lands on `ctx.state.version`; unsupported versions answer `404` in place, and the unwind stamps `Vary` so caches key on the version.

Full reference: [versioning — Batteries in the README](https://github.com/wmzy/s200#batteries).

## Operations

The application-lifecycle layer — graceful shutdown, probes, config, jobs, and events, the NestJS lifecycle surface in data + functions form.

### Lifecycle

`s200/lifecycle` — signal-driven graceful shutdown over any adapter's `serve()` result: flip the readiness gate first (traffic stops arriving), stop listening, drain in-flight requests within a budget (hard-killing stragglers on deadline or a second signal), then run `onShutdown`. Runtime dispatch is duck-typed — node and Bun take their native graceful paths.

Full reference: [lifecycle — Batteries in the README](https://github.com/wmzy/s200#batteries).

### Health

`s200/health` — `health()` is the liveness probe; `readiness(checks)` runs injectable checks concurrently (each with its own timeout budget and the request's `ctx.signal`) and answers `200`/`503` naming every check's outcome. `createGate()` is the composable switch that flips readiness off the moment a drain starts.

Full reference: [health — Batteries in the README](https://github.com/wmzy/s200#batteries).

### Config

`s200/config` — `parseEnv` (pure `.env` parser) plus `createConfig`: Standard-Schema-typed, fail-fast validation that throws **one** `Error` aggregating every issue at boot. I/O stays injected — the parser takes text, you read the file.

Full reference: [config — Batteries in the README](https://github.com/wmzy/s200#batteries).

### Schedule

`s200/schedule` — `createScheduler` runs cron (5-field) and interval jobs with absolute-time re-arming (no drift), concurrency 1 per job, injectable clock, and a `stop()` that awaits in-flight runs — wire it into `onShutdown`. `nextRun(expr, from)` is the pure matcher.

Full reference: [schedule — Batteries in the README](https://github.com/wmzy/s200#batteries).

### Events

`s200/events` — `createBus` is a typed event bus over [`@for-fun/event-emitter`](https://www.npmjs.com/package/@for-fun/event-emitter) (the one battery with a dependency): keys, listener args, and emit arguments all narrow by the declared event map. `emit` is synchronous error-collecting (library semantics); `emitAsync` awaits promise-returning listeners and routes rejections through the same `onError` channel.

Full reference: [events — Batteries in the README](https://github.com/wmzy/s200#batteries).

## Data & tooling

### Validate

`s200/validate` — wraps your parse function (zod/valibot/typebox/hand-rolled — s200 stays dependency-free and just calls it) as a gate middleware; the parsed value lands on `ctx.state.validated`. The parse function decides the failure mode — a thrown error rejects the chain like any middleware error; `jsonBody`'s `readJson` rejects invalid JSON with a 400 before the schema ever runs. `jsonBody(parse)` also brands the route with the parse return type, feeding `s200/client`'s body typing.

Full reference: [validate — Batteries in the README](https://github.com/wmzy/s200#batteries).

### Query

`s200/query` — the query-string twin of validate: `parseQuery(ctx)` turns the query into a plain record (repeated keys collect into arrays — `?tag=a&tag=b` → `['a','b']`), `queryParams` wraps a schema around it as a gate, and `QueryOf<'page&tag'>` types a query-string literal at compile time.

Full reference: [query — Batteries in the README](https://github.com/wmzy/s200#batteries).

### Serialize

`s200/serialize` — `serialize(schema)` compiles a serializer for a JSON-Schema-shaped subset (objects, arrays, primitives, `nullable`); `jsonRaw` writes the result as a response with an exact `content-length`. The payoff is the declared shape, not raw speed: the output carries exactly the declared keys (an internal field can never leak) and the schema drives the input type at compile time. It is a serialization shape, not a validator — type mismatches aren't checked; `NaN`/`Infinity` serialize as `null`.

Full reference: [serialize — Batteries in the README](https://github.com/wmzy/s200#batteries).

### Route table

`s200/route-table` — the `data + functions` payoff: the app is plain data, so `createRouteTable(app)` exports it as JSON without executing anything (`method`, `pattern`, `params`, `middlewareCount` per route). Handy for route listing or cross-language translation — and `s200/openapi` builds on the same table.

Full reference: [route table — Batteries in the README](https://github.com/wmzy/s200#batteries).

### OpenAPI

`s200/openapi` (+ `s200/meta`) — the route table is the API surface, so the OpenAPI 3.1 document comes out of it directly: `describeApp` names the API, `describeRoute` annotates (summary, tags, query/body schemas, response shapes), `openapiSpec` emits the spec — and unannotated routes still appear with their params and a bare 200.

Full reference: [openapi — Batteries in the README](https://github.com/wmzy/s200#batteries).

### API docs page

`s200/swagger` — `swaggerUi(ctx, { url })` serves the Scalar API Reference page for your OpenAPI spec (assets load from a pinned CDN, so s200 stays zero-dependency); `title`, `theme`, and a self-hosted `cdn` are options, and every interpolated value is HTML-escaped.

Full reference: [openapi — Batteries in the README](https://github.com/wmzy/s200#batteries).

### Codegen

`s200/codegen` — `generateClient(app)` emits a standalone TypeScript client module from the runtime route table: one typed method per route with `ParamsOf<'…'>` args, methods baked in, only a types-only import left. Response bodies stay `Response` (runtime data carries no body types) — useful for handing consumers of any stack a typed caller without shipping s200.

Full reference: [codegen — Batteries in the README](https://github.com/wmzy/s200#batteries).

### Client

`s200/client` — a type-safe fetch client derived from the app's own route table: paths are restricted to registered pattern literals, params are typed from them (`:id` required, `:id?` optional, `*path` kept slash-joined), and a `query` option builds the search string. Typing flows from the registrars' return types — thread the returns (`const b = get(a, …)`) to keep the route log; gate brands (`jsonBody`, `queryParams`) type request bodies and queries, and `json(ctx, data)` handlers carry typed response bodies. Malformed calls throw synchronously; any server speaking the same patterns answers.

Full reference: [client — Batteries in the README](https://github.com/wmzy/s200#batteries).

### Testing

`s200/test` — drives the app without a network: `request(app, '/users/1')` is `handle()` with full fallback semantics (hono's `app.request()` shape); `testClient(app)` is a `createClient` whose fetch routes in-process, keeping the typed paths/params/bodies; `probeApp(app)` dispatches every registered route with synthesized params and reports `{ method, pattern, status, ok }` — a mechanical "no route 500s" contract test.

Full reference: [testing — Batteries in the README](https://github.com/wmzy/s200#batteries).

## Transport

### WebSocket

`s200/websocket` (+ `s200/websocket/node`, `s200/websocket/bun`) — `upgradeWebSocket(app, pattern, handler)` registers a ws route with router pattern syntax; the handler gets a `send`/`close`/`onMessage`/`onClose`/`onError` socket plus a request-shaped `ctx` (params/query/url). Node wires a zero-dependency RFC 6455 server through the adapter's `upgrade` option — handshake, text/binary with fragmentation, ping/pong, close handshake, a `maxPayload` budget, opt-in subprotocol negotiation and permessage-deflate, a heartbeat surface; Bun plugs into `Bun.serve` through the bridge.

Full reference: [websocket — Batteries in the README](https://github.com/wmzy/s200#batteries).

### Streaming

`s200/streaming` — `stream` serves push-driven chunks; `streamSSE` frames Server-Sent Events with backpressure-aware writes and a `writer.heartbeat()` helper.

Full reference: [streaming — Batteries in the README](https://github.com/wmzy/s200#batteries).

### Cookies

`s200/cookies` — read, write, and sign as pure functions. Writing appends a proper `Set-Cookie` header (repeat calls stay separate headers, never comma-joined); call it once the response exists — the natural spot is the unwind, after `await next()`. Signed cookies carry an HMAC partner (`sid.sig`); `getSignedCookie` returns `undefined` unless verified.

Full reference: [cookies — Batteries in the README](https://github.com/wmzy/s200#batteries).

### Session

`s200/session` — `createSession({ secret, store? })` returns a middleware (plus `close()` for the default store's sweeper): signed-cookie sessions with pluggable storage (`get`/`set`/`delete`, TTL passed to `set` — the Redis `SET … EX` shape; default in-process with lazy expiry). The client only ever holds an opaque signed id; tampered, missing, or expired ids all look identical — a fresh empty session, never an error. Mutations persist and (re)issue the cookie on the unwind; `destroy()` deletes from the store and expires the cookie; read-only requests write nothing.

Full reference: [cookies — Batteries in the README](https://github.com/wmzy/s200#batteries).

### Uploads

`s200/upload` — `uploadForm(ctx, sink, options)` lands multipart uploads over `streamForm`: fields collect with parseQuery semantics (single `string`, repeats `string[]`), file parts pass `accept` (415), `maxFiles`/`maxFileSize` (413, naming the constraint) before your injected sink — disk is a one-line `node:fs/promises` `writeFile` away. The sink's return string becomes the file's `id`; a throwing sink aborts the upload. File parts are buffered per-part — huge files stay on `streamForm`.

Full reference: [batteries — README](https://github.com/wmzy/s200#batteries).
