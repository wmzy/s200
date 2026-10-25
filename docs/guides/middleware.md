# Middleware (onion)

## The shape

Middlewares are `async (ctx, next)` with koa semantics — code after `await next()` runs on the unwind, exceptions propagate outward, and a second `next()` call before the first settles rejects.

```ts
use(app, async (ctx, next) => {
  const start = performance.now();
  await next();
  ctx.state.duration = performance.now() - start;
  setHeader(ctx, 'x-duration', String(ctx.state.duration));
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

### Inferred injection: `withState`

The third route: a middleware that *writes* state can brand itself with what it writes, and `use` collects the brand into the app's type — downstream middlewares and handlers read the keys typed, no global merge and no hand-written interface. This is the counterpart of Hono's `c.var`/`Env` and Elysia's `derive`:

```ts
import { withState } from 's200';

const withUser = withState<{ user: User }>(async (ctx, next) => {
  ctx.state.user = await loadUser(ctx); // X keys are writable in the injector
  await next();
});

const app2 = use(app, withUser);        // App<State & { user: User }>
get(app2, '/me', (ctx) => json(ctx, ctx.state.user)); // User, typed
```

Injections accumulate by intersection across `use` calls and arguments, and an injector may consume earlier injections — its second type parameter declares what it reads, and `use` enforces the order at compile time:

```ts
const withProfile = withState<{ profile: Profile }, { user: User }>(async (ctx, next) => {
  ctx.state.profile = await loadProfile(ctx.state.user); // reads { user }
  await next();
});
use(use(app, withUser), withProfile); // ok
use(app, withProfile);                // type error — { user } not injected yet
```

The brand travels by scope, with two caveats:

- **App-wide (the global form).** `use(app, withUser)` widens `S` for the whole app; every later middleware, handler, and registrar sees the accumulated intersection.
- **Prefix-scoped.** `use(app, '/api', withUser)` does **not** widen the app's `S`. The brand is parked in the app's compile-time scoped log (`App`'s phantom `G` parameter) and intersected into exactly the routes whose pattern falls under the prefix — segment-wise, the same way the runtime guard dispatches: `/api`, `/api/users/:id`, and param prefixes (`/users/:uid`) match their routes; `/apiv2` does not. Handlers outside the prefix keep the loose `State` view, and app-level middlewares still type against the plain `S`. Route-chain middlewares on a matching route see the scoped keys too — they run inside the guard.
- **Route chains.** `get(app, '/x', withUser, handler)` threads the chain's brands into that route's handler: `ctx.state` is the app `S`, the matching scoped brands, and the chain's brands intersected. The thread ends at the handler — chain middlewares type against the app `S` plus the matching scoped brands, not against *earlier chain* brands, so a `withState<X, S>` consumer with an explicit read type cannot sit in the same chain (compose it through `use` instead, where the order is enforced).
- **Dynamic strings stay conservative.** A non-literal prefix or pattern (a `string` variable) cannot be prefix-matched at compile time — the runtime scoping still applies, the types stay loose. Route patterns *wider* than the prefix (`/:tenant/x` under `/admin`) are invisible the same way: the overlap is real at runtime, but not expressible as subtyping.
- **Long chains.** Each global injection widens `S`, and every later `use`/registrar call instantiates the accumulated intersection. Measured, 60 chained injections × 60 routes still typecheck in about a second on the repo's checker — the real cost past a few dozen injections is ergonomics (hover display and error messages listing every key), so past roughly that size collapse them into one explicit `interface MyState extends State` and a single `createApp<MyState>()`.

`withState` is the identity function — zero runtime cost; the brand (`_state`) rides the type exactly like `throws`' `_errors` and the gates' `_in`. Batteries publishing a documented state slot (à la `requestId`) can brand the same way, and `defineMiddleware` preserves the full branded type.

## Context fields

`ctx.url` is the parsed request URL (reuse it — no re-parsing). `ctx.signal` is the request's cooperative-cancellation `AbortSignal`. In the node adapter it aborts when the client disconnects mid-request (Cloudflare passes the platform's disconnect signal automatically), `timeout` aborts it at the deadline, and long-running work should race it (the body readers do). Apps that want the last bit of floor throughput can pass `abortOnDisconnect: false` — a shared never-aborted signal, no per-request `AbortController`, worth roughly 8% on minimal hello-path apps. Middlewares may swap the signal on the way in (`AbortSignal.any([...])`) and should restore it on unwind. After `await next()` settles, `ctx.res` is always materialized — the handler's response, the 404/405/500 fallback, **or the error response**: an error boundary inside the chain maps thrown errors before the unwind, so middlewares observe (and may overwrite) the real response even for 500s. This is what lets logger/CORS/request-id stamp error responses. `ctx.route` is the matched route object by reference (`undefined` on 404/405 fallbacks) — read-only, and the anchor for per-route lookups on the unwind (`s200/response-check` keys its schema lookup off it).

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

Branded injectors scoped this way type only the routes under the prefix — `use(app, '/api', withUser)` leaves the app-wide `S` untouched and hands `ctx.state.user: User` to `/api/…` handlers alone (see [inferred injection](#inferred-injection-withstate) above).

