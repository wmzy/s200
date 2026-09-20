# Migrating from Hono to s200

s200 and Hono occupy the same space — Web Standard `Request`/`Response`, multi-runtime, opt-in batteries. The difference is shape: Hono is a class instance with chainable methods; s200 is plain data with top-level functions.

## The mechanical mapping

| Hono | s200 |
|---|---|
| `new Hono()` | `createApp()` |
| `app.use(mw)` | `use(app, mw)` |
| `app.use('/api/*', mw)` | route-scoped middlewares, or `mount` |
| `app.get('/users/:id', h)` | `get(app, '/users/:id', h)` |
| `app.route('/v1', sub)` | `mount(app, '/v1', subApp)` |
| `app.onError(handler)` | `createApp({ onError })` |
| `app.notFound(handler)` | `createApp({ onNotFound })` |
| `c.json(data)` | `json(ctx, data)` |
| `c.json(data, 201)` | `json(ctx, data, { status: 201 })` |
| `c.text('hi')` / `c.html(...)` | `text(ctx, …)` / `html(ctx, …)` |
| `c.redirect('/login')` | `redirect(ctx, '/login')` |
| `c.req.param('id')` | `ctx.params.id` (typed from the pattern literal) |
| `c.req.query('page')` | `ctx.query.get('page')` / `parseQuery(ctx)` |
| `c.req.json()` | `await readJson(ctx)` |
| `hono/body-limit` | `readJson(ctx, { limit })` — counted before buffering |
| `hono/cors` | `cors()` |
| `hono/logger` | `logger()` |
| `hono/compress` | `compress()` (CompressionStream — no brotli) |
| `hono/etag` | `etag()` |
| `hono/secure-headers` | `secureHeaders()` |
| `hono/timeout` | `timeout(ms)` |
| `app.request('/x')` (testing) | `handle(app, new Request('http://localhost/x'))` |
| `new Hono()` + `serve` per adapter | core + `serve(app)` from `s200/node` / `s200/bun` |

## Where s200 differs architecturally

1. **The error contract.** Hono's `onError` runs outside the middleware chain — middlewares cannot observe a 500 that `onError` writes. s200 materializes the error response inside the chain (an inner error boundary), so logger/CORS/request-id stamp it on the unwind. Same for 404/405 fallbacks, which Hono handles through separate `notFound` wiring.

2. **Method misses are 405 + `Allow`.** Hono answers a path hit with a wrong method as 404 by default; s200 emits the RFC 9110 405 with the allowed methods.

3. **Typed state.** Hono's `Context<Env>` variables map to s200's `ctx.state`: extendable globally (`declare module 's200' { interface State … }`) or per app (`createApp<MyState>()` — no global merge, two apps can carry different shapes).

4. **Registration is functions over data.** `get(app, …)` instead of `app.get(…)`. The payoff: the app is serializable data (`createRouteTable`), and bundlers drop every unimported capability (enforced by `verify:tree-shaking` + size limits in CI).

5. **No `new Hono().basePath()`** — prefix mounting is `mount(app, '/v1', subApp)`, a pure data transform.

6. **Routers.** Hono's RegExpRouter is faster for pure-dynamic tables; s200's indexed trie keys on every static segment (`/:tenant/resourceN` stays indexed). Both are sub-µs in practice — see `pnpm bench`.

## Common patterns

**Typed params — both frameworks infer from the literal pattern:**

```ts
get(app, '/users/:id', (ctx) => json(ctx, { id: ctx.params.id }));
// ctx.params.id: string — inferred
```

**Validation (hono/zod-validator style):**

```ts
post(app, '/articles', jsonBody(ArticleSchema.parse), (ctx) => {
  json(ctx, { saved: ctx.state.validated });
});
```

**Streaming SSE:**

```ts
get(app, '/events', (ctx) => streamSSE(ctx, async (writer) => {
  await writer.writeSSE({ event: 'tick', data: { n } });
}));
```

## Gotchas

- **`c.env`/`c.var` are not separate channels** — put runtime bindings in `ctx.state` or close over them.
- **`c.req.header('x')` → `ctx.req.headers.get('x')`** — real `Headers`, real `Request`; no helpers wrapping them.
- **No JSX/TSX middleware, no `hc` RPC client** — those stay Hono features. s200's answer to RPC-shaped ergonomics is `route-table` + your own generator.
- **Content-length is set explicitly** by the respond helpers (platforms serialize it lazily) — HEAD responses keep the would-be size, and `etag`/`compress` depend on it.
