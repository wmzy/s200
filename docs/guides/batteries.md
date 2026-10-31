# Batteries

Opt-in modules in separate entries — importing one pulls only it, the core stays lean.

## The entries

```ts
import { cors } from 's200/cors';           // 0.58 kB gz, zero runtime imports
import { logger } from 's200/logger';
import { createRouteTable } from 's200/route-table';
import { getCookie, setCookie, getSignedCookie, setSignedCookie } from 's200/cookies';
import { validate, jsonBody } from 's200/validate';
import { parseQuery, queryParams } from 's200/query';
import { rateLimit } from 's200/rate-limit';
import { compress } from 's200/compress';
import { stream, streamSSE } from 's200/streaming';
import { requestId } from 's200/request-id';
import { als, currentCtx } from 's200/als';
import { timeout } from 's200/timeout';
import { upgradeWebSocket } from 's200/websocket';
import { createUpgradeHandler } from 's200/websocket/node';
import { createBunWebSocketBridge } from 's200/websocket/bun';
import { createCloudflareWebSocketBridge } from 's200/websocket/cloudflare';
import { etag } from 's200/etag';
import { secureHeaders } from 's200/secure-headers';
import { basicAuth, bearerAuth } from 's200/auth';
import { accepts } from 's200/accepts';
import { serialize, jsonRaw } from 's200/serialize';
import { responseCheck } from 's200/response-check';
import { createClient } from 's200/client';
import { createCsrf } from 's200/csrf';
import { describeRoute, describeApp } from 's200/meta';
import { openapiSpec, openapiJson } from 's200/openapi';
import { toolManifest, createMcpHandler } from 's200/mcp';
import { signJwt, verifyJwt, jwtAuth } from 's200/jwt';
import { cache } from 's200/cache';
import { trustProxy } from 's200/trust-proxy';
import { createHandler } from 's200/cloudflare';
import { trace } from 's200/otel';
import { generateClient } from 's200/codegen';
import { request, testClient, probeApp } from 's200/test';
import { streamForm } from 's200/multipart';
import { createSession } from 's200/session';
import { swaggerUi } from 's200/swagger';
import { uploadForm } from 's200/upload';
import { lifecycle } from 's200/lifecycle';
import { health, readiness, createGate } from 's200/health';
import { parseEnv, createConfig } from 's200/config';
import { createScheduler, nextRun } from 's200/schedule';
import { createBus } from 's200/events';
import { apiVersion } from 's200/version';
import { policy, shardSpecs, shardApp, matchShard } from 's200/shard';
import { nginxConf, gatewayRoutes, albRules } from 's200/gateway';
import { createDispatcher } from 's200/shard-dev';
import { runShards } from 's200/executor';
import { createUnitMetrics, unitMetricsEndpoint } from 's200/unit-metrics';
import { loadShed } from 's200/load-shed';
import { createCircuitBreaker, breakerCall } from 's200/circuit-breaker';
```

## CORS

App-level or per-route. Preflights are answered in place with a 204 (the handler never runs); actual responses get the allow-origin headers stamped on the unwind — fallback 404/405/500 responses included, since they are materialized inside the chain:

```ts
use(app, cors({ origin: 'https://app.example', credentials: true }));
use(app, cors({ origin: ['https://a.example'], maxAge: 600, exposeHeaders: ['x-request-id'] }));
```

The default `'*'` origin emits the literal wildcard; allowlists and resolvers reflect the request origin and set `Vary: Origin`. Browsers refuse credentialed wildcard origins (fail-closed) — pair `credentials` with an explicit origin. `exposeHeaders` emits `Access-Control-Expose-Headers` so page scripts can read custom response headers.

## Logger

One line per request (`ISO-time METHOD path status duration`) through a pluggable `sink`/`format`. The status is always the real one — fallbacks **and error responses** are materialized inside the chain, so the logger sees every request, including 500s.

## Route table

The `data + functions` payoff: the app is plain data, so it exports as JSON without executing anything:

```ts
createRouteTable(app);
// { routes: [{ method: 'GET', pattern: '/users/:id', params: ['id'], middlewareCount: 1 }, …] }
```

Handy for route listing or cross-language translation — and `s200/openapi` builds the OpenAPI 3.1 document from the same table (see below).

## OpenAPI

The route table is the API surface, so the OpenAPI 3.1 document comes out of it directly: `describeRoute` annotates (summary, tags, query/body schemas in the `SerializeSchema` DSL, response shapes), `openapiSpec` emits the spec, and unannotated routes still appear with their params and a bare 200. Schemas that occur ≥2 times (structural JSON equality) are hoisted into `components.schemas` and referenced with `$ref`s — named by the schema's optional `title`, else `Schema1`, `Schema2`, … in first-occurrence order (`refSchemas: false` keeps everything inline). A query entry may mark itself required (`query: { format: { schema: { type: 'string' }, required: true } }`): the spec emits `parameters[].required: true` and the gate below rejects the key's absence — the two views stay isomorphic.

```ts
describeApp(app, { title: 'Users API', version: '1.0.0' });
describeRoute(app, 'GET', '/users/:id', {
  summary: 'Fetch one user',
  responses: { 200: { description: 'ok',
    schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } } },
});
get(app, '/openapi.json', (ctx) => openapiJson(ctx, app));   // serve the spec
```

