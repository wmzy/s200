# Middleware (onion)

## The shape

Middlewares are `async (ctx, next)` with koa semantics — code after `await next()` runs on the unwind, exceptions propagate outward, and a second `next()` call before the first settles rejects.

```ts
use(app, async (ctx, next) => {
  const start = performance.now();
  await next();
  ctx.state.duration = performance.now() - start;
  ctx.res?.headers.set('x-duration', String(ctx.state.duration));
});
```

## Per-request state

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

## Context fields

`ctx.url` is the parsed request URL (reuse it — no re-parsing). `ctx.signal` is the request's cooperative-cancellation `AbortSignal`. In the node adapter it aborts when the client disconnects mid-request (Deno/Cloudflare pass the platform's disconnect signal automatically), `timeout` aborts it at the deadline, and long-running work should race it (the body readers do). Apps that want the last bit of floor throughput can pass `abortOnDisconnect: false` — a shared never-aborted signal, no per-request `AbortController`, worth roughly 8% on minimal hello-path apps. Middlewares may swap the signal on the way in (`AbortSignal.any([...])`) and should restore it on unwind. After `await next()` settles, `ctx.res` is always materialized — the handler's response, the 404/405/500 fallback, **or the error response**: an error boundary inside the chain maps thrown errors before the unwind, so middlewares observe (and may overwrite) the real response even for 500s. This is what lets logger/CORS/request-id stamp error responses.

## Route-scoped middlewares

Routes also accept scoped middlewares: any number of them between the pattern and the terminal handler. They run after the app-level chain (and unwind inside it), only for their own route:

```ts
const requireAuth = (ctx: Ctx, next: Next) => {
  if (ctx.state.user === undefined) throw httpError(401, 'Login required');
  return next();
};

get(app, '/admin', requireAuth, (ctx) => json(ctx, { ok: true }));
```

Not calling `next()` skips everything below it — the handler included — so a gate that responds or throws early never reaches the handler (koa short-circuit semantics).

## Prefix scopes

Middlewares also scope by prefix — the group runs only for requests under it (segment-boundary-aware: `/admin` matches `/admin` and `/admin/…`, not `/administrator`), nesting in registration order like ordinary middlewares:

```ts
use(app, '/admin', requireAuth, async (ctx, next) => {
  ctx.state.zone = 'admin';
  await next();
});
use(app, '/users/:id', loadUser);   // param prefixes use the router's own matching
```

