# Testing

s200's dispatch is one function — `handle(app, request)` — and that is the whole testing story. There is no server to boot, no port to allocate, no plugin lifecycle to await: build the app from the same pieces production uses, drive it in-process, get real web-standard `Response`s back. The `s200/test` entry packages the three primitives; the guides below are how the repository itself tests batteries and examples.

## The three primitives

| Function | Use it when |
|---|---|
| `request(app, input, init?)` | You are testing **behavior** — one request through the full pipeline (scoped middlewares, gates, `onError`/`onNotFound`, the 404/405/500 fallbacks). This is the workhorse, the testing equivalent of hono's `app.request()` and Fastify's `app.inject()` |
| `testClient(app)` | You are testing the **typed round trip** — a `createClient` whose fetch loops back into `request`, keeping the typed paths/params/bodies (`init.body`, `init.query` phantoms) while swapping only the transport |
| `probeApp(app, options?)` | You want a **surface contract** — one call dispatches every registered route with synthesized params and reports `{ method, pattern, status, ok }` per route (`ok` is `status < 500`). The probe pins "every route answers" mechanically; it is not a correctness suite |

```ts
import { request, testClient, probeApp } from 's200/test';

const res = await request(app, '/users/1');       // relative strings resolve against http://s200.test
const rows = await probeApp(app);                 // [{ method: 'GET', pattern: '/users/:id', status: 200, ok: true }, …]
```

`request` accepts a relative string, a `URL`, or a `Request`; `init` is a standard `RequestInit` (method, headers, body, signal).

## Driving the whole app in-process

Compose the app exactly as the entry file does — app-level middleware, route-scoped gates, error policy — then drive it. Because `handle` runs the real chain, an auth flow is a sequence of ordinary `request` calls:

```ts
import { describe, expect, it } from 'vitest';
import { createApp, get, httpError, json, post, readJson, use } from 's200';
import { jwtAuth, signJwt } from 's200/jwt';
import { logger } from 's200/logger';
import { request } from 's200/test';

const SECRET = 'test-secret';
const app = createApp();
use(app, logger());                               // production middleware, in the test too

post(app, '/login', async (ctx) => {
  const { user } = await readJson<{ user: string }>(ctx);
  if (user !== 'ada') throw httpError(401, 'no such user');
  return json(ctx, { token: await signJwt({ sub: user }, SECRET) });
});
get(app, '/me', jwtAuth({ secret: SECRET }), (ctx) => json(ctx, ctx.state.jwt));

describe('the auth flow', () => {
  it('issues a token and the gate accepts it', async () => {
    const login = await request(app, '/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: 'ada' }),
    });
    const { token } = await login.json();

    const me = await request(app, '/me', { headers: { authorization: `Bearer ${token}` } });
    expect(me.status).toBe(200);
  });

  it('rejects an anonymous /me with 401', async () => {
    const res = await request(app, '/me');
    expect(res.status).toBe(401);
  });
});
```

Nothing here fakes the middleware or the gate — a test that exercises `/me` through `request` runs the same chain production runs.

## Asserting error branches

Errors are part of the contract, and the response is always materialized — assert on the real thing:

- **Status first, body second.** `res.status` discriminates the branch; `await res.json()` checks the envelope. Unhandled `HttpError`s render `{ status, body: { "error": message } }` by default; anything else is a generic 500 that never leaks internals (`expect(await res.json()).toEqual({ error: 'Internal Server Error' })`-shaped assertions stay honest).
- **Gate rejections are ordinary error branches** — `jwtAuth` 401, `rateLimit` 429 (+ `Retry-After`), `jsonBody` 422. They throw into the error boundary, so a test of your `onError` policy covers them by driving the gate's failing input.
- **Validation failures carry every issue**: a 422 from a validation gate has `error` (the first issue's summary) and an `issues` array with formatted paths — `body.items.2.name: expected string, got number`. Success bodies carry no `issues` key anywhere.
- **Headers ride the error**: `httpError(401, msg, body, { 'www-authenticate': … })` merges the record onto the error response — assert `res.headers.get('www-authenticate')` like any header.

```ts
it('names every invalid path', async () => {
  const res = await request(app, '/articles', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 42 }),
  });
  expect(res.status).toBe(422);
  expect(((await res.json()) as { issues: { path: string }[] }).issues.length).toBeGreaterThan(0);
});
```

For typed consumers, the error branch is typed where declared: a `throws(401, 404)` gate makes `s200/client`'s response union name the statuses, so `res.status` narrows `res.json()`'s type. In plain tests, discriminate with `res.status` and cast the body.

## Streams, uploads, timeouts

**Streams.** `request` returns a real `Response` — a streaming route's body is consumed like any stream. `await res.text()` drains the whole pump (the repository's own stream tests assert this way); `res.body.getReader()` reads incrementally when the *order* of frames is the assertion:

```ts
const res = await request(app, '/events');
expect(res.headers.get('content-type')).toBe('text/event-stream');
const text = await res.text();                    // drains the pump: 'data: 1\n\ndata: 2\n\n…'
```

**Uploads.** Build the `FormData` and pass it as `init.body` — no synthetic multipart wire format needed. Raw streaming bodies (testing a `streamForm` gate against a hand-crafted source) go through `new Request` with `duplex: 'half'`, then `request(app, req)`:

```ts
const form = new FormData();
form.append('file', new Blob([bytes]), 'a.png');
const res = await request(app, '/upload', { method: 'POST', body: form });
expect(res.status).toBe(201);
```

**Timeouts.** The `timeout(ms)` gate races the chain and answers 503 when the deadline wins. The repository tests this with real, short deadlines — a handler that sleeps past a 50 ms gate is a 200 ms test, deterministic enough without fake timers:

```ts
import { timeout } from 's200/timeout';

get(app, '/slow', timeout(50), async (ctx) => {
  await new Promise((resolve) => setTimeout(resolve, 200));
  return json(ctx, { never: 'seen' });
});
// …
expect((await request(app, '/slow')).status).toBe(503);
```

Client-side cancellation composes the same way: pass an `AbortSignal` in `init`, and the handler's `ctx.signal` fires — the disconnect-aware contract is testable in-process.

## Vitest conventions

The repository's own tests (the style to copy) run on vitest with these habits:

- **No beforeEach server bootstrap.** Tests build the app inline — often per test — because registration is cheap synchronous data. No ports, no teardown, no `app.close()`.
- **Drive through `request(app, …)`** (or `handle(app, new Request(…))` in core tests); assert on `.status`, `.headers`, and the parsed body. Older suites use the `.should` chain (`res.status.should.equal(401)`), newer ones `expect` — either reads fine; match the file you are editing.
- **Fake the seams, not the framework.** Batteries expose their nondeterminism as parameters (`now`, `store`, `verify`, `sink`) — pass fakes and nothing needs timers or network. The framework itself is never mocked.
- **Scoped runs while iterating:** `./node_modules/.bin/vitest run test/upload.test.ts`.

One `probeApp(app)` in a smoke test plus behavior tests on the interesting routes is the balance the examples strike: the probe pins the surface, the behavior tests pin the semantics.
