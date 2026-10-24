# Migrating from Fastify to s200

Fastify and s200 agree on the important things: a route table, scoped middleware, validation at the edge, and JSON everywhere. The difference is substrate — Fastify is an instance with lifecycle hooks and plugin encapsulation; s200 is plain data with top-level functions, and every hook maps to one of two middleware shapes.

## The mechanical mapping

| Fastify | s200 |
|---|---|
| `fastify()` | `createApp()` |
| `app.get('/users/:id', handler)` | `get(app, '/users/:id', handler)` |
| `app.post` / `put` / `patch` / `delete` / `head` / `options` | `post` / `put` / `patch` / `del` / `head` / `options` registrars |
| `app.addHook('onRequest', fn)` | `use(app, fn)` — work before `await next()` |
| `app.addHook('preValidation', fn)` | a middleware — params are already decoded; validation is your gate's job |
| `app.addHook('preHandler', fn)` | route-scoped middlewares: `get(app, path, mw, handler)` |
| `app.addHook('onSend', fn)` | a stamper on the unwind — rewrite headers after `await next()` |
| `app.addHook('onError', fn)` / `app.setErrorHandler(fn)` | `createApp({ onError })` |
| `app.setNotFoundHandler(fn)` | `createApp({ onNotFound })` |
| `app.register(plugin, { prefix: '/v1' })` | `mount(app, '/v1', subApp)` — snapshot semantics (below) |
| `app.decorate('db', db)` | `createApp<{ db: Db }>()` + `ctx.state.db`, or `withState` |
| route `schema: { body, response }` | `jsonBody(schema)` gate in + `serialize(schema)` out |
| `reply.code(201).headers(h).send(body)` | `json(ctx, body, { status: 201, headers: h })` |
| `reply.status(204).send()` | `send(ctx, null, { status: 204 })` — no content-length advertised |
| `request.body` / `request.query` | `await readJson(ctx)` / `ctx.query` |
| `request.params` | `ctx.params.id` (typed from the pattern literal) |
| `app.inject({ method, url })` (testing) | `request(app, url, { method })` from `s200/test` |
| `app.listen({ port: 3000 })` | `serve(app, { port: 3000 })` from `s200/node` |
| `app.addHook('onClose', fn)` | `lifecycle(server, { onShutdown: fn })` from `s200/lifecycle` |
| `app.ready()` / boot ordering | none needed — registration is synchronous data |

### `@fastify/*` plugins → s200 batteries

| Fastify plugin | s200 |
|---|---|
| `@fastify/cors` | `cors()` from `s200/cors` |
| `@fastify/helmet` | `secureHeaders()` from `s200/secure-headers` |
| `@fastify/jwt` | `s200/jwt` — `signJwt` / `jwtAuth` (route-scoped gate) |
| `@fastify/cookie` | `s200/cookies` — `getCookie` / `setCookie` |
| `@fastify/session` | `s200/session` — `createSession` |
| `@fastify/rate-limit` | `s200/rate-limit` — `rateLimit` (sliding window) |
| `@fastify/formbody` | `readForm(ctx)` — urlencoded **and** multipart, one call |
| `@fastify/multipart` | `streamForm` from `s200/multipart`, or `uploadForm` from `s200/upload` |
| `@fastify/static` | `serveStatic` (core barrel) over the adapter's injected readers |
| `@fastify/swagger` | `s200/openapi` (spec from the live route table) + `s200/swagger` (Scalar UI) |
| `@fastify/under-pressure` | `s200/health` — `readiness({ db: ping })` + `createGate()` |

## Where s200 differs architecturally

1. **Plugins are data transforms, not scopes.** Fastify's `register` builds an encapsulated child context: hooks and decorators added inside don't leak out, and the child stays live — register more routes after `registerPlugin` resolves and they serve. `mount(app, '/v1', sub)` is a **snapshot**: it copies the sub-app's routes and middlewares at call time, never mutates the sub, and post-mount registration on `sub` stays invisible to the mount. The sub's `onError` is carried per mounted route; its `onNotFound` and custom `match` cannot travel (the parent dispatches mounted routes) and are dropped with one `console.warn` per `mount`. If you need the register-later pattern, mount after all sub registrations, or mount a fresh sub per version.

2. **Hooks collapse into one shape.** Fastify spreads the request lifecycle across named hooks; s200 has exactly two middleware shapes — work before `await next()` (onRequest/preValidation/preHandler territory) and work after it (onSend/onResponse territory). There is no preParsing hook because there is no eager body read: bodies are read in the handler (`readJson`, `readForm`), counted against their limit *before* buffering. And the unwind sees a real response, always — see next point.

