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

No `class`, no `new App()`, no `app.get(...)` method calls. The payoff is mechanical: bundlers can drop every capability you don't import (`verify:tree-shaking` asserts the core minimal import weighs ~1.3 KB min+gz), and the core translates directly to `struct + procedure` shapes in any language.

## Installation

```sh
npm install s200
```

- Node.js ≥ 20.3 (adapter: `s200/node`), Bun (adapter: `s200/bun`). Deno/edge runtimes can consume the core directly — it only touches Web Standard `Request`/`Response`.
- `s200` — the runtime-agnostic core
- `s200/node` — node:http adapter (`serve`, `createFileReader`)
- `s200/bun` — Bun.serve adapter (`serve`, `createFileReader`)

## Routing

Patterns use `:name` params and a terminal `*name` wildcard; matching is strict (no trailing-slash tolerance), first registration wins, `ALL` matches every method, and `HEAD` falls back to `GET` routes.

```ts
get(app, '/users/:id', (ctx) => text(ctx, ctx.params.id));   // ctx.params.id: string — inferred
get(app, '/files/*path', (ctx) => text(ctx, ctx.params.path)); // captures the rest incl. '/'
```

The pattern literal drives the type: `ParamsOf<'/users/:id/posts/:postId'>` is `{ id: string; postId: string }`, so `ctx.params` is fully typed inside literal-pattern handlers. The router itself is replaceable — pass a custom `match` to `createApp` and the whole matching strategy is yours:

```ts
const app = createApp({ match: myTrieMatcher });
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

`ctx.state` is a fresh mutable bag per request — the typed hand-off channel between middlewares and handlers.

## Responding

Response helpers write `ctx.res` in place (init headers always win over the defaults):

```ts
json(ctx, { ok: true });                 // application/json
text(ctx, 'plain', { status: 201 });     // text/plain; charset=utf-8
html(ctx, '<h1>hi</h1>');                // text/html; charset=utf-8
redirect(ctx, '/login');                 // 302
send(ctx, bytes, { headers: { 'content-type': 'application/pdf' } });
```

Handlers may also simply **return** a `Response` — it is written for you when nothing has been written yet. If a matched chain finishes without writing anything, s200 answers `500 {"error":"No response written"}`; an unmatched, unwritten request goes to `onNotFound` (default `404`).

## Body parsing

```ts
const body = await readJson<Login>(ctx); // invalid JSON → 400 HttpError
const raw = await readText(ctx);
const form = await readForm(ctx);        // FormData (urlencoded + multipart)
```

Bodies are single-read by platform contract; s200 caches the parse per request context, so multiple reads (and mixed json/text reads) replay from one buffer instead of throwing.

## Static files

All I/O is injected — the core never touches a filesystem. Adapters ship `createFileReader`, but any `read` works (memory, S3, embedded):

```ts
import { serveStatic } from 's200';
import { createFileReader } from 's200/node';

use(app, serveStatic({
  read: createFileReader('public'),
  root: 'public',
  prefix: '/static',  // mount point, stripped before lookup
  spa: true,          // html navigation misses fall back to index.html
}));
```

Traversal (`..`) never escapes the root, `index` (default `index.html`) serves directory paths, and misses fall through to `next()` so other routes can answer.

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

Unhandled `HttpError`s render as `{ status, body: { "error": message } }`; anything else renders a generic 500 (never leaking internals).

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

Everything is a named export from the core barrel (`s200`) — tree-shaking starts at the import statement. The Node/Bun adapters are separate entries (`s200/node`, `s200/bun`) so their runtime imports never enter a bundle that doesn't ask for them.

## Development

```sh
pnpm build                 # vite lib build (es + cjs, 3 entries) + d.ts/d.mts emission
pnpm test                  # vitest watch
pnpm test:run -- --run     # single run (112 tests)
pnpm lint / lint:ci
pnpm check:paradigm        # enforces data + functions (no class/this/new/extends in src)
pnpm verify:tree-shaking   # asserts unused modules are shaken from a minimal bundle
pnpm smoke                 # runs scripts/smoke.mjs under node AND bun
```

## License

MIT
