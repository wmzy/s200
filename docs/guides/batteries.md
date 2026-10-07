# Batteries

Opt-in modules in separate entries — importing one pulls only it, the core stays lean.

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
import { timeout } from 's200/timeout';
import { upgradeWebSocket } from 's200/websocket';
import { createUpgradeHandler } from 's200/websocket/node';
import { createBunWebSocketBridge } from 's200/websocket/bun';
import { etag } from 's200/etag';
import { secureHeaders } from 's200/secure-headers';
import { basicAuth, bearerAuth } from 's200/auth';
import { accepts } from 's200/accepts';
import { serialize, jsonRaw } from 's200/serialize';
import { createClient } from 's200/client';
import { createCsrf } from 's200/csrf';
import { describeRoute, describeApp } from 's200/meta';
import { openapiSpec, openapiJson } from 's200/openapi';
import { signJwt, verifyJwt, jwtAuth } from 's200/jwt';
import { cache } from 's200/cache';
import { trustProxy } from 's200/trust-proxy';
import { serve as serveDeno } from 's200/deno';
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
```

**CORS** — app-level or per-route. Preflights are answered in place with a 204 (the handler never runs); actual responses get the allow-origin headers stamped on the unwind — fallback 404/405/500 responses included, since they are materialized inside the chain:

```ts
use(app, cors({ origin: 'https://app.example', credentials: true }));
use(app, cors({ origin: ['https://a.example'], maxAge: 600, exposeHeaders: ['x-request-id'] }));
```

The default `'*'` origin emits the literal wildcard; allowlists and resolvers reflect the request origin and set `Vary: Origin`. Browsers refuse credentialed wildcard origins (fail-closed) — pair `credentials` with an explicit origin. `exposeHeaders` emits `Access-Control-Expose-Headers` so page scripts can read custom response headers.

**Logger** — one line per request (`ISO-time METHOD path status duration`) through a pluggable `sink`/`format`. The status is always the real one — fallbacks **and error responses** are materialized inside the chain, so the logger sees every request, including 500s.

**Route table** — the `data + functions` payoff: the app is plain data, so it exports as JSON without executing anything:

```ts
createRouteTable(app);
// { routes: [{ method: 'GET', pattern: '/users/:id', params: ['id'], middlewareCount: 1 }, …] }
```

Handy for route listing or cross-language translation — and `s200/openapi` builds the OpenAPI 3.1 document from the same table (see below).

**OpenAPI** — the route table is the API surface, so the OpenAPI 3.1 document comes out of it directly: `describeRoute` annotates (summary, tags, query/body schemas in the `SerializeSchema` DSL, response shapes), `openapiSpec` emits the spec, and unannotated routes still appear with their params and a bare 200:

```ts
describeApp(app, { title: 'Users API', version: '1.0.0' });
describeRoute(app, 'GET', '/users/:id', {
  summary: 'Fetch one user',
  responses: { 200: { description: 'ok',
    schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } } },
});
get(app, '/openapi.json', (ctx) => openapiJson(ctx, app));   // serve the spec
```

The same annotations can become runtime gates: `withRouteValidation(app)` is a pure data transform (mount's family) that rebuilds only the routes carrying a `body` or `query` annotation, checking requests with `compileValidator` from `s200/serialize` — the read-side twin of `serialize()`, covering exactly the same DSL subset. A violation answers `422` naming the first offending path (`{"error":"body.tags.1: expected string, got number"}`); valid input flows on untouched — nothing lands on `ctx.state` and nothing is coerced (query values stay strings, so `?page=2` against `{ type: 'integer' }` is a 422 — use `s200/query`'s `queryParams` when you want parsing). The spec and the gates share one source: annotations are re-attached to the rebuilt routes, so `openapiSpec(gated)` keeps documenting them. Annotate mounted sub-apps on the parent after `mount` (the metadata registry keys by route identity).

Pair the spec with a documentation UI — `swaggerUi` serves the Scalar API Reference page (assets load from a pinned CDN, so s200 stays zero-dependency):

```ts
import { swaggerUi } from 's200/swagger';
get(app, '/docs', (ctx) => swaggerUi(ctx, { url: '/openapi.json', title: 'Users API' }));
```

**Cookies** — read, write, and sign as pure functions. Writing appends a proper `Set-Cookie` header (repeat calls stay separate headers, never comma-joined); call it once the response exists — the natural spot is the unwind, after `await next()`:

```ts
use(app, async (ctx, next) => {
  await next();
  setCookie(ctx, 'theme', 'dark', { httpOnly: true, sameSite: 'lax', maxAge: 86400 });
});
get(app, '/theme', async (ctx) => json(ctx, { theme: getCookie(ctx, 'theme') }));
await setSignedCookie(ctx, 'sid', userId, SECRET);       // + sid.sig HMAC partner
const sid = await getSignedCookie(ctx, 'sid', SECRET);   // undefined unless verified
```

**Sessions** — `createSession({ secret, store? })` returns a middleware (plus `close()` for the default store's sweep timer). The client only ever holds an opaque signed id (HMAC via the cookies battery — one signing convention framework-wide); data lives server-side, in the pluggable `store` (`get`/`set`/`delete`, TTL passed to `set` — the Redis `SET … EX` shape; default is an in-process map with lazy expiry). Tampered, missing, or expired ids all look identical: a fresh empty session, never an error. Mutations (`set`/`delete`/`clear`/`touch`) persist and (re)issue the cookie on the unwind; `destroy()` deletes from the store and expires the cookie; read-only requests write nothing:

```ts
const { middleware } = createSession({ secret: SECRET, cookie: { maxAge: 3600 } });
use(app, middleware);
get(app, '/', (ctx) => {
  const session = ctx.state.session as Session;
  session.set('user', 'alice');            // persisted + cookie issued on unwind
  return json(ctx, { visits: session.get('visits') });
});
```

**Config** — typed, fail-fast configuration over the same Standard Schema channel `s200/validate` uses (nest's `@nestjs/config`, zero-dep): `parseEnv` is a pure `.env` parser (comments, blank lines, `export ` prefix, quoted values with escapes, duplicate keys last-wins; no multi-line values), and `createConfig` validates the merged record at construction. Validation failure throws **one** `Error` aggregating every issue, so a bad deploy dies at boot with the full list, not the first:

```ts
import { parseEnv, createConfig } from 's200/config';

