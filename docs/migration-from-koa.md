# Migrating from Koa to s200

s200 is the koa model you know — onion middlewares, `ctx.state`, a mutable `ctx.res` — with routing, body parsing, and the fallbacks koa leaves to its ecosystem.

## The mechanical mapping

| Koa | s200 |
|---|---|
| `new Koa()` | `createApp()` |
| `app.use(async (ctx, next) => …)` | `use(app, async (ctx, next) => …)` |
| `koa-router`: `router.get('/users/:id', h)` | `get(app, '/users/:id', h)` |
| `router.use('/api', sub.routes())` | `mount(app, '/api', subApp)` |
| `app.use(router.routes())` | routes register directly on the app |
| `ctx.body = data` | `json(ctx, data)` / `text(ctx, …)` / `return new Response(...)` |
| `ctx.status = 201` | `json(ctx, data, { status: 201 })` |
| `ctx.redirect('/login')` | `redirect(ctx, '/login')` |
| `ctx.throw(400, 'bad')` | `throw httpError(400, 'bad')` |
| `ctx.request.body` (koa-body) | `await readJson(ctx)` / `readForm(ctx)` |
| `ctx.params.id` | `ctx.params.id` (typed from the pattern literal) |
| `ctx.query` | `ctx.query` (`URLSearchParams`) or `parseQuery(ctx)` |
| `ctx.state` | `ctx.state` — same bag, same declaration-merging trick |
| `app.on('error', fn)` | `createApp({ onError: (ctx, error) => … })` |
| `koa-static` | `serveStatic({ read, stat, readRange })` |
| `@koa/cors` | `cors()` |
| `koa-logger` | `logger()` |

## What carries over unchanged

- **Onion semantics** — `compose` is a faithful koa-compose port: downstream in registration order, unwind in reverse, double-`next()` rejects.
- **`ctx.state`** — fresh per request, extendable via `declare module 's200' { interface State … }`. s200 adds a per-app alternative: `createApp<MyState>()` types `ctx.state` as `MyState` for that app only (no global merge needed).
- **Short-circuit by not calling `next()`** — a gate that answers or throws early never reaches the handler.

## What is different

1. **Koa's 404 is a status, s200's is a response.** Koa initializes `ctx.status = 404` and lets a no-body response fall through `respond()`. s200 materializes a real 404 response inside the chain, so middlewares on the unwind can observe and stamp it — including CORS headers and logger status. Same for 405 (with an `Allow` header) and 500.

2. **Errors never escape to `app.on('error')`.** The error boundary sits inside the chain: a throwing handler renders a response your middlewares can see on the unwind. `onError` replaces koa's `ctx.onerror` + error event pair.

3. **`ctx.body` assignment is gone.** Responses are values: write `ctx.res` via the helpers (`json`/`text`/`html`/`send`) or return a `Response` from the handler. A handler that writes nothing and returns nothing gets a 500 — koa's implicit empty-body 404 is not reproduced.

4. **Handlers may return a `Response`** — adopted as `ctx.res` when nothing else wrote first. This is the `return ctx.body = …` of s200.

5. **Trailing-slash strictness.** Koa + koa-router tolerate both forms; s200 defaults strict and offers `createApp({ strict: false })`.

6. **`ctx.throw` errors carry a status in one value.** `httpError(422, 'msg')` is tagged data (`isHttpError` checks it structurally — no `instanceof` across bundle boundaries).

## Common patterns

**Timing middleware (koa-logger style):**

```ts
use(app, async (ctx, next) => {
  const start = performance.now();
  await next();
  ctx.res?.headers.set('x-duration', String(performance.now() - start));
});
```

**Typed state:**

```ts
interface MyState extends State {
  user?: User;
}
const app = createApp<MyState>();
use(app, async (ctx, next) => {
  ctx.state.user = await loadUser(ctx);
  return next();
});
```

**Error mapping with logging:**

```ts
const app = createApp({
  onError: (ctx, error) => {
    const status = isHttpError(error) ? error.status : 500;
    json(ctx, { error: String((error as { message?: string }).message) }, { status });
  },
});
```

## Gotchas

- **No `app.listen`.** Serving is an adapter: `serve(app, { port: 3000 })` from `s200/node` or `s200/bun`. `handle(app, request)` is the entire runtime contract for any fetch-shaped runtime.
- **`ctx.req` is a Web Standard `Request`** — headers are `Headers`, the URL is `ctx.url` (parsed once, reuse it).
- **Sub-app middlewares are copied at mount time.** Mounting is a pure data transform — the sub-app stays reusable and untouched, but middlewares added to it later do not propagate. Gate late additions with a parent middleware instead.