The same annotations can become runtime gates: `withRouteValidation(app)` is a pure data transform (mount's family) that rebuilds only the routes carrying a `body`, `query`, `params` or `headers` annotation, checking requests with `compileValidator` from `s200/serialize` — the read-side twin of `serialize()`, covering exactly the same DSL subset. A violation answers `422` naming every offending path — `error` keeps the first (`{"error":"body.tags.1: expected string, got number"}`) while the body's `issues` array carries the full list, built by the `validationError` helper shared with `s200/validate`; valid input flows on untouched — nothing lands on `ctx.state` and nothing is coerced (query values stay strings, so `?page=2` against `{ type: 'integer' }` is a 422 — use `s200/query`'s `queryParams` when you want parsing). The spec and the gates share one source: annotations are re-attached to the rebuilt routes, so `openapiSpec(gated)` keeps documenting them. Annotate mounted sub-apps on the parent after `mount` (the metadata registry keys by route identity).

`headers`/`cookies` entries annotate request headers and cookies the same way (`in: 'header'`/`in: 'cookie'`) — headers gate at runtime exactly like `query` (`'headers.<name>: …'`), cookies stay spec-only (cookie parsing belongs to `s200/cookies`). `body: { form: … }` documents a `multipart/form-data` request: text parts through the `SerializeSchema` DSL, file parts (`{ file: true, contentTypes? }`) as `{ type: 'string', format: 'binary' }` with `encoding` entries — the spec's standard file shape, and the one `format` s200 ever emits (from the explicit marker, never from schema conversion). The gate documents multipart bodies without reading them — runtime validation stays with `s200/multipart`/`s200/upload`. The emitted spec feeds any OpenAPI toolchain, s200's own clients optional: `openapi-typescript` for zero-runtime types, `openapi-generator` for Python/Go SDKs — see the [API reference](/api/openapi) for the full shape and the non-TypeScript clients section.

Pair the spec with a documentation UI — `swaggerUi` serves the Scalar API Reference page (assets load from a pinned CDN, so s200 stays zero-dependency):

```ts
import { swaggerUi } from 's200/swagger';
get(app, '/docs', (ctx) => swaggerUi(ctx, { url: '/openapi.json', title: 'Users API' }));
```

## MCP

The route table is also the tool list: the same `describeRoute` annotations compile into MCP tool definitions (`toolManifest` — inputs straight from the `SerializeSchema` DSL), and `createMcpHandler` answers the stateless JSON-RPC subset (`initialize`/`tools/list`/`tools/call`, notifications → `202`). Every call round-trips through `handle`, so auth, rate limits, and validation gates still run per tool invocation. Zero dependencies, no sessions, no SSE stream, no `Mcp-Session-Id`; batch arrays are rejected (`-32600` — the spec removed batching in `2025-06-18`):

```ts
import { createMcpHandler } from 's200/mcp';
const mcpHandler = createMcpHandler(app);
post(app, '/mcp', (ctx) => mcpHandler(ctx.req));
```

Unannotated routes stay out by default — `toolManifest(app, { includeUnannotated: true })` exposes them too. Tool names follow a documented slug rule (`GET /users/:id` → `get_users__id`); see the [MCP API page](/api/mcp) for the full contract and the `@modelcontextprotocol/sdk` escape hatch.

## Cookies

Read, write, and sign as pure functions. Writing appends a proper `Set-Cookie` header (repeat calls stay separate headers, never comma-joined); call it once the response exists — the natural spot is the unwind, after `await next()`:

```ts
use(app, async (ctx, next) => {
  await next();
  setCookie(ctx, 'theme', 'dark', { httpOnly: true, sameSite: 'lax', maxAge: 86400 });
});
get(app, '/theme', async (ctx) => json(ctx, { theme: getCookie(ctx, 'theme') }));
await setSignedCookie(ctx, 'sid', userId, SECRET);       // + sid.sig HMAC partner
const sid = await getSignedCookie(ctx, 'sid', SECRET);   // undefined unless verified
```

## Sessions

`createSession({ secret, store? })` returns a middleware (plus `close()` for the default store's sweep timer). The client only ever holds an opaque signed id (HMAC via the cookies battery — one signing convention framework-wide); data lives server-side, in the pluggable `store` (`get`/`set`/`delete`, TTL passed to `set` — the Redis `SET … EX` shape; default is an in-process map with lazy expiry). Tampered, missing, or expired ids all look identical: a fresh empty session, never an error. Mutations (`set`/`delete`/`clear`/`touch`) persist and (re)issue the cookie on the unwind; `destroy()` deletes from the store and expires the cookie; read-only requests write nothing:

```ts
const { middleware } = createSession({ secret: SECRET, cookie: { maxAge: 3600 } });
use(app, middleware);
get(app, '/', (ctx) => {
  const session = ctx.state.session as Session;
  session.set('user', 'alice');            // persisted + cookie issued on unwind
  return json(ctx, { visits: session.get('visits') });
});
```

## Config

Typed, fail-fast configuration over the same Standard Schema channel `s200/validate` uses (nest's `@nestjs/config`, zero-dep): `parseEnv` is a pure `.env` parser (comments, blank lines, `export ` prefix, quoted values with escapes, duplicate keys last-wins; no multi-line values), and `createConfig` validates the merged record at construction. Validation failure throws **one** `Error` aggregating every issue, so a bad deploy dies at boot with the full list, not the first:

```ts
import { parseEnv, createConfig } from 's200/config';

const schema = { /* Standard Schema: input strings, output coerced */ };
const { valid } = createConfig(schema, { ...parseEnv(await readFile('.env', 'utf8')), ...process.env });
// valid: schema.types.output — fully typed from here on
```

Env values arrive as strings — declare the schema's input side as strings and coerce in the output (input ≠ output inference, same as `jsonBody`). I/O stays injected: `parseEnv` takes text, you read the file (the core never touches a filesystem).

## Validate

Wraps your parse function (zod/valibot/typebox/hand-rolled — s200 stays dependency-free and just calls it) as a gate middleware; the parsed value lands on `ctx.state`:

```ts
post(app, '/articles', jsonBody(ArticleSchema.parse), (ctx) => {
  json(ctx, { saved: ctx.state.validated });
});
```

Standard Schema values work without a wrapper: anything carrying a `~standard` prop (zod, valibot, typebox, arktype…) can be handed to `jsonBody`/`queryParams` directly. The gate calls `validate()` on the parsed body/record — any reported issue becomes a `422 HttpError` whose body carries the full list with formatted paths (`error` keeps the first message, `issues: [{ "path": "user.tags[0]", "message": "…" }]`); an empty `issues` array counts as success. The schema's phantom `types` prop types both sides for free: `types.input` is what the caller sends (`jsonBody(schema)` demands and types the client's `init.body`, `queryParams(schema)` brands `init.query` the same way — the input side, so transforming schemas are honest end to end), while the parsed `types.output` product lands on `ctx.state.validated` for the handler; `standardValidate(schema, data)` exports the identical 422 semantics for your own gates.

## Query

The query-string twin of `validate`: `parseQuery(ctx)` turns the query into a plain record (repeated keys collect into arrays), `queryParams` wraps a schema around it as a gate, and `QueryOf<'page&tag'>` types a query-string literal at compile time:

```ts
get(app, '/list', queryParams((q) => ({
  page: Number(q.page ?? 1),
  tags: q.tag ?? [],                    // repeated ?tag=a&tag=b → ['a','b']
})), (ctx) => json(ctx, ctx.state.validated));
```

## WebSocket

`upgradeWebSocket(app, pattern, ...middlewares, handler)` registers a ws route (router pattern syntax, first registration wins) — the same variadic `...middlewares, handler` shape as the HTTP registrars, for route-scoped gates; the handler gets a `send`/`close`/`onMessage`/`onClose`/`onError` socket plus a request-shaped `ctx` (params/query/url). Upgrades run the app's `use(app, …)` middleware chain and the route's middlewares before the handshake completes: a middleware that writes `ctx.res`, returns a `Response`, or throws (mapped like HTTP — `HttpError` → status + envelope) rejects the upgrade, and that HTTP response is answered instead of `101`; on approval `ctx.state` mutations ride into the handler and unwinding middlewares see `res: undefined` — the socket is the response (details in the [WebSocket API](../api/websocket.md#middleware--auth-on-upgrades)). Node wires a zero-dependency RFC 6455 server through the adapter's `upgrade` option — plain `ws://`, or `wss://` by pairing `upgrade` with `https` (only `http2: true` excludes it); Bun plugs into `Bun.serve` through the bridge:

```ts
import { upgradeWebSocket } from 's200/websocket';
import { createUpgradeHandler } from 's200/websocket/node';   // node
import { createBunWebSocketBridge } from 's200/websocket/bun'; // bun

upgradeWebSocket(app, '/chat/:room', (socket, ctx) => {
  socket.onMessage((data) => socket.send(`[${ctx.params.room}] ${data}`));
});

await serve(app, { port: 3000, upgrade: createUpgradeHandler(app) });            // node
serve(app, { port: 3000, websocket: createBunWebSocketBridge(app) });            // bun
// workers: ws.upgrade(request) ?? createHandler(app).fetch(…) — see the WebSocket API page
```

The node server implements the protocol — handshake, text/binary with fragmentation, ping/pong, close handshake, a `maxPayload` budget (default 4 MiB, 1009 beyond it, enforced at frame-header time) — plus opt-in subprotocol negotiation and permessage-deflate (RFC 7692, no-context-takeover both ways), and a heartbeat surface (`socket.ping()` / `socket.onPong()`):

```ts
upgradeWebSocket(app, '/graphql', (socket) => socket.onMessage(handle),
  { protocols: ['graphql-ws', 'graphql-transport-ws'], perMessageDeflate: true });
// socket.protocol carries the negotiated subprotocol; bun negotiates it too
```

## ETag

Stamps a weak SHA-1 entity tag on byte-backed responses and answers `If-None-Match` hits with 304. Byte-backed means an explicit `content-length` — s200's respond helpers (`json`/`text`/`html`/`send`) set it, and a bare `new Response('…')` needs it set by hand (platforms serialize content-length lazily). Chunked/streamed responses (SSE, `s200/streaming`) are skipped, not buffered:

```ts
use(app, etag());                    // W/"…" by default
use(app, etag({ strong: true }));    // "…"
```

## Secure headers

A safe-by-default baseline stamped on the unwind (fallback responses included); handlers' own headers always win, and `false` drops one:

```ts
use(app, secureHeaders());  // nosniff, DENY framing, strict-origin-when-cross-origin
use(app, secureHeaders({ strictTransportSecurity: 'max-age=31536000' }));  // HSTS is opt-in
```

`contentSecurityPolicy: { nonce: true, policy }` wires the per-request nonce automatically — a fresh `cspNonce()` parks on `ctx.state.cspNonce` for the markup, and every `{{nonce}}` placeholder in the policy is spliced in when the header lands (`reportOnly: true` for the report-only variant):

```ts
use(app, secureHeaders({
  contentSecurityPolicy: { nonce: true, policy: { 'script-src': ["'nonce-{{nonce}}'"] } },
}));
```

## Auth

`basicAuth`/`bearerAuth` gates: the `verify` function decides, failures throw a 401 `HttpError` with the `WWW-Authenticate` challenge into the error boundary (`onError` included; the default mapping answers `401` + challenge) and the chain below never runs:

```ts
use(app, basicAuth(async (user, pass) => user === 'admin' && (await check(pass))));
use(app, bearerAuth(async (token) => API_TOKEN));
```

Credential comparison inside `verify` is yours — `timingSafeEqual(a, b)` from `s200/cookies` compares constant-time (`false` on a length mismatch).

## OAuth

Authorization Code + PKCE (S256) primitives as pure functions: `createPkcePair()` mints the verifier and its S256 challenge, `randomState()` the unguessable state (or nonce), `buildAuthorizeUrl` renders the redirect (always `code_challenge_method=S256`), and `exchangeCode` redeems the code — HTTP Basic when a `clientSecret` is given, `client_id` in the body otherwise; non-2xx answers throw a 502. `refreshToken` (RFC 6749 §6, the optional scope must not exceed the original grant) and `clientCredentials` (§4.4, confidential clients only) reuse the same client authentication and 502 contract. You own the storage — park state and verifier in signed cookies between redirect and callback. `fetch` is injectable; the OIDC recipe (`recipes/oidc.ts`) composes these end to end:

```ts
const pkce = await createPkcePair();
redirect(ctx, buildAuthorizeUrl(opts, { state, codeChallenge: pkce.codeChallenge }));
// later: refreshToken({ tokenEndpoint, clientId, clientSecret }, { refreshToken: rt });
// machine-to-machine: clientCredentials({ tokenEndpoint, clientId, clientSecret }, { scope: 'orders:read' });
```

## CSRF

Session-less synchronizer tokens: HMAC-signed (`nonce` + expiry) so only your secret can mint one, delivered in a cookie and verified on unsafe requests against the header/form field **and** the request `Origin` (closing both classic double-submit holes). The token lives on `ctx.state.csrfToken`; `csrf.token(ctx)` echoes it into server-rendered forms, and unsafe misses answer `403` in place:

```ts
const csrf = createCsrf({ secret: CSRF_SECRET });   // keep the secret out of version control
use(app, csrf.middleware);
get(app, '/form', (ctx) => html(ctx, `<input type="hidden" name="_csrf" value="${await csrf.token(ctx)}">`));
```

## JWT

HS256/384/512, RS256/384/512, PS256/384/512, ES256/384/512, and EdDSA (Ed25519) over WebCrypto, zero dependencies. `signJwt`/`verifyJwt` take a secret string, a `CryptoKey`, or a JWK; verification rejects `alg:none` unconditionally, enforces `exp`/`nbf`, checks `aud`/`iss` on request, and key families must match the header algorithm (HS needs a secret, RS/PS an RSA key, ES an EC key, EdDSA an Ed25519 OKP key — the confusion attack is structurally closed). `jwtAuth` is the gate, storing the payload on `ctx.state.jwt` and answering `401` before the chain below runs:

```ts
const token = await signJwt({ sub: userId }, JWT_SECRET, { expiresIn: 3600 });
use(app, jwtAuth({ secret: JWT_SECRET }));              // Authorization: Bearer …
get(app, '/me', (ctx) => json(ctx, ctx.state.jwt));

// Key rotation: a JWKS endpoint resolves keys by kid (cached, module-wide).
use(app, jwtAuth({ jwks: 'https://idp.example/.well-known/jwks.json' }));
// …or a custom resolver: jwtAuth({ keyResolver: (header) => … })
```

## Cache

Response cache with TTL + LRU-ish eviction and a bounded body size. Safe by default: GET/200-only, `Set-Cookie` responses are never stored, `Authorization` requests never served, `Cache-Control: no-cache` forces a pass:

```ts
use(app, cache({ ttl: 60, max: 1000 }));
use(app, cache({ store: redisCacheStore }));   // shared store across instances
```

The default store is in-process; a custom `store` (`get`/`set`/`delete` over `{ exp, status, headers, body }` entries) shares the cache across instances — expiry is still checked by the middleware on every read.

`cacheControl({ maxAge, sMaxAge, staleWhileRevalidate, noStore, noCache, private, immutable, mustRevalidate })` builds the `Cache-Control` value for the caches between you and the client — one call, fixed order, `noStore` short-circuiting to exactly `no-store`:

```ts
get(app, '/assets/:f', (ctx) =>
  text(ctx, body, {
    headers: { 'cache-control': cacheControl({ maxAge: 3600, staleWhileRevalidate: 86400 }) },
  })
);
```

## Trust proxy

Corrects `ctx.url`'s protocol/host from `X-Forwarded-Proto`/`X-Forwarded-Host` and records the client address in `ctx.state.proxy`, with hop counting for `X-Forwarded-For`. Register it before `s200/csrf`, `s200/secure-headers`, and anything that builds absolute URLs:

```ts
use(app, trustProxy({ hops: 1 }));   // behind one trusted reverse proxy
```

## Accepts

RFC 9110 content negotiation over `Accept` / `Accept-Encoding` / `Accept-Language`: q-values, wildcards, prefix ranges, and the specific-q=0-overrides-wildcard precedence:

```ts
const want = accepts(ctx);
const type = want.type(['application/json', 'text/html']) ?? 'application/json';
```

## Rate limit

True sliding-window gate per client key: every hit expires `windowMs` after it landed (no fixed boundary, so window edges can't burst), the over-limit request throws a 429 `HttpError` into the error boundary (`onError` included; the default mapping answers `429` + `Retry-After` + IETF `RateLimit-Limit`/`RateLimit-Remaining`/`RateLimit-Reset`), and the chain below never runs:

```ts
use(app, rateLimit({ windowMs: 60_000, limit: 100 }));
```

The default key reads `x-forwarded-for` — only meaningful behind a proxy that overwrites it; pass `key: (ctx) => …` for any other identity (and a `now` clock for tests). The counters live in-process by default — per-instance limits. For shared limits across instances, inject a `store` (atomic `hit(key, now, limit, windowMs) → { count, retryAt }` — the Redis INCR shape).

`skip: (ctx) => boolean` exempts a request entirely — no key computed, no store hit, nothing counted, never blocked (health checks, internal CIDRs).

## Load shedding

Pressure gate on the way in: each configured threshold — `maxEventLoopUtilization` (0..1), `maxRssBytes`, `maxInFlight` — is checked against its sensor, and the first strictly-over dimension sheds: a `503` `HttpError` with `Retry-After` into the error boundary, the handler never runs:

```ts
use(app, loadShed({
  maxEventLoopUtilization: 0.95,
  maxInFlight: 200,
  bypass: (ctx) => ctx.url.pathname === '/healthz',
}));
```

Unconfigured dimensions are never read. The in-flight count is a ledger (incremented on entry, decremented in a `finally`), not a sample. `bypass` exempts a request from both counting and checking — never shed your liveness probes. Every sensor is injectable for tests; compose with `health`'s `createGate` for a coordinated drain. Full contract: [Load shedding](/api/load-shed).

## Circuit breaker

CLOSED → OPEN after `failureThreshold` admitted failures inside `windowMs`; OPEN → HALF_OPEN after `cooldownMs`; half-open admits `probeConcurrency` probes and `successesNeeded` consecutive successes close it. `breakerCall` wraps any async call — the proxy's `proxyRequest` included — and rejects with `503` + `Retry-After` while open:

```ts
const upstream = createCircuitBreaker({ failureThreshold: 5, windowMs: 10_000, cooldownMs: 30_000 });
get(app, '/search', async (ctx) => json(ctx, await breakerCall(upstream, () => proxyRequest(ctx, target))));
```

What counts as a failure is `errorFilter`'s call — the shipped `skipClientErrors` admits 5xx and raw throws, not 4xx. The clock is injectable (`now`), `circuitStatus` snapshots the phase, and `canPass`/`recordSuccess`/`recordFailure` are the no-throw face for custom admission. Full contract: [Circuit breaker](/api/circuit-breaker).

## Serialize

Schema-driven JSON serialization: `serialize(schema)` compiles a serializer for a JSON-Schema-shaped subset (objects, arrays, primitives, `nullable`), and `jsonRaw` writes the result as a response with an exact `content-length`. The payoff is the declared shape, not raw speed — the output carries exactly the declared keys (undeclared ones are dropped, so an internal field can never leak), and the schema drives the input type at compile time. Modern engines' `JSON.stringify` stays competitive on typical payloads, so use it when the shape contract matters, not as a speed hack:

```ts
const toUser = serialize({
  type: 'object',
  properties: { id: { type: 'integer' }, name: { type: 'string' } },
  required: ['id', 'name'] as const,   // as const: the array literal drives optionality
});
get(app, '/users/:id', (ctx) => jsonRaw(ctx, toUser({ id: 1, name: 'ada' })));
```

It is a serialization shape, not a validator: type mismatches are not checked, and `NaN`/`Infinity` serialize as `null` (JSON semantics).

## Response check

The response-side runtime twin of the OpenAPI annotations: `responseCheck(app)` turns `describeRoute`'s `responses[status].schema` into checks the server actually runs, on the unwind, against the materialized response — a mismatch answers `500 {"error":"Response schema mismatch"}` (normal error mapping, `onError` included) instead of letting a lying body ship. JSON byte-backed bodies only; streamed responses are skipped, never buffered; undeclared keys violate (the closed shape `serialize` enforces on output):

```ts
use(app, responseCheck(app));                     // fail: mismatch → 500
use(app, responseCheck(app, {
  onMismatch: 'report',                           // keep the response…
  onIssue: (issues, ctx) => log.warn('drift', { path: ctx.url.pathname, issues }),
}));
```

`details: true` attaches the issue paths to the 500 body — it names internal structure, so keep it out of production. See [the API page](/api/response-check) for the full skip/check contract.

## Compress

Gzip/deflate response compression via the Web Standard `CompressionStream` (no `node:zlib` — works on Node 18+, Bun), plus opt-in brotli through an injected encoder (`CompressionStream` has no brotli; `s200/node` ships `brotliCompress` over `node:zlib`). Negotiates `Accept-Encoding` q-values, skips bodyless/encoded/`no-transform` responses and small bodies (when a content-length is known), and maintains `Vary: Accept-Encoding`:

```ts
use(app, compress({ minBytes: 1024 }));
import { brotliCompress } from 's200/node';
use(app, compress({ minBytes: 1024, brotli: { compress: brotliCompress } }));
```

Brotli is a buffered path — it applies to byte-backed responses only (a declared content-length); streamed responses fall back to gzip/deflate.

## Streaming

`stream` serves push-driven chunks; `streamSSE` frames Server-Sent Events with backpressure-aware writes:

```ts
get(app, '/events', (ctx) => streamSSE(ctx, async (writer) => {
  await writer.writeSSE({ event: 'tick', data: { n } });
  await writer.heartbeat();
}));
```

## Request ID

Canonical correlation id per request (`ctx.state.requestId`), honoring incoming ids and stamping responses — error responses included:

```ts
use(app, requestId());          // x-request-id
use(app, requestId({ header: 'x-trace', generator: () => nanoid() }));
```

## ALS

Ambient ctx access — the opt-in supplement to explicit ctx passing, for call stacks that cannot thread it (logging sinks, deep legacy helpers). `als()` wraps the chain below it in `node:async_hooks`' `AsyncLocalStorage`, and `currentCtx()` resolves the executing request's ctx from anywhere inside that extent — deep awaits, `setTimeout` callbacks, code that never saw a parameter. Interleaved requests stay isolated; outside a request `currentCtx()` is `undefined`. Node/Bun only — Cloudflare Workers has no async_hooks, so importing the entry fails there (keep it out of edge bundles):

```ts
import { als, currentCtx } from 's200/als';

use(app, als());
const ctx = currentCtx();   // the executing request's Ctx, or undefined
```

## Timeout

Races the chain against a deadline; a late handler gets `503 {"error":"Request timeout"}`, and since the deadline also aborts `ctx.signal`, cooperating work (body reads, downstream fetches) stops instead of running to completion in the background:

```ts
use(app, timeout(30_000));
```

## OTel

`s200/otel`'s `trace()` is an OpenTelemetry-compatible span middleware over duck-typed `Tracer`/`Span` interfaces (zero deps — bridge to `@opentelemetry/api` with a lambda). The span observes the real status of every request — handler, 404/405 fallback, and mapped 500 alike — because responses materialize inside the chain; rejections are recorded as exceptions and rethrown:

```ts
import { trace } from 's200/otel';
use(app, trace({ tracer: myOtelTracerBridge, extract: (headers) => … }));
```

`metrics()` is the metrics twin — duck-typed `Meter` (a real `@opentelemetry/api` meter bridges with one lambda), reporting `http.server.requests` (counter), `http.server.active_requests` (+1 before `next()`, −1 in a `finally` — the gauge balances even when the chain throws), and `http.server.request.duration` (histogram, milliseconds). Recordings carry `http.request.method` and `http.response.status_code` — always the materialized status, 404/405/500 included, thanks to the in-chain error boundary. Slice on `status_code >= 500` for errors; `attributes` (record or `(ctx)` callback) spreads over the defaults, and `metrics()` with no options is a bare pass-through:

```ts
use(app, metrics({ meter: myMeterBridge, attributes: (ctx) => ({ 'url.route': ctx.url.pathname }) }));
```

## Events

A typed event bus over [`@for-fun/event-emitter`](https://www.npmjs.com/package/@for-fun/event-emitter) (the one battery with a dependency; everything else stays zero-dep). The emitter is plain data — a `Map` — and every capability is a function over it, so the bus is a thin typed facade: declare your event map once and keys, listener args, and emit arguments are all narrowed by it:

```ts
import { createBus } from 's200/events';

const bus = createBus<{ userCreated: [id: string]; orderPaid: [id: string, cents: number] }>();

const off = bus.on('userCreated', (id) => notify(id));   // id: string
bus.emit('userCreated', 'u_1');                          // sync: all listeners run now
await bus.emitAsync('orderPaid', 'o_9', 4200);           // awaits promise-returning listeners
off();                                                   // unsubscribe
```

## Schedule

Cron and interval jobs, zero-dep (`@nestjs/schedule` equivalent): `nextRun(expr, from)` is a pure 5-field cron matcher (minute hour day month weekday — `*`, `*/n`, `a-b`, lists, `a-b/n`; no `L`/`W`/nicknames), and `createScheduler()` arms jobs with absolute-time re-arming so drift never accumulates (and delays beyond `setTimeout`'s ~24.8-day ceiling re-arm in segments):

```ts
import { createScheduler } from 's200/schedule';

const scheduler = createScheduler({ onError: (err, expr) => log('error', { err, expr }) });
scheduler.interval(30_000, heartbeat);
scheduler.cron('*/5 * * * *', syncJobs);      // invalid expressions throw at registration
scheduler.start();
// stop(): cancels every timer and awaits in-flight runs — wire it into onShutdown
```

A job runs with concurrency 1 — a run still in flight at the next tick is skipped, not queued. Failing jobs go through `onError` (default `console.error`) and never break the loop. The clock is injectable (`now`), registration before `start()` arms everything at once, and a second `start()` throws. Pair with `s200/lifecycle`: `stop()` in `onShutdown`, and re-create the scheduler when `s200/dev` swaps the table (jobs are data too).

## Lifecycle

Signal-driven graceful shutdown (`enableShutdownHooks` + `onApplicationShutdown`, minus the DI): `lifecycle(server, options)` turns the adapter's `serve()` result into an orchestrated drain. The order is the one rolling deploys need: flip readiness off first (the load balancer stops routing), then stop listening, then wait for in-flight requests — hard-killing whatever is left when the budget runs out — and only then run your cleanup hooks:

```ts
import { serve } from 's200/node';
import { lifecycle } from 's200/lifecycle';
import { createGate } from 's200/health';

const gate = createGate();
get(app, '/health/ready', readiness({ db: pingDb, gate: gate.check }));

const server = await serve(app, { port: 3000 });
const done = lifecycle(server, {
  signals: ['SIGTERM', 'SIGINT'],   // default
  timeout: 10_000,                  // drain budget, default 10s
  readiness: gate,                  // closed ('draining') before anything else
  onShutdown: async () => { await db.close(); },
});
await done.stopped;                 // or call done.stop() yourself — same path, idempotent
```

Runtime dispatch is duck-typed (the module stays runtime-agnostic): a raw server with `closeIdleConnections` takes the node path — `close()` to stop accepting, idle keep-alive sockets reaped continuously (a live `fetch` client holds sockets open; a one-shot reap would stall the drain until the deadline), `closeAllConnections()` only after the budget trips. Bun servers route through `stop(false)` (graceful) / `stop()` (force). A second signal during the drain hard-kills immediately. `onShutdown` failures reject `stop()` but never `stopped` — the signal path logs and resolves.

## Health

Liveness/readiness probes over injectable checks (Terminus, zero-dep). A `HealthCheck` is `() => void | Promise<void>` — anything that throws or rejects is unhealthy, with the message as the reason:

```ts
import { health, readiness, createGate } from 's200/health';

get(app, '/health/live', health());                        // 200 {"status":"ok"} — the process answers
get(app, '/health/ready', readiness({
  db: () => db.ping(),                                     // runs concurrently, each with its own budget
  cache: () => redis.ping(),
}));                                                       // 200 {"status":"ok","checks":{"db":"ok","cache":"ok"}}
```

Any failing check turns the response into a `503` naming every check's outcome (`{"status":"fail","checks":{"db":"connection refused"}}`) — healthy peers still report `"ok"`. Each check races a per-check budget (default 1000ms; `timeout` option) **and** the request's `ctx.signal`, so a disconnecting probe client cancels the checks. `createGate()` is the composable switch for lifecycle wiring: `gate.check` throws when closed (`gate.close('draining')` / `gate.open()`), so readiness flips false the moment a shutdown starts.

## Versioning

`apiVersion(options)` is a versioning gate (NestJS's header / media-type strategies; URI versioning is just `mount(app, '/v1', …)`). Requests resolve a version — from a header (`x-api-version` by default) or from `application/vnd.<name>+json;version=1` Accept entries — and stamp it on `ctx.state.version` before `next()`:

```ts
import { apiVersion } from 's200/version';

use(app, apiVersion({ versions: ['1', '2'], default: '1' }));   // header strategy
use(app, apiVersion({ strategy: 'mediaType', mediaType: 'vnd.api', versions: ['1', '2'] }));
```

A carried version outside the list answers `404 API version not supported: v9` in place (the handler never runs); a missing version falls back to `default`, or answers `404 API version required` when there is none. The unwind stamps `Vary` (`x-api-version`, or `Accept` for the media-type strategy) so caches key on the version.

## Testing

`s200/test` drives the app without a network: `request(app, '/users/1')` is `handle()` with full fallback semantics (hono's `app.request()` shape); `testClient(app)` is a `createClient` whose fetch routes in-process, keeping the typed paths/params/bodies; `probeApp(app)` dispatches every registered route with synthesized params and reports `{ method, pattern, status, ok }` — a mechanical "no route 500s" contract test:

```ts
import { request, testClient, probeApp } from 's200/test';
const res = await request(app, '/users/1');
const rows = await probeApp(app);        // [{ method: 'GET', pattern: '/users/:id', status: 200, ok: true }, …]
```

## Codegen

`s200/codegen`'s `generateClient(app)` emits a standalone TypeScript client module from the runtime route table (the `data` in data + functions): one typed method per route, a self-contained path-fill/query helper, methods baked in — and no imports at all (the module declares its own `ClientInit`, path filler and query helper, so it stays dependency-free). Params come from each pattern; `init.query` and `init.body` come from the `s200/meta` annotations, and the response type from `meta.responses` merged with the `throws()` gates — a route that declares neither keeps the bare `Promise<Response>`, while a `throws()`-only route gains a `Branch<200, unknown>` success member (the same bare-200 policy the OpenAPI emitter applies, so spec and types agree the method can still succeed); useful for handing consumers of any stack a typed caller without shipping s200:

```ts
import { generateClient } from 's200/codegen';
const source = generateClient(app, { baseUrl: 'https://api.example' });  // → .ts file content
```

## Dev / hot reload

`s200/dev` (node) turns the snapshot-immutable route table into zero-downtime reloads: `createHotApp(app)` wraps your app in a stable identity, `reload(nextApp)` swaps the whole table (routes, middlewares, error policy, matcher) atomically — in-flight requests finish on the old chain, new requests hit the new table, and the dispatch caches invalidate by array identity, never going stale. `importFresh(specifier)` re-imports a module bypassing the ESM cache (query-suffixed file URL), and `watchAndReload({ dirs, load, hot })` wires `fs.watch` + debounce to it; a failed `load` keeps the old table and reports through `onError`:

```ts
import { createHotApp, importFresh, watchAndReload } from 's200/dev';
import { serve } from 's200/node';

const hot = createHotApp(await buildApp());            // your (async) app builder
await serve(hot.app, { port: 3000 });                  // holds the stable identity
watchAndReload({
  dirs: ['src'],
  load: async () => (await importFresh('./src/app.ts') as { app: App }).app,
  hot,
});
```

## Client

A type-safe fetch client derived from the app's own route table: paths are restricted to registered pattern literals, params are typed from them (`:id` required, `:id?` optional, `*path` kept slash-joined), and a `query` option builds the search string. `ALL` routes are offered under every method; malformed calls (unknown pattern, missing param) throw synchronously:

```ts
const app = createApp();
const a = use(app, logger);
const b = get(a, '/users/:id', (ctx) => json(ctx, { id: ctx.params.id }));
const api = post(b, '/users/:id?', () => new Response('ok'));

const client = createClient(api, { baseUrl: 'http://localhost:3000' });
const res = await client.get('/users/:id', { id: '42' }, { query: { expand: 'posts' } });
const body = await res.json();                 // typed: { id: string }
await client.post('/users/:id?', {});          // id optional — absent is allowed
```

The client talks plain `fetch` — any server speaking the same patterns answers, not just an s200 app. Typing flows from the registrars' return types, so **thread the returns** (as above) to keep the route log; `usePlugin`-registered routes and `removeRoute` erasure are the documented exceptions. Response bodies are typed when the handler returns `json(ctx, data)` — the branded return carries the body shape into the route log and `client.get(...).json()` resolves it (`unknown` for plain `Response` handlers).

`readSSE(res)` parses an SSE response into events — `for await` it; multi-line `data` merges with `\n`, comments are ignored, `id`/`retry` persist across events (the resume cursor), and a dropped connection rejects the pending `next()`:

```ts
const res = await client.get('/events');
for await (const event of readSSE(res)) console.log(event.event, event.data);
```

### Input types

Input types flow from the gate middlewares: `jsonBody(parse)` brands the route with the parse function's return type, and `queryParams((q: Q) => …)` brands it with the callback's annotated parameter — the client then demands them:

```ts
post(app, '/articles', jsonBody(parseArticle), (ctx) => json(ctx, ctx.state.validated));
get(app, '/list', queryParams((q: { page?: string }) => …), handler);

await client.post('/articles', {}, { body: { title: 'hi' } });  // body typed: parseArticle's return
client.get('/list', {}, { query: { page: '2' } });              // query typed: { page?: string }
```

A plain-object `body` is JSON-stringified and stamped `content-type: application/json` (unless already set); string/stream/typed-array bodies pass through verbatim. Routes without gate brands keep the loose `ClientInit`. Schema-flavored gates carry the schema's **input** type (`types.input`), so a schema that transforms — parses a date string, defaults fields, narrows unions — types what the caller sends, not what the handler receives: input ≠ output inference works end to end.

### Error branches

Error branches flow from two channels. The primary one is inference: **return** an `httpError(...)` from the handler and its status and body shape land in the route log — no declaration needed (returning an `HttpError` is sugar for throwing it: it flows through the same in-chain error boundary, `onError` included, and middlewares see the stamped response on the unwind). The second is the `throws` gate, for branches a helper deep in the call stack may produce — pass-through at runtime for request handling, but the declaration is readable off the gate, so `s200/openapi` documents the branches and `s200/codegen` emits them into generated clients:

```ts
import { httpError, throws } from 's200';

get(app, '/users/:id', throws(401), (ctx) => {
  const user = findUser(ctx.params.id);
  return user ?? httpError(404, 'no such user');   // 404 branch inferred from the return
});

const res = await client.get('/users/:id', { id: '7' });
// res.status: 200 | 401 | 404
if (res.status === 404) {
  const body = await res.json();   // { error: string } — narrowed by the status
}
```

`httpError(404, 'msg')` (no body) infers the default `{ error: string }` envelope; `httpError(422, 'msg', { issues: [...] })` infers the payload shape. `throws(401, 404)` declares envelope branches; `throws({ 422: { issues: string[] } })` declares structured ones. Gates and returns merge, and two declarations of the same status union their bodies. The response is a **status-discriminated union**: narrowing `res.status` narrows `res.json()`. What is not (yet) done: `throw httpError(...)` call sites inside a handler body are invisible to the type layer (TypeScript cannot inspect function bodies) — return them, or declare with `throws`; and the checker does not verify a `throws` gate against what the handler actually produces.

### Response typing

Responders brand the status literal they ship: `json(ctx, user)` brands `200`, `json(ctx, err, { status: 404 })` brands `404`, `redirect(ctx, '/new')` brands `302`. The client surfaces both channels — `res.status` narrows to the route's status literals and `res.json()` stays the typed body, unioned across a handler's branches; plain-`Response` handlers stay honest (`status: number`, body `unknown`), and the brands ride through `mount`:

```ts
get(app, '/users/:id', (ctx) => {
  const id = Number(ctx.params.id);
  return Number.isNaN(id)
    ? json(ctx, { code: 'no_user' }, { status: 404 })
    : json(ctx, { id, name: 'ada' });
});

const res = await client.get('/users/:id', { id: '7' });
// res.status: 200 | 404 — res.json() discriminates: 400-branch bodies narrow with the status
if (res.status === 404) { /* res.json() here: { code: string } */ }
```

Thrown or returned errors can carry a structured payload: `httpError(404, 'no such user', { code: 'USER_NOT_FOUND' })` renders the body verbatim with the error's status; without a body the response keeps the `{ error: message }` envelope. To surface thrown branches on the client, declare them with a `throws` gate (see the Client section above) — or just **return** the error value and the branch is inferred. Either way the statuses and body shapes ride the route log into `res.status` and `res.json()`.