const schema = { /* Standard Schema: input strings, output coerced */ };
const { valid } = createConfig(schema, { ...parseEnv(await readFile('.env', 'utf8')), ...process.env });
// valid: schema.types.output — fully typed from here on
```

Env values arrive as strings — declare the schema's input side as strings and coerce in the output (input ≠ output inference, same as `jsonBody`). I/O stays injected: `parseEnv` takes text, you read the file (the core never touches a filesystem).

**Validate** — wraps your parse function (zod/valibot/typebox/hand-rolled — s200 stays dependency-free and just calls it) as a gate middleware; the parsed value lands on `ctx.state`:

```ts
post(app, '/articles', jsonBody(ArticleSchema.parse), (ctx) => {
  json(ctx, { saved: ctx.state.validated });
});
```

Standard Schema values work without a wrapper: anything carrying a `~standard` prop (zod, valibot, typebox, arktype…) can be handed to `jsonBody`/`queryParams` directly. The gate calls `validate()` on the parsed body/record — the first reported issue becomes a `422 HttpError` carrying its message; an empty `issues` array counts as success. The schema's phantom `types` prop types both sides for free: `types.input` is what the caller sends (`jsonBody(schema)` demands and types the client's `init.body`, `queryParams(schema)` brands `init.query` the same way — the input side, so transforming schemas are honest end to end), while the parsed `types.output` product lands on `ctx.state.validated` for the handler; `standardValidate(schema, data)` exports the identical 422 semantics for your own gates.

**Query** — the query-string twin of `validate`: `parseQuery(ctx)` turns the query into a plain record (repeated keys collect into arrays), `queryParams` wraps a schema around it as a gate, and `QueryOf<'page&tag'>` types a query-string literal at compile time:

```ts
get(app, '/list', queryParams((q) => ({
  page: Number(q.page ?? 1),
  tags: q.tag ?? [],                    // repeated ?tag=a&tag=b → ['a','b']
})), (ctx) => json(ctx, ctx.state.validated));
```

**WebSocket** — `upgradeWebSocket(app, pattern, handler)` registers a ws route (router pattern syntax, first registration wins); the handler gets a `send`/`close`/`onMessage`/`onClose`/`onError` socket plus a request-shaped `ctx` (params/query/url). Node wires a zero-dependency RFC 6455 server through the adapter's `upgrade` option — plain `ws://`, or `wss://` by pairing `upgrade` with `https` (only `http2: true` excludes it); Bun plugs into `Bun.serve` through the bridge:

