# s200

A data + functions server framework for the Web Standard. Koa-style onion middleware, hono-style multi-runtime portability, and a fully tree-shakable, replaceable module surface. Zero dependencies.

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
```

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

`ctx.url` is the parsed request URL (reuse it — no re-parsing). After `await next()` settles, `ctx.res` is always materialized — the handler's response, the 404/405/500 fallback, **or the error response**: an error boundary inside the chain maps thrown errors before the unwind, so middlewares observe (and may overwrite) the real response even for 500s. This is what lets logger/CORS/request-id stamp error responses.

Routes also accept scoped middlewares: any number of them between the pattern and the terminal handler. They run after the app-level chain (and unwind inside it), only for their own route:

```ts
const requireAuth = (ctx: Ctx, next: Next) => {
  if (ctx.state.user === undefined) throw httpError(401, 'Login required');
  return next();
};

get(app, '/admin', requireAuth, (ctx) => json(ctx, { ok: true }));
```

Not calling `next()` skips everything below it — the handler included — so a gate that responds or throws early never reaches the handler (koa short-circuit semantics).

## Responding

Response helpers write `ctx.res` in place (init headers always win over the defaults) and return the written `Response`:

```ts
json(ctx, { ok: true });                 // application/json
text(ctx, 'plain', { status: 201 });     // text/plain; charset=utf-8
html(ctx, '<h1>hi</h1>');                // text/html; charset=utf-8
redirect(ctx, '/login');                 // 302
send(ctx, bytes, { headers: { 'content-type': 'application/pdf' } });
```

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

## Static files

All I/O is injected — the core never touches a filesystem. Adapters ship the pieces, but any `read` works (memory, S3, embedded):

```ts
import { serveStatic } from 's200';
import { createFileReader, createFileStat, createFileRangeReader } from 's200/node';

use(app, serveStatic({
  read: createFileReader('public'),
  stat: createFileStat('public'),            // ETag/Last-Modified + 304s
  readRange: createFileRangeReader('public'), // streamed ranges: no whole-file buffering
  root: 'public',
  prefix: '/static',  // mount point, stripped before lookup
  spa: true,          // html navigation misses fall back to index.html
  cacheControl: 'public, max-age=3600',      // stamped on 200/206/304
}));
```

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

Handy for OpenAPI generation, route listing, or cross-language translation.

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

**Validate** — wraps your parse function (zod/valibot/typebox/hand-rolled — s200 stays dependency-free and just calls it) as a gate middleware; the parsed value lands on `ctx.state`:

```ts
post(app, '/articles', jsonBody(ArticleSchema.parse), (ctx) => {
  json(ctx, { saved: ctx.state.validated });
});
```

**Query** — the query-string twin of `validate`: `parseQuery(ctx)` turns the query into a plain record (repeated keys collect into arrays), `queryParams` wraps a schema around it as a gate, and `QueryOf<'page&tag'>` types a query-string literal at compile time:

```ts
get(app, '/list', queryParams((q) => ({
  page: Number(q.page ?? 1),
  tags: q.tag ?? [],                    // repeated ?tag=a&tag=b → ['a','b']
})), (ctx) => json(ctx, ctx.state.validated));
```

**WebSocket** — `upgradeWebSocket(app, pattern, handler)` registers a ws route (router pattern syntax, first registration wins); the handler gets a `send`/`close`/`onMessage`/`onClose`/`onError` socket plus a request-shaped `ctx` (params/query/url). Node wires a zero-dependency RFC 6455 server through the adapter's `upgrade` option; Bun plugs into `Bun.serve` through the bridge:

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

The node server implements the protocol essentials — handshake, text/binary with fragmentation, ping/pong, close handshake, a `maxPayload` budget (default 64 MiB, 1009 beyond it). No permessage-deflate or subprotocols: bring `ws` and wire the raw `upgrade` option yourself when you need those.

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

**Compress** — gzip/deflate response compression via the Web Standard `CompressionStream` (no `node:zlib` — works on Node 18+, Bun, Deno). Negotiates `Accept-Encoding` q-values, skips bodyless/encoded/`no-transform` responses and small bodies (when a content-length is known), and maintains `Vary: Accept-Encoding`:

```ts
use(app, compress({ minBytes: 1024 }));
```

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

**Timeout** — races the chain against a deadline; a late handler gets `503 {"error":"Request timeout"}` (the losing work is not cancelled — cooperative cancellation needs explicit `AbortSignal` plumbing):

```ts
use(app, timeout(30_000));
```

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

Unhandled `HttpError`s render as `{ status, body: { "error": message } }`; anything else is logged via `console.error` and rendered as a generic 500 (never leaking internals). Provide `onError` to own the mapping (and the logging) instead.

## Adapters

```ts
import { serve } from 's200/node';
const server = await serve(app, { port: 0 });  // 0 = ephemeral
// server: { server, url, port, close(): Promise<void> }

import { serve } from 's200/bun';
const server = serve(app, { port: 3000 });
```

Both adapters expose the identical `serve(app, options)` surface; the core's `handle(app, request)` is the entire integration contract for any runtime with a fetch-shaped handler.

## Package surface

Everything is a named export from the core barrel (`s200`) — tree-shaking starts at the import statement. The Node/Bun adapters (`s200/node`, `s200/bun`) and the batteries (`s200/cors`, `s200/logger`, `s200/route-table`, `s200/cookies`, `s200/validate`, `s200/query`, `s200/rate-limit`, `s200/compress`, `s200/streaming`, `s200/request-id`, `s200/timeout`, `s200/websocket` (+ `s200/websocket/node`, `s200/websocket/bun`), `s200/etag`, `s200/secure-headers`, `s200/auth`, `s200/accepts`, `s200/serialize`) are separate entries so nothing unasked-for ever enters a bundle. A `jsr.json` is maintained — `pnpm publish:jsr` publishes the built dist to [JSR](https://jsr.io) as `@wmzy/s200`.

## Development

```sh
pnpm build                 # vite lib build (es + cjs, 22 entries) + d.ts/d.mts emission
pnpm test                  # vitest watch
pnpm vitest run            # single run (313 tests)
pnpm lint / lint:ci
pnpm check:paradigm        # enforces data + functions (no class/this/new/extends in src)
pnpm verify:tree-shaking   # asserts unused modules are shaken from a minimal bundle
pnpm smoke                 # runs scripts/smoke.mjs under node AND bun
pnpm bench                 # router dispatch micro-benchmark (ROUTES/ITERATIONS env)
pnpm bench:http            # whole-request throughput vs hono/express (isolated processes)
pnpm publish:jsr           # build + prepare declarations for JSR + npx jsr publish
```

See [docs/benchmarks.md](docs/benchmarks.md) for benchmark numbers and methodology, and the [migration guides](docs/) when coming from Express, Koa, or Hono.

## License

MIT
