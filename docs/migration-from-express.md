# Migrating from Express to s200

s200 keeps the mental model you know — routes, middlewares, `req`/`res`-style handling — but every capability is a function over plain data, not a method on an instance.

## The mechanical mapping

| Express 5 | s200 |
|---|---|
| `const app = express()` | `const app = createApp()` |
| `app.use(mw)` | `use(app, mw)` |
| `app.use('/api', router)` | `mount(app, '/api', subApp)` |
| `app.get('/users/:id', h)` | `get(app, '/users/:id', h)` |
| `app.get('/x', mw1, mw2, h)` | `get(app, '/x', mw1, mw2, h)` — same shape |
| `app.delete(...)` | `del(app, ...)` |
| `app.all(...)` | `all(app, ...)` |
| `res.json(data)` | `json(ctx, data)` |
| `res.send(text)` | `send(ctx, text)` |
| `res.status(201).json(d)` | `json(ctx, d, { status: 201 })` |
| `res.redirect(url)` | `redirect(ctx, url)` |
| `res.sendFile(p)` | `serveStatic({ read, stat, readRange })` middleware |
| `req.params.id` | `ctx.params.id` (typed from the pattern) |
| `req.query.page` | `ctx.query.get('page')` / `parseQuery(ctx)` |
| `req.body` (json) | `await readJson(ctx)` |
| `express.json({ limit })` | `readJson(ctx, { limit })` — counted before buffering |
| `express.static('public')` | `serveStatic({ read: createFileReader('public'), ... })` |
| `app.use((err, req, res, next) => …)` | `createApp({ onError: (ctx, error) => … })` |
| `express-async-errors` | not needed — thrown errors are mapped in-chain |
| `res.set('x', 'y')` | `ctx.res?.headers.set('x', 'y')` on the unwind |

## Key differences

1. **Handlers receive one `ctx`, not `(req, res)`.** `ctx.req` is a real Web Standard `Request`, `ctx.res` is the written `Response`. The Node stream model is gone — you cannot `res.write()` mid-handler; for incremental output use `s200/streaming` (`stream`, `streamSSE`).

2. **Errors are values, not callback chains.** `throw httpError(422, 'Invalid article')` anywhere in the chain — handler, middleware, fallback — renders as `{ error: message }` with that status. Express 5 catches async throws too, but its default error handler emits HTML and its middleware error signature is the 4-arg `(err, req, res, next)`.

3. **404/405/500 fallbacks are materialized inside the chain.** Middlewares that run on the unwind (logger, cors) see and stamp the real response — no `res.on('finish')` bookkeeping needed.

4. **Method misses are 405 + `Allow`, not 404** (RFC 9110). `HEAD` falls back to `GET` routes automatically.

5. **Trailing slashes are strict by default.** `createApp({ strict: false })` restores Express's tolerance.

6. **Body parsing is opt-in and budgeted.** There is no global `express.json()` registration; each `readJson`/`readText`/`readForm` accepts its own `limit`, enforced while the bytes arrive (an oversized payload never sits in memory). Repeated reads replay from a per-request cache.

7. **No `res.locals`.** The hand-off channel is `ctx.state` — a fresh typed bag per request. Extend it per app:

   ```ts
   interface MyState extends State {
     user?: User;
   }
   const app = createApp<MyState>();
   use(app, (ctx, next) => {
     ctx.state.user = await loadUser(ctx);
     return next();
   });
   get(app, '/me', (ctx) => json(ctx, { name: ctx.state.user?.name }));
   ```

## Common patterns

**Request logging (morgan-style):**

```ts
use(app, logger());
// ISO-time METHOD path status duration
```

**CORS:**

```ts
use(app, cors({ origin: 'https://app.example', credentials: true }));
```

**Body validation (like zod-express):**

```ts
post(app, '/articles', jsonBody(ArticleSchema.parse), (ctx) => {
  json(ctx, { saved: ctx.state.validated });
});
```

**Route group with shared middleware (like `Router.use`):**

```ts
const api = createApp();
use(api, bearerAuth(async (token) => token === API_TOKEN));
get(api, '/users', listUsers);
const app = createApp();
mount(app, '/api', api);   // api's middlewares become route-scoped on mounted routes
```

**Static files with caching:**

```ts
use(app, serveStatic({
  read: createFileReader('public'),
  stat: createFileStat('public'),          // ETag/Last-Modified + 304
  readRange: createFileRangeReader('public'), // streamed ranges
  root: 'public',
  cacheControl: 'public, max-age=3600',
}));
```

## Gotchas

- **No `app.listen`.** Serving is an adapter concern: `serve(app, { port: 3000 })` from `s200/node` (or `s200/bun`).
- **Middleware never calls `res.end()`.** Writing `ctx.res` is how responses exist; returning a `Response` from a handler also works. A chain that writes nothing gets a 500 `"No response written"` (an unmatched, unwritten request gets 404).
- **`ctx.req.headers` is a `Headers` object**, not a plain object — `.get('x')`, not `['x']`.
- **Cookies ride on the response** — set them on the unwind: `setCookie(ctx, …)` after `await next()`.
