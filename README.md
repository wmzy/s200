# s200

A data + functions server framework for the Web Standard. Koa-style onion middleware, hono-style multi-runtime portability, and a fully tree-shakable, replaceable module surface. Zero dependencies at the core — every battery too, except `s200/events`, which builds on [`@for-fun/event-emitter`](https://www.npmjs.com/package/@for-fun/event-emitter).

```ts
import { createApp, get, json, use, readJson } from 's200';
import { serve } from 's200/node';

const app = createApp();

use(app, async (ctx, next) => {
  await next();
  ctx.res?.headers.set('x-powered-by', 's200');
});

get(app, '/users/:id', (ctx) => json(ctx, { id: ctx.params.id }));
post(app, '/echo', async (ctx) => json(ctx, await readJson(ctx)));

const server = await serve(app, { port: 3000 });
console.log(`listening on ${server.url}`);
```

## The paradigm: data + functions

An application is **plain data** — routes, middlewares, config. Behavior never hangs off it; every capability is a top-level function taking the app (or request context) as its first argument:

```ts
const app = createApp();       // data
use(app, logger);              // behavior: (app, middleware) => app
get(app, '/x', handler);       // behavior: (app, pattern, handler) => app
handle(app, request);          // behavior: (app, Request) => Promise<Response>
```

No `class`, no `new App()`, no `app.get(...)` method calls. The payoff is mechanical: bundlers can drop every capability you don't import (`pnpm verify:tree-shaking` proves the body/static modules vanish from a minimal bundle, and `pnpm size` gates the shipped sizes), and the core translates directly to `struct + procedure` shapes in any language.

## Installation

```sh
npm install s200
```

- Node.js ≥ 20.3 (adapter: `s200/node`), Bun (adapter: `s200/bun`). Deno/edge runtimes can consume the core directly — it only touches Web Standard `Request`/`Response`.
- `s200` — the runtime-agnostic core
- `s200/node` — node:http adapter (`serve`, `createFileReader`, `createRealPathGuard`, …)
- `s200/bun` — Bun.serve adapter (`serve`, `createFileReader`, `createRealPathGuard`, …)
- `s200/cors` / `s200/logger` / `s200/route-table` / `s200/query` / `s200/websocket` / `s200/etag` / … — opt-in batteries (see [Batteries](#batteries))

## Routing

Patterns use `:name` params and a terminal `*name` wildcard; matching is strict (no trailing-slash tolerance), first registration wins, `ALL` matches every method, and `HEAD` falls back to `GET` routes. Duplicate capture names (`/users/:id/posts/:id`) are rejected at registration. Captured values are handed to handlers **percent-decoded** (`/users/foo%20bar` → `'foo bar'`) — the Express/Hono contract — while matching runs on the raw path, so an encoded `/` can never fake a segment boundary.

```ts
get(app, '/users/:id', (ctx) => text(ctx, ctx.params.id));   // ctx.params.id: string — inferred
get(app, '/files/*path', (ctx) => text(ctx, ctx.params.path)); // captures the rest incl. '/'
get(app, '/users/:id?', (ctx) => json(ctx, { id: ctx.params.id ?? null })); // id is optional
```

`/:id?` is an optional param — the segment may be absent, and `ParamsOf<'/users/:id?'>` types it as `{ id?: string }` (absent keys are omitted at runtime). Matching is greedy with backtracking, so `/x/:a?/y` matches both `/x/y` and `/x/1/y`, and chained optionals resolve left-to-right. Strict trailing slashes still hold: `/users/` keeps its empty segment and does not match `/users/:id?` (set `strict: false` to trim it).

Trailing-slash strictness is configurable per app (`strict: false` tolerates `/a/` → `/a`; the default stays strict):

```ts
const app = createApp({ strict: false });
```

The pattern literal drives the type: `ParamsOf<'/users/:id/posts/:postId'>` is `{ id: string; postId: string }`, so `ctx.params` is fully typed inside literal-pattern handlers. Routes can be removed again — `removeRoute(app, 'GET', '/users/:id')` — and the table is snapshot-immutable: registration replaces the frozen route/middleware arrays, so the dispatch caches are versioned by array identity and can never go stale (a direct `push` on the arrays throws instead of silently corrupting matching). The router itself is replaceable — pass a custom `match` to `createApp` and the whole matching strategy is yours:

```ts
const app = createApp({ match: myTrieMatcher });
```

Dispatch runs over a static-prefix trie, indexed by **every** static segment, not just the leading prefix: a request only visits the trie nodes its own segments spell out, and routes like `/:tenant/resourceN` are reached through their later static segments instead of a linear scan — matching cost tracks URL depth, not route count. The residual linear case is a table of routes with no static segments at all (`/:a/:b/:c` style) — see `pnpm bench`.

When the path matches but no route's method does, s200 answers `405 {"error":"Method Not Allowed"}` with an `Allow` header listing the methods that would have matched (RFC 9110). Middlewares run first and can answer such requests themselves — a CORS preflight or a custom `OPTIONS` handler short-circuits before the fallback.

Sub-apps mount as a pure data transform — `sub` is copied, never mutated, and its app-level middlewares become route-scoped on the mounted routes:

```ts
import { mount } from 's200';

const api = createApp();
get(api, '/users/:id', handler);

const app = createApp();
mount(app, '/v1', api);   // /v1/users/:id — api itself stays reusable
```

## Middleware (onion)

Middlewares are `async (ctx, next)` with koa semantics — code after `await next()` runs on the unwind, exceptions propagate outward, and a second `next()` call before the first settles rejects.

```ts
use(app, async (ctx, next) => {
  const start = performance.now();
  await next();
  ctx.state.duration = performance.now() - start;
  ctx.res?.headers.set('x-duration', String(ctx.state.duration));
});
```

`ctx.state` is a fresh mutable bag per request — the typed hand-off channel between middlewares and handlers. Extend its type per app via declaration merging (koa's `DefaultState` trick):

```ts
declare module 's200' {
  interface State { user: User }
}
```

Apps that must not share one global shape pass a per-app interface to `createApp` instead — `ctx.state` is then that interface throughout the app's middlewares, handlers, and error policy, with no module merge (define it as an `interface`):

```ts
interface AdminState extends State {
  user: User;
}
const app = createApp<AdminState>({
  onError: (ctx, error) => { /* ctx.state.user: User */ },
});
use(app, (ctx, next) => { ctx.state.user; return next(); });
get(app, '/me', (ctx) => json(ctx, ctx.state.user));
```

`ctx.url` is the parsed request URL (reuse it — no re-parsing). `ctx.signal` is the request's cooperative-cancellation `AbortSignal`. In the node adapter it aborts when the client disconnects mid-request (Deno/Cloudflare pass the platform's disconnect signal automatically), `timeout` aborts it at the deadline, and long-running work should race it (the body readers do). Apps that want the last bit of floor throughput can pass `abortOnDisconnect: false` — a shared never-aborted signal, no per-request `AbortController`, worth roughly 8% on minimal hello-path apps. Middlewares may swap the signal on the way in (`AbortSignal.any([...])`) and should restore it on unwind. After `await next()` settles, `ctx.res` is always materialized — the handler's response, the 404/405/500 fallback, **or the error response**: an error boundary inside the chain maps thrown errors before the unwind, so middlewares observe (and may overwrite) the real response even for 500s. This is what lets logger/CORS/request-id stamp error responses.

Routes also accept scoped middlewares: any number of them between the pattern and the terminal handler. They run after the app-level chain (and unwind inside it), only for their own route:

```ts
const requireAuth = (ctx: Ctx, next: Next) => {
  if (ctx.state.user === undefined) throw httpError(401, 'Login required');
  return next();
};

get(app, '/admin', requireAuth, (ctx) => json(ctx, { ok: true }));
```

Not calling `next()` skips everything below it — the handler included — so a gate that responds or throws early never reaches the handler (koa short-circuit semantics).

Middlewares also scope by prefix — the group runs only for requests under it (segment-boundary-aware: `/admin` matches `/admin` and `/admin/…`, not `/administrator`), nesting in registration order like ordinary middlewares:

```ts
use(app, '/admin', requireAuth, async (ctx, next) => {
  ctx.state.zone = 'admin';
  await next();
});
use(app, '/users/:id', loadUser);   // param prefixes use the router's own matching
```

## Responding

Response helpers write `ctx.res` in place (init headers always win over the defaults) and return the written `Response`:

```ts
json(ctx, { ok: true });                 // application/json
text(ctx, 'plain', { status: 201 });     // text/plain; charset=utf-8
html(ctx, '<h1>hi</h1>');                // text/html; charset=utf-8
redirect(ctx, '/login');                 // 302
send(ctx, bytes, { headers: { 'content-type': 'application/pdf' } });
```

`html` does **not** escape — interpolating user input is a template's job (or run `escapeHtml(value)` first), mirroring `hono/html`'s explicit-escape contract: `html(ctx, \`<p>${escapeHtml(user)}</p>\`)`.

Handlers may also simply **return** a `Response` — it is written for you when nothing has been written yet. If a matched chain finishes without writing anything, s200 answers `500 {"error":"No response written"}`; an unmatched, unwritten request goes to `onNotFound` (default `404`). The fallbacks are materialized inside the chain, so middlewares on the unwind (logger, cors) see and stamp the real response.

The helpers set `content-length` explicitly when the size is known (platforms serialize it lazily, so a bare `new Response('…')` carries none): HEAD responses keep the would-be size, and size-aware middlewares (`compress`'s `minBytes`, `s200/etag`) can see it.

## Body parsing

```ts
const body = await readJson<Login>(ctx);   // invalid JSON → 400 HttpError
const raw = await readText(ctx);
const form = await readForm(ctx);          // FormData (urlencoded + multipart)
```

Every read accepts a byte budget: `readJson(ctx, { limit: 64 * 1024 })`. The first read counts bytes as they arrive and rejects oversize bodies with a 413 `HttpError` **before buffering them** — an oversized payload never sits in memory (a later limited read of an already-buffered body enforces the limit after the fact). Default: unlimited.

Bodies are single-read by platform contract; s200 caches the parse per request context, so multiple reads (and mixed json/text reads) replay from one buffer instead of throwing.

For bodies too large to buffer, `readStream` streams the raw bytes instead — a `limit` enforces the byte budget as bytes flow (over budget errors the stream with a 413 `HttpError` and cancels the upload), and an aborted `ctx.signal` errors it with an `AbortError`. It is terminal for the body (later buffered reads reject 409); a buffered read that already ran replays as a single chunk:

```ts
const bytes = readStream(ctx, { limit: 64 * 1024 });   // ReadableStream<Uint8Array>
```

`s200/multipart`'s `streamForm` parses `multipart/form-data` incrementally over that budget: parts arrive one by one as they complete (per-part buffering, never the whole body), with name/filename/content-type parsed, `415` for non-multipart content types, `413` when the limit trips mid-body, and `400` for truncated/malformed bodies:

```ts
import { streamForm } from 's200/multipart';
await streamForm(ctx, (part) => {
  parts.push(part);   // { name, filename?, contentType?, data: Uint8Array }
}, { limit: 10 * 1024 * 1024 });
```

`s200/upload`'s `uploadForm(ctx, sink, options)` is the landing helper over `streamForm`: fields collect into `fields` (parseQuery semantics — single value `string`, repeats `string[]`), and file parts pass through `accept` (prefix list or callback; a miss answers `415`), `maxFiles`/`maxFileSize` (`413`, naming which constraint tripped) before reaching your injected `sink` — zero-dependency, disk is a one-line `node:fs/promises` `writeFile` away (see its JSDoc). The sink's return string becomes the file's `id` in the result; a throwing sink aborts the whole upload to the error boundary. File parts are buffered per-part — for huge files stay on `streamForm` directly:

```ts
const { files, fields } = await uploadForm(ctx,
  async (file) => (await writeFile(join(dir, file.filename ?? file.name), file.data), file.filename),
  { limit: 10 * 1024 * 1024, maxFileSize: 5 * 1024 * 1024, accept: ['image/'] });
```

## Static files

All I/O is injected — the core never touches a filesystem. Adapters ship the pieces, but any `read` works (memory, S3, embedded):

```ts
import { serveStatic } from 's200';
import { createFileReader, createFileStat, createFileRangeReader } from 's200/node';

use(app, serveStatic({
  read: createFileReader('public'),
  stat: createFileStat('public'),            // ETag/Last-Modified + 304s
  readRange: createFileRangeReader('public'), // streamed ranges: no whole-file buffering
  prefix: '/static',  // mount point, stripped before lookup
  spa: true,          // html navigation misses fall back to index.html
  cacheControl: 'public, max-age=3600',      // stamped on 200/206/304
}));
```

`root` is embedded into the lookup path handed to `read` — leave it unset (as above) when the injected readers are already rooted at a directory. Pass it (e.g. `root: 'assets'`) when the `read` function expects root-prefixed keys, like an in-memory map.

Traversal (`..`) never escapes the root, `index` (default `index.html`) serves directory paths, and misses fall through to `next()` so other routes can answer. Hidden files are refused by default — a request path with a dotfile segment (`.env`, `.git/…`, including percent-encoded forms) falls through instead of being served; opt out with `dotfiles: 'allow'`.

Lexical checks can't see through symlinks: a symlink inside the root can point anywhere. When the served root can contain symlinks, inject the adapter's realpath guard — every lookup is resolved, and a real path outside the root falls through like a miss (opt-in: it costs one realpath per request):

```ts
import { createRealPathGuard } from 's200/node';   // or 's200/bun'

use(app, serveStatic({ …, realPath: createRealPathGuard('public') }));
```

Byte readers support single byte ranges (`Range: bytes=…` → 206, or 416 when unsatisfiable), so video seeking works — but buffered readers hold the whole file in memory. For large media, `read` may return a `ReadableStream` (see `createFileReader('public', { stream: true })`) and `readRange` streams slice reads. `stat` additionally turns on conditional requests: responses carry `ETag`/`Last-Modified`, and `If-None-Match`/`If-Modified-Since` hits answer 304. A directory path missing its trailing slash gets a 301 to the slash form when the directory index exists (opt out: `redirectToSlash: false`).

## Batteries

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

## Stability & versioning

s200 is heading to 1.0 with an explicit contract: the surface real apps touch — `createApp` options, the registrars, the `Ctx` guarantees (pre-decoded params, cached `url`, disconnect-aware `signal`, per-request `state`, always-materialized `res`), the respond helpers and their `content-length` contract, the error model (`httpError`/`isHttpError`/`toErrorResponse` + the `throws` gate), routing semantics (first registration wins, `HEAD`→`GET`, `405`+`Allow`, strict trailing slashes), and the battery entry map — freezes at 1.0 and changes only in majors after that. Releases are automated by semantic-release over conventional commits; before 1.0 the 0.x allowance applies (any minor may break, with migration notes), after 1.0 deprecations run the mark → migration guide → two minors rhythm. What is honestly **not** frozen yet: light-mode details, the JSR publishing flow, and the codegen output format.

The full frozen-surface list and policy: [docs/stability.md](docs/stability.md). Migration guides: [from Express](docs/migration-from-express.md), [from Koa](docs/migration-from-koa.md), [from Hono](docs/migration-from-hono.md).

## Errors

Errors are tagged data, checked structurally — no `instanceof` chains across bundle boundaries:

```ts
import { httpError, isHttpError } from 's200';

throw httpError(422, 'Invalid article');

const app = createApp({
  onError: (ctx, error) => {
    const status = isHttpError(error) ? error.status : 500;
    json(ctx, { error: String((error as { message?: string }).message) }, { status });
  },
});
```

Unhandled `HttpError`s render as `{ status, body: { "error": message } }`; anything else is logged via `console.error` and rendered as a generic 500 (never leaking internals). Provide `onError` to own the mapping (and the logging) instead — or just swap the sink, keeping the default mapping:

```ts
const app = createApp({ logError: (error) => log('error', { err: error }) });
```

## Adapters

```ts
import { serve } from 's200/node';
const server = await serve(app, { port: 0 });  // 0 = ephemeral
// server: { server, url, port, close(): Promise<void> }

import { serve } from 's200/bun';
const server = serve(app, { port: 3000 });
```

Both adapters expose the identical `serve(app, options)` surface; the core's `handle(app, request)` is the entire integration contract for any runtime with a fetch-shaped handler — `s200/deno` (`serve(app)` over `Deno.serve`) and `s200/cloudflare` (`createHandler(app)` as the module worker's default export) are the one-line adapters for those runtimes.

`s200/node` has an opt-in **light mode** — `serve(app, { light: true })` swaps the platform's per-request `Request`/`Response` constructors for light-weight duck-typed ones (nothing global is patched, the Web Standard contract stays the default). On the light path `ctx.req.headers`/`ctx.res.headers` are `LightHeaders` — a duck `Headers` with the full structural API (`get`/`set`/`has`/`append`/`delete`/`getSetCookie`/iteration), case-insensitive, insertion-ordered, and a legal `HeadersInit` everywhere (platform constructors fill from its pair iterator); `instanceof Headers` is simply false there. See `docs/benchmarks.md`: light mode buys ~28–35% whole-request throughput (machine-dependent) and lands between the real-Web-Standard class and the patched one. The batteries ride the light path too — `compress`/`etag` work off the light response's synchronous bytes (streamed bodies pipe through `CompressionStream` unchanged), `stream`/`streamSSE` ride the light response's stream body, `serveStatic` serves byte bodies, streamed files, and byte ranges, and the request body readers (`readJson`/`readText`/`readForm`/`readStream`) read the light request's stream — client disconnects abort `ctx.signal` here exactly like on the default path.

`s200/node` also serves TLS — HTTPS, or HTTP/2 over TLS — through the same dispatch pipeline. HTTPS combines with `upgrade` for WSS (the WebSocket handler runs on the decrypted connection); only `http2: true` forbids `upgrade`, since HTTP/2 has no upgrade event:

```ts
await serve(app, {
  port: 443,
  https: { key: await readFile('key.pem'), cert: await readFile('cert.pem') },      // node:https
});
await serve(app, {
  port: 443,
  https: { key, cert, http2: true },                                                  // node:http2
});
await serve(app, {
  port: 443,
  https: { key, cert },                                                               // WSS
  upgrade: createUpgradeHandler(app),
});
```

## Package surface

Everything is a named export from the core barrel (`s200`) — tree-shaking starts at the import statement (`defineMiddleware`, the third-party battery authoring hook, lives there too). The Node/Bun adapters (`s200/node`, `s200/bun`) and the batteries (`s200/cors`, `s200/logger`, `s200/route-table`, `s200/cookies`, `s200/validate`, `s200/query`, `s200/rate-limit`, `s200/compress`, `s200/streaming`, `s200/request-id`, `s200/timeout`, `s200/websocket` (+ `s200/websocket/node`, `s200/websocket/bun`), `s200/etag`, `s200/secure-headers`, `s200/auth`, `s200/accepts`, `s200/serialize`, `s200/client`, `s200/csrf`, `s200/jwt`, `s200/cache`, `s200/trust-proxy`, `s200/meta`, `s200/openapi`, `s200/deno`, `s200/cloudflare`, `s200/otel`, `s200/codegen`, `s200/test`, `s200/multipart`, `s200/session`, `s200/swagger`, `s200/upload`, `s200/dev`, `s200/lifecycle`, `s200/health`, `s200/config`, `s200/schedule`, `s200/events`, `s200/version`) are separate package entries: importing one pulls exactly it. The core and every battery except `s200/events` are zero-dependency; `s200/events` adds [`@for-fun/event-emitter`](https://www.npmjs.com/package/@for-fun/event-emitter) as its single dependency. A `jsr.json` is maintained — `pnpm publish:jsr` publishes the built dist to [JSR](https://jsr.io) as `@wmzy/s200`.

## Development

```sh
pnpm build                 # vite lib build (es + cjs, 42 entries) + d.ts/d.mts emission
pnpm test                  # vitest watch
pnpm vitest run            # single run (all tests; add --maxWorkers=4 to cap concurrency)
pnpm lint / lint:ci
pnpm check:paradigm        # enforces data + functions (no class/this/new/extends in src)
pnpm verify:tree-shaking   # asserts unused modules are shaken from a minimal bundle
pnpm smoke                 # runs scripts/smoke.mjs under node AND bun
node scripts/smoke-deno.mjs # serves dist through Deno.serve and checks the core (auto-skips without deno)
pnpm bench                 # router dispatch micro-benchmark (ROUTES/ITERATIONS env)
pnpm bench:http            # whole-request throughput vs hono/express/fastify/elysia (isolated processes; + deno when installed)
pnpm docs:dev / docs:build # vitepress documentation site (docs-site/)
pnpm publish:jsr           # build + prepare declarations for JSR + npx jsr publish
```

Runnable examples live in [examples/](examples/) — `rest-jwt` (JWT-gated REST API + typed client), `sse-dashboard` (SSE ticker + static page), `ws-chat` (websocket rooms): `pnpm --filter @s200-example/rest-jwt smoke` and friends.

See [docs/benchmarks.md](docs/benchmarks.md) for benchmark numbers and methodology, [docs/compare.md](docs/compare.md) for how s200 stacks up against the alternatives (Hono, Express, Fastify, Koa, Elysia), and the [migration guides](docs/) when coming from Express, Koa, or Hono.

## License

MIT
