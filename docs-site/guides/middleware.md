# Middleware

Middlewares are `async (ctx, next)` with koa onion semantics — code after `await next()` runs on the unwind, exceptions propagate outward, and a second `next()` call before the first settles rejects. Not calling `next()` skips everything below it, handler included.

```ts
use(app, async (ctx, next) => {
  const start = performance.now();
  await next();
  ctx.res?.headers.set('x-duration', String(performance.now() - start));
});
```

`ctx.state` is a fresh mutable bag per request — the typed hand-off channel between middlewares and handlers. Extend its type per app via declaration merging (`declare module 's200' { interface State { user: User } }`) or pass a per-app interface to `createApp` when apps must not share one global shape.

After `await next()` settles, `ctx.res` is always materialized — the handler's response, the 404/405/500 fallback, **or the error response**: an error boundary inside the chain maps thrown errors before the unwind, so middlewares observe (and may overwrite) the real response even for 500s. Routes also accept scoped middlewares (any number between the pattern and the terminal handler), and `use(app, '/admin', requireAuth)` scopes a group to a segment-boundary-aware prefix.

Full reference: [Middleware (onion) in the README](https://github.com/wmzy/s200#middleware-onion).
