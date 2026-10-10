---
# Site-only page (no docs/ source); suppress the GitHub edit link.
editLink: false
---

# Getting Started

s200 is a data + functions server framework for the Web Standard — koa-style onion middleware, hono-style multi-runtime portability, and a fully tree-shakable, replaceable module surface. Zero dependencies.

The application is **plain data** and every capability is a function: `use(app, mw)`, `get(app, pattern, handler)`, `handle(app, request)`. No classes, no `new App()`, no `app.get(...)` — so bundlers can drop every capability you don't import.

## Install

```sh
npm install s200
```

- Node.js ≥ 20.3 → adapter `s200/node`; Bun → adapter `s200/bun`. Deno and edge runtimes consume the core directly.
- Opt-in batteries (`s200/cors`, `s200/logger`, `s200/validate`, …) are separate package entries — importing one pulls only it.

## Hello world

```ts
import { createApp, get, json, post, use, readJson } from 's200';
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

## Next steps

- Guides: [Routing](/guides/routing) · [Middleware](/guides/middleware) · [Responding](/guides/responding) · [Body parsing](/guides/body) · [Static files](/guides/static-files)
- [API Reference](/api/core) — every module's exports, signatures, and options
- [Batteries](/guides/batteries) — cors, logger, auth, jwt, rate-limit, websocket, and friends
- [Errors](/guides/errors) · [Adapters](/guides/adapters) · [Package surface](/guides/package-surface)
- [Compare s200 with other frameworks](/comparison) · [Benchmarks](/benchmarks) · [Migration guides](/migration-from-express)

The full documentation also ships in the repo under [`docs/`](https://github.com/wmzy/s200/tree/main/docs) — the site includes it verbatim. 中文版: [简体中文](/zh/).