3. **The error contract runs inside the chain.** Fastify's `setErrorHandler` (and its hooks) run after the route chain unwinds — middleware cannot observe the 500 it produced. s200 wraps route chain and fallbacks in an inner error boundary: the error response is materialized *before* the unwind starts, so `await next()` resolving means `ctx.res` exists, 500s included — logger/CORS/request-id stamp the real error response. Gate rejections (`jwtAuth` 401, `rateLimit` 429 with `Retry-After` + IETF `RateLimit-*`) take the same path, so `onError` owns the policy for them too.

4. **Validation and serialization are separate, explicit gates.** Fastify compiles one JSON Schema per route — `schema.body` guards input, `schema.response` shapes output. s200 splits the two directions: input flows through a gate (`jsonBody` from `s200/validate` — a hand-rolled parse fn, any Standard Schema library, or the JSON-Schema DSL of `s200/openapi`; the parsed value lands on `ctx.state.validated`), output flows through `serialize` from `s200/serialize` — a schema'd serializer emitting exactly the declared keys with an exact `content-length`. Plain `json(ctx, …)` remains the honest default; nothing implicit ever rewrites your payload. A wrong-method request answers RFC 9110 `405` + `Allow` (Fastify answers 404).

5. **`decorate` becomes state, at three granularities.** Instance-level decorations map to `createApp<{ db: Db }>()` (per-app shape) or a plain module-level import — the pool is just a value. Per-request decorations map to `ctx.state` via `withState(async (ctx, next) => { ctx.state.user = …; await next(); })`, which *types* the slot for everything downstream, no global merge. Reply decorations are unnecessary — the respond helpers take `{ status, headers }` directly.

## Common patterns

**A schema'd route — Fastify:**

```ts
app.post('/users', {
  schema: {
    body: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    response: { 201: { type: 'object', properties: { id: { type: 'integer' } } } },
  },
}, async (request, reply) => {
  const user = await db.create(request.body);
  reply.code(201).send({ id: user.id });
});
```

**The same route in s200 — the two directions are two explicit gates:**

```ts
import { createApp, get, httpError, json, post, send } from 's200';
import { jsonBody } from 's200/validate';
import { jsonRaw, serialize } from 's200/serialize';

const userOut = serialize({
  type: 'object',
  properties: { id: { type: 'integer' }, name: { type: 'string' } },
  required: ['id', 'name'],
});

post(
  app,
  '/users',
  jsonBody((data) => {
    if (typeof data !== 'object' || typeof (data as { name?: unknown }).name !== 'string') {
      throw httpError(422, 'name must be a string');
    }
    return data as { name: string };
  }),
  async (ctx) => {
    const user = await db.create(ctx.state.validated as { name: string });
    return jsonRaw(ctx, userOut(user), { status: 201 });
  },
);
```

**An auth plugin → a route-scoped gate:**

```ts
import { jwtAuth } from 's200/jwt';

// fastify: app.register(jwt, { secret }) + app.addHook('onRequest', app.jwtAuth)
get(app, '/me', jwtAuth({ secret }), (ctx) => json(ctx, ctx.state.jwt));
```

**`onSend` header rewriting → an unwind stamper:**

```ts
use(app, async (ctx, next) => {
  await next();                 // ctx.res is guaranteed set here — 500s included
  ctx.res.headers.set('x-request-id', ctx.state.requestId ?? '');
});
```

**`setErrorHandler`/`setNotFoundHandler`:**

```ts
const app = createApp({
  onError: (ctx, error) => {
    const status = isHttpError(error) ? error.status : 500;
    json(ctx, { error: String((error as { message?: string }).message) }, { status });
  },
  onNotFound: (ctx) => json(ctx, { error: 'no such route' }, { status: 404 }),
});
```

## Gotchas

- **No `reply.raw` / `reply.hijack()`** — the response is a web-standard `Response`. Return one directly for full control, or use `stream()` / `streamSSE()` from `s200/streaming` for streaming bodies.
- **`onResponse` (after the socket flushes) is not a core hook** — the unwind stamper sees the materialized response when `next()` settles, which covers logging needs; anything strictly post-send belongs in the adapter.
- **`request.body` has no eager equivalent** — the handler awaits `readJson(ctx)`/`readForm(ctx)`; the parse is cached per request context, so multiple reads replay from one buffer.
- **`app.log` (Pino) is not built in** — bring your own logger and inject it, or use the `logger()` battery with its `sink`/`format` seams.
- **`content-length` is set explicitly** by the respond helpers (platforms serialize lazily) — HEAD keeps the would-be size, and `etag`/`compress` key on that signal. A bare `new Response('…')` carries no length; `send()`/`json()` do.
- **Type providers (fastify `TypeBox` generics on reply/request)** map to s200's literal-pattern inference — `ctx.params` is typed from `'/users/:id'` itself, and `throws(404)` types the error branch for `s200/client`'s response union.