```ts
import { upgradeWebSocket } from 's200/websocket';
import { createUpgradeHandler } from 's200/websocket/node';   // node
import { createBunWebSocketBridge } from 's200/websocket/bun'; // bun

upgradeWebSocket(app, '/chat/:room', (socket, ctx) => {
  socket.onMessage((data) => socket.send(`[${ctx.params.room}] ${data}`));
});

await serve(app, { port: 3000, upgrade: createUpgradeHandler(app) });            // node
serve(app, { port: 3000, websocket: createBunWebSocketBridge(app) });            // bun
```

The node server implements the protocol — handshake, text/binary with fragmentation, ping/pong, close handshake, a `maxPayload` budget (default 64 MiB, 1009 beyond it) — plus opt-in subprotocol negotiation and permessage-deflate (RFC 7692, no-context-takeover both ways), and a heartbeat surface (`socket.ping()` / `socket.onPong()`):

```ts
upgradeWebSocket(app, '/graphql', (socket) => socket.onMessage(handle),
  { protocols: ['graphql-ws', 'graphql-transport-ws'], perMessageDeflate: true });
// socket.protocol carries the negotiated subprotocol; bun negotiates it too
```

**ETag** — stamps a weak SHA-1 entity tag on byte-backed responses and answers `If-None-Match` hits with 304. Byte-backed means an explicit `content-length` — s200's respond helpers (`json`/`text`/`html`/`send`) set it, and a bare `new Response('…')` needs it set by hand (platforms serialize content-length lazily). Chunked/streamed responses (SSE, `s200/streaming`) are skipped, not buffered:

```ts
use(app, etag());                    // W/"…" by default
use(app, etag({ strong: true }));    // "…"
```

**Secure headers** — a safe-by-default baseline stamped on the unwind (fallback responses included); handlers' own headers always win, and `false` drops one:

```ts
use(app, secureHeaders());  // nosniff, DENY framing, strict-origin-when-cross-origin
use(app, secureHeaders({ strictTransportSecurity: 'max-age=31536000' }));  // HSTS is opt-in
```

**Auth** — `basicAuth`/`bearerAuth` gates: the `verify` function decides, failures answer `401` + `WWW-Authenticate` in place and the chain below never runs:

```ts
use(app, basicAuth(async (user, pass) => user === 'admin' && (await check(pass))));
use(app, bearerAuth(async (token) => token === API_TOKEN));
```

**CSRF** — session-less synchronizer tokens: HMAC-signed (`nonce` + expiry) so only your secret can mint one, delivered in a cookie and verified on unsafe requests against the header/form field **and** the request `Origin` (closing both classic double-submit holes). The token lives on `ctx.state.csrfToken`; `csrf.token(ctx)` echoes it into server-rendered forms, and unsafe misses answer `403` in place:

```ts
const csrf = createCsrf({ secret: CSRF_SECRET });   // keep the secret out of version control
use(app, csrf.middleware);
get(app, '/form', (ctx) => html(ctx, `<input type="hidden" name="_csrf" value="${await csrf.token(ctx)}">`));
```

**JWT** — HS256/384/512, RS256/384/512, PS256/384/512, and ES256/384/512 over WebCrypto, zero dependencies. `signJwt`/`verifyJwt` take a secret string, a `CryptoKey`, or a JWK; verification rejects `alg:none` unconditionally, enforces `exp`/`nbf`, checks `aud`/`iss` on request, and key families must match the header algorithm (HS needs a secret, RS/PS an RSA key, ES an EC key — the confusion attack is structurally closed). `jwtAuth` is the gate, storing the payload on `ctx.state.jwt` and answering `401` before the chain below runs:

```ts
const token = await signJwt({ sub: userId }, JWT_SECRET, { expiresIn: 3600 });
use(app, jwtAuth({ secret: JWT_SECRET }));              // Authorization: Bearer …
get(app, '/me', (ctx) => json(ctx, ctx.state.jwt));

// Key rotation: a JWKS endpoint resolves keys by kid (cached, module-wide).
use(app, jwtAuth({ jwks: 'https://idp.example/.well-known/jwks.json' }));
// …or a custom resolver: jwtAuth({ keyResolver: (header) => … })
```

**Cache** — response cache with TTL + LRU-ish eviction and a bounded body size. Safe by default: GET/200-only, `Set-Cookie` responses are never stored, `Authorization` requests never served, `Cache-Control: no-cache` forces a pass:

```ts
use(app, cache({ ttl: 60, max: 1000 }));
use(app, cache({ store: redisCacheStore }));   // shared store across instances
```

The default store is in-process; a custom `store` (`get`/`set`/`delete` over `{ exp, status, headers, body }` entries) shares the cache across instances — expiry is still checked by the middleware on every read.

**Trust proxy** — corrects `ctx.url`'s protocol/host from `X-Forwarded-Proto`/`X-Forwarded-Host` and records the client address in `ctx.state.proxy`, with hop counting for `X-Forwarded-For`. Register it before `s200/csrf`, `s200/secure-headers`, and anything that builds absolute URLs:

```ts
use(app, trustProxy({ hops: 1 }));   // behind one trusted reverse proxy
```

**Accepts** — RFC 9110 content negotiation over `Accept` / `Accept-Encoding` / `Accept-Language`: q-values, wildcards, prefix ranges, and the specific-q=0-overrides-wildcard precedence:

```ts
const want = accepts(ctx);
const type = want.type(['application/json', 'text/html']) ?? 'application/json';
```

**Rate limit** — true sliding-window gate per client key: every hit expires `windowMs` after it landed (no fixed boundary, so window edges can't burst), the over-limit request is answered in place with `429` + `Retry-After`, and the chain below never runs:

```ts
use(app, rateLimit({ windowMs: 60_000, limit: 100 }));
```

The default key reads `x-forwarded-for` — only meaningful behind a proxy that overwrites it; pass `key: (ctx) => …` for any other identity (and a `now` clock for tests). The counters live in-process by default — per-instance limits. For shared limits across instances, inject a `store` (atomic `hit(key, now, limit, windowMs) → { count, retryAt }` — the Redis INCR shape).

**Serialize** — schema-driven JSON serialization: `serialize(schema)` compiles a serializer for a JSON-Schema-shaped subset (objects, arrays, primitives, `nullable`), and `jsonRaw` writes the result as a response with an exact `content-length`. The payoff is the declared shape, not raw speed — the output carries exactly the declared keys (undeclared ones are dropped, so an internal field can never leak), and the schema drives the input type at compile time. Modern engines' `JSON.stringify` stays competitive on typical payloads, so use it when the shape contract matters, not as a speed hack:

```ts
const toUser = serialize({
  type: 'object',
  properties: { id: { type: 'integer' }, name: { type: 'string' } },
  required: ['id', 'name'] as const,   // as const: the array literal drives optionality
});
get(app, '/users/:id', (ctx) => jsonRaw(ctx, toUser({ id: 1, name: 'ada' })));
```

It is a serialization shape, not a validator: type mismatches are not checked, and `NaN`/`Infinity` serialize as `null` (JSON semantics).

**Compress** — gzip/deflate response compression via the Web Standard `CompressionStream` (no `node:zlib` — works on Node 18+, Bun, Deno), plus opt-in brotli through an injected encoder (`CompressionStream` has no brotli; `s200/node` ships `brotliCompress` over `node:zlib`). Negotiates `Accept-Encoding` q-values, skips bodyless/encoded/`no-transform` responses and small bodies (when a content-length is known), and maintains `Vary: Accept-Encoding`:

```ts
use(app, compress({ minBytes: 1024 }));
import { brotliCompress } from 's200/node';
use(app, compress({ minBytes: 1024, brotli: { compress: brotliCompress } }));
```

Brotli is a buffered path — it applies to byte-backed responses only (a declared content-length); streamed responses fall back to gzip/deflate.

**Streaming** — `stream` serves push-driven chunks; `streamSSE` frames Server-Sent Events with backpressure-aware writes:

```ts
get(app, '/events', (ctx) => streamSSE(ctx, async (writer) => {
  await writer.writeSSE({ event: 'tick', data: { n } });
  await writer.heartbeat();
}));
```

**Request ID** — canonical correlation id per request (`ctx.state.requestId`), honoring incoming ids and stamping responses — error responses included:

```ts
use(app, requestId());          // x-request-id
use(app, requestId({ header: 'x-trace', generator: () => nanoid() }));
```

**Timeout** — races the chain against a deadline; a late handler gets `503 {"error":"Request timeout"}`, and since the deadline also aborts `ctx.signal`, cooperating work (body reads, downstream fetches) stops instead of running to completion in the background:

```ts
use(app, timeout(30_000));
```

**OTel** — `s200/otel`'s `trace()` is an OpenTelemetry-compatible span middleware over duck-typed `Tracer`/`Span` interfaces (zero deps — bridge to `@opentelemetry/api` with a lambda). The span observes the real status of every request — handler, 404/405 fallback, and mapped 500 alike — because responses materialize inside the chain; rejections are recorded as exceptions and rethrown:

```ts
import { trace } from 's200/otel';
use(app, trace({ tracer: myOtelTracerBridge, extract: (headers) => … }));
```

`metrics()` is the metrics twin — duck-typed `Meter` (a real `@opentelemetry/api` meter bridges with one lambda), reporting `http.server.requests` (counter), `http.server.active_requests` (+1 before `next()`, −1 in a `finally` — the gauge balances even when the chain throws), and `http.server.request.duration` (histogram, milliseconds). Recordings carry `http.request.method` and `http.response.status_code` — always the materialized status, 404/405/500 included, thanks to the in-chain error boundary. Slice on `status_code >= 500` for errors; `attributes` (record or `(ctx)` callback) spreads over the defaults, and `metrics()` with no options is a bare pass-through:

```ts
use(app, metrics({ meter: myMeterBridge, attributes: (ctx) => ({ 'url.route': ctx.url.pathname }) }));
```

**Events** — a typed event bus over [`@for-fun/event-emitter`](https://www.npmjs.com/package/@for-fun/event-emitter) (the one battery with a dependency; everything else stays zero-dep). The emitter is plain data — a `Map` — and every capability is a function over it, so the bus is a thin typed facade: declare your event map once and keys, listener args, and emit arguments are all narrowed by it:

```ts
import { createBus } from 's200/events';

const bus = createBus<{ userCreated: [id: string]; orderPaid: [id: string, cents: number] }>();

const off = bus.on('userCreated', (id) => notify(id));   // id: string
bus.emit('userCreated', 'u_1');                          // sync: all listeners run now
await bus.emitAsync('orderPaid', 'o_9', 4200);           // awaits promise-returning listeners
off();                                                   // unsubscribe
```

**Schedule** — cron and interval jobs, zero-dep (`@nestjs/schedule` equivalent): `nextRun(expr, from)` is a pure 5-field cron matcher (minute hour day month weekday — `*`, `*/n`, `a-b`, lists, `a-b/n`; no `L`/`W`/nicknames), and `createScheduler()` arms jobs with absolute-time re-arming so drift never accumulates (and delays beyond `setTimeout`'s ~24.8-day ceiling re-arm in segments):

```ts
import { createScheduler } from 's200/schedule';

const scheduler = createScheduler({ onError: (err, expr) => log('error', { err, expr }) });
scheduler.interval(30_000, heartbeat);
scheduler.cron('*/5 * * * *', syncJobs);      // invalid expressions throw at registration
scheduler.start();
// stop(): cancels every timer and awaits in-flight runs — wire it into onShutdown
```

A job runs with concurrency 1 — a run still in flight at the next tick is skipped, not queued. Failing jobs go through `onError` (default `console.error`) and never break the loop. The clock is injectable (`now`), registration before `start()` arms everything at once, and a second `start()` throws. Pair with `s200/lifecycle`: `stop()` in `onShutdown`, and re-create the scheduler when `s200/dev` swaps the table (jobs are data too).

**Lifecycle** — signal-driven graceful shutdown (`enableShutdownHooks` + `onApplicationShutdown`, minus the DI): `lifecycle(server, options)` turns the adapter's `serve()` result into an orchestrated drain. The order is the one rolling deploys need: flip readiness off first (the load balancer stops routing), then stop listening, then wait for in-flight requests — hard-killing whatever is left when the budget runs out — and only then run your cleanup hooks:

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

**Health** — liveness/readiness probes over injectable checks (Terminus, zero-dep). A `HealthCheck` is `() => void | Promise<void>` — anything that throws or rejects is unhealthy, with the message as the reason:

```ts
import { health, readiness, createGate } from 's200/health';

get(app, '/health/live', health());                        // 200 {"status":"ok"} — the process answers
get(app, '/health/ready', readiness({
  db: () => db.ping(),                                     // runs concurrently, each with its own budget
  cache: () => redis.ping(),
}));                                                       // 200 {"status":"ok","checks":{"db":"ok","cache":"ok"}}
```

Any failing check turns the response into a `503` naming every check's outcome (`{"status":"fail","checks":{"db":"connection refused"}}`) — healthy peers still report `"ok"`. Each check races a per-check budget (default 1000ms; `timeout` option) **and** the request's `ctx.signal`, so a disconnecting probe client cancels the checks. `createGate()` is the composable switch for lifecycle wiring: `gate.check` throws when closed (`gate.close('draining')` / `gate.open()`), so readiness flips false the moment a shutdown starts.

**Versioning** — `apiVersion(options)` is a versioning gate (NestJS's header / media-type strategies; URI versioning is just `mount(app, '/v1', …)`). Requests resolve a version — from a header (`x-api-version` by default) or from `application/vnd.<name>+json;version=1` Accept entries — and stamp it on `ctx.state.version` before `next()`:

```ts
import { apiVersion } from 's200/version';

use(app, apiVersion({ versions: ['1', '2'], default: '1' }));   // header strategy
use(app, apiVersion({ strategy: 'mediaType', mediaType: 'vnd.api', versions: ['1', '2'] }));
```

A carried version outside the list answers `404 API version not supported: v9` in place (the handler never runs); a missing version falls back to `default`, or answers `404 API version required` when there is none. The unwind stamps `Vary` (`x-api-version`, or `Accept` for the media-type strategy) so caches key on the version.

**Testing** — `s200/test` drives the app without a network: `request(app, '/users/1')` is `handle()` with full fallback semantics (hono's `app.request()` shape); `testClient(app)` is a `createClient` whose fetch routes in-process, keeping the typed paths/params/bodies; `probeApp(app)` dispatches every registered route with synthesized params and reports `{ method, pattern, status, ok }` — a mechanical "no route 500s" contract test:

```ts
import { request, testClient, probeApp } from 's200/test';
const res = await request(app, '/users/1');
const rows = await probeApp(app);        // [{ method: 'GET', pattern: '/users/:id', status: 200, ok: true }, …]
```

**Codegen** — `s200/codegen`'s `generateClient(app)` emits a standalone TypeScript client module from the runtime route table (the `data` in data + functions): one typed method per route with `ParamsOf<'…'>` args, a self-contained path-fill/query helper, methods baked in — dependency-light (only a types-only `ParamsOf` import). Response bodies stay `Response` (runtime data carries no body types — use `s200/client` when compile-time types exist); useful for handing consumers of any stack a typed caller without shipping s200:

```ts
import { generateClient } from 's200/codegen';
const source = generateClient(app, { baseUrl: 'https://api.example' });  // → .ts file content
```

**Dev / hot reload** — `s200/dev` (node) turns the snapshot-immutable route table into zero-downtime reloads: `createHotApp(app)` wraps your app in a stable identity, `reload(nextApp)` swaps the whole table (routes, middlewares, error policy, matcher) atomically — in-flight requests finish on the old chain, new requests hit the new table, and the dispatch caches invalidate by array identity, never going stale. `importFresh(specifier)` re-imports a module bypassing the ESM cache (query-suffixed file URL), and `watchAndReload({ dirs, load, hot })` wires `fs.watch` + debounce to it; a failed `load` keeps the old table and reports through `onError`:

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

**Client** — a type-safe fetch client derived from the app's own route table: paths are restricted to registered pattern literals, params are typed from them (`:id` required, `:id?` optional, `*path` kept slash-joined), and a `query` option builds the search string. `ALL` routes are offered under every method; malformed calls (unknown pattern, missing param) throw synchronously:

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

Input types flow from the gate middlewares: `jsonBody(parse)` brands the route with the parse function's return type, and `queryParams((q: Q) => …)` brands it with the callback's annotated parameter — the client then demands them:

```ts
post(app, '/articles', jsonBody(parseArticle), (ctx) => json(ctx, ctx.state.validated));
get(app, '/list', queryParams((q: { page?: string }) => …), handler);

await client.post('/articles', {}, { body: { title: 'hi' } });  // body typed: parseArticle's return
client.get('/list', {}, { query: { page: '2' } });              // query typed: { page?: string }
```

A plain-object `body` is JSON-stringified and stamped `content-type: application/json` (unless already set); string/stream/typed-array bodies pass through verbatim. Routes without gate brands keep the loose `ClientInit`. Schema-flavored gates carry the schema's **input** type (`types.input`), so a schema that transforms — parses a date string, defaults fields, narrows unions — types what the caller sends, not what the handler receives: input ≠ output inference works end to end.

Error branches flow from two channels. The primary one is inference: **return** an `httpError(...)` from the handler and its status and body shape land in the route log — no declaration needed (returning an `HttpError` is sugar for throwing it: it flows through the same in-chain error boundary, `onError` included, and middlewares see the stamped response on the unwind). The second is the `throws` gate, for branches a helper deep in the call stack may produce — a type-level declaration, a pure pass-through at runtime:

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

