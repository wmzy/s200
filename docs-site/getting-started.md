---
# Site-only page (no docs/ source); suppress the GitHub edit link.
editLink: false
---

# Getting Started

s200 is a data + functions server framework for the Web Standard — koa-style onion middleware, hono-style multi-runtime portability, and a fully tree-shakable, replaceable module surface. Zero dependencies.

The application is **plain data** and every capability is a function: `use(app, mw)`, `get(app, pattern, handler)`, `handle(app, request)`. No classes, no `new App()`, no `app.get(...)` — so bundlers can drop every capability you don't import.

This tutorial builds a real API from zero: scaffold, routes, batteries, validation, tests, OpenAPI docs, and a generated typed client. Every step is copy-pasteable; the end state exists as a runnable example in the repo ([`examples/crud-openapi`](https://github.com/wmzy/s200/tree/main/examples/crud-openapi)).

## 0. Prerequisites

- **Node.js ≥ 20.3** is the runtime floor for s200 itself (compiled JavaScript).
- This tutorial (and the scaffold) runs `.ts` sources directly through Node's native type stripping. That needs **Node ≥ 23.6, or ≥ 22.18**, with no flags; on Node 22.6–22.17 prefix commands with `NODE_OPTIONS=--experimental-strip-types`; older Node cannot run `.ts` at all.
- Or skip all of the above: the scaffold works the same, and any bundler workflow (vite, tsup, esbuild) compiles to plain JS first.
- Bun and edge runtimes work too — pick them at step 1 (see [adapters](/guides/adapters)).

## 1. Scaffold the project

```sh
npm create s200@latest my-api
cd my-api
npm install
```

In an interactive terminal the scaffolder asks one question:

```text
Target runtime (node/bun/cloudflare):
```

Pick `node` to follow this tutorial verbatim (the non-interactive default). Flags exist for CI: `--runtime node`, `--template rest` (a fuller REST slice; `minimal` is the default), `--force`.

## 2. What you got

Five files, no build step:

| File          | What it is                                                          |
| ------------- | ------------------------------------------------------------------- |
| `app.ts`      | the application itself — plain data plus route registrations        |
| `server.ts`   | the production entry: `serve` from the Node adapter, nothing else   |
| `app.test.ts` | tests on `node:test`, driving `app.ts` in-process via `s200/test`   |
| `package.json`| scripts: `dev` (s200 dev), `start` (node server.ts), `test`         |
| `README.md`   | the template's own notes                                            |

The whole app, `app.ts`:

```ts
import type { App } from 's200';

import { createApp, get, json } from 's200';

export const app: App = createApp();

get(app, '/', (ctx) => json(ctx, { hello: 'world' }));

get(app, '/hello/:name', (ctx) => json(ctx, { hello: ctx.params.name }));
```

That's the entire framework surface: `createApp()` returns a plain object, `get` (and `post`, `put`, `del`, `use`, …) register into its route table. There is no class to instantiate and no plugin system — [routing](/guides/routing), [middleware](/guides/middleware), and [responding](/guides/responding) are all functions over that one data structure. `server.ts` is deliberately separate — the app stays runtime-agnostic so the same `app.ts` can be served by [any adapter](/guides/adapters):

```ts
import { serve } from 's200/node';

import { app } from './app.ts';

const server = await serve(app, { port: Number(process.env.PORT ?? 3000) });
console.log(`listening on ${server.url}`);
```

## 3. Dev server: hot reload + 404 hints

```sh
npm run dev        # runs: s200 dev ./app.ts
```

`s200 dev` prints the route table at startup, then watches your files. A save **swaps the route table atomically** — in-flight requests finish on the old chain while new requests hit the fresh one. No process restart, no port churn.

Try it: with the server running, add a typo'd request:

```sh
curl localhost:3000/helo/ada
# {"error":"Not Found","hint":"did you mean GET /hello/:name?"}
```

That's the dev-only 404 hint middleware (on by default; `--no-hints` disables it). Useful flags: `--port N` (default `$PORT` or 3000), `--host H`, `--watch DIR` (repeatable), `--env-file FILE`, `--overlay` (browser error overlay). See [Dev / hot reload](/guides/batteries#dev-hot-reload).

## 4. Add a param route

Edit `app.ts` — the dev server picks it up on save:

```ts
get(app, '/users/:id', (ctx) => json(ctx, { id: ctx.params.id }));
```

```sh
curl localhost:3000/users/42
# {"id":"42"}
```

`ctx.params` is typed from the pattern literal (`{ id: string }` here), values arrive percent-decoded, and `:id?` optionals / `*rest` wildcards work as you'd expect — details in [routing](/guides/routing).

## 5. Add batteries: CORS + logging

Batteries are opt-in package entries — importing one pulls only it:

```ts
import { use } from 's200';
import { cors } from 's200/cors';
import { logger } from 's200/logger';

use(app, cors({ origin: 'https://app.example', credentials: true }));
use(app, logger());
```

`cors` answers preflights in place and stamps headers on the unwind — including fallback 404/500 responses, because every response is materialized inside the chain. `logger` prints one line per request (`ISO-time METHOD path status duration`) with the always-real status, 500s included. The full battery index — auth, JWT, rate-limit, sessions, websockets, … — is in [batteries](/guides/batteries).

## 6. Validate request bodies (Standard Schema)

`s200/validate` is schema-library-free but speaks the vendor-neutral [Standard Schema](https://standardschema.dev) shape: anything with a `~standard` prop slots into `jsonBody` directly. Here is a minimal hand-rolled one — zero dependencies, same channel zod uses:

```ts
import { post } from 's200';
import { jsonBody } from 's200/validate';
import type { StandardSchema } from 's200/validate';

type NewUser = { readonly name: string; readonly email: string };

const newUserSchema: StandardSchema<NewUser> = {
  '~standard': {
    version: 1,
    vendor: 'my-api',
    validate: (data) => {
      if (typeof data !== 'object' || data === null) {
        return { issues: [{ message: 'body must be a JSON object' }] };
      }
      const { name, email } = data as { name?: unknown; email?: unknown };
      if (typeof name !== 'string' || name.trim() === '') {
        return { issues: [{ message: 'name must be a non-empty string', path: ['name'] }] };
      }
      if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(email)) {
        return { issues: [{ message: 'email must be an email address', path: ['email'] }] };
      }
      return { value: { name: name.trim(), email: email.trim().toLowerCase() } };
    },
  },
};

const users = new Map<string, NewUser>();

post(app, '/users', jsonBody(newUserSchema), (ctx) => {
  const input = ctx.state.validated as NewUser;   // the schema's parsed output
  users.set(input.email, input);
  return json(ctx, { email: input.email }, { status: 201 });
});
```

```sh
curl -s -X POST localhost:3000/users -H 'content-type: application/json' \
  -d '{"name":"ada lovelace","email":"ada@example.com"}'
# {"email":"ada@example.com"}                     — 201
curl -i -X POST localhost:3000/users -H 'content-type: application/json' \
  -d '{"name":"","email":"nope"}'                 # 422, first issue's message
```

The gate maps the first reported issue to a single `422 HttpError`; invalid JSON is a `400` from the body reader before the schema ever runs; the parsed output lands on `ctx.state.validated` for the handler. Prefer a real library? `jsonBody(z.object({ … }))` — or valibot, typebox, arktype — drops into the same slot unchanged ([validate](/guides/batteries#validate)).

## 7. Write a test

`s200/test`'s `request()` dispatches in-process with full app semantics — route chains, scoped middleware, fallbacks. The scaffold's `app.test.ts` already uses it on plain `node:test`; extend it:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { request } from 's200/test';

import { app } from './app.ts';

test('POST /users creates (201) and rejects (422)', async () => {
  const ok = await request(app, '/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'ada', email: 'ada@example.com' }),
  });
  assert.equal(ok.status, 201);

  const bad = await request(app, '/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '', email: 'nope' }),
  });
  assert.equal(bad.status, 422);
});
```

```sh
npm test
```

No port is ever bound. `testClient(app)` gives you the same dispatch behind the typed client, and `probeApp(app)` smoke-probes every registered route — see [Test](/api/openapi#test-s200-test).

## 8. Publish the API: metadata → OpenAPI → docs

The route table is already the spec — annotate it, and the OpenAPI document derives from it at runtime. No code generation step, no schema library:

```ts
import { describeApp, describeRoute } from 's200/meta';
import { openapiJson } from 's200/openapi';
import { swaggerUi } from 's200/swagger';

describeApp(app, { title: 'My API', version: '1.0.0' });

// describe AFTER registering the route — the annotation is keyed by the
// route object itself.
describeRoute(app, 'GET', '/users/:id', {
  summary: 'Fetch one user',
  tags: ['users'],
  responses: {
    200: { description: 'the user' },
    404: {
      description: 'no such user',
      schema: {
        type: 'object',
        properties: { error: { type: 'string' } },
        required: ['error'],
      },
    },
  },
});

get(app, '/openapi.json', (ctx) => openapiJson(ctx, app));
get(app, '/docs', (ctx) => swaggerUi(ctx, { url: '/openapi.json', title: 'My API' }));
```

```sh
curl -s localhost:3000/openapi.json | head -c 300
# {"openapi":"3.1.0","info":{"title":"My API","version":"1.0.0"},…
open http://localhost:3000/docs      # Scalar API reference, zero deps
```

Unannotated routes still appear with their params and a bare 200 — the table is the source of truth, metadata only enriches it. Error `throws` gates on a route's chain become error responses too. Full story: [OpenAPI & tooling](/api/openapi).

## 9. Generate a typed client

The same table that served the spec emits the client. One command:

```sh
npx s200 codegen ./app.ts --out client.ts --name createMyClient
```

Or programmatically — `generateClient(app)` returns the TypeScript source:

```ts
import { generateClient } from 's200/codegen';
await writeFile('client.ts', generateClient(app, { name: 'createMyClient' }));
```

The emitted module is self-contained (path filling, query sugar, JSON-body handling — zero s200 imports), deterministic (registration order, no timestamps — it diffs and commits like hand-written source), and **typed from the same annotations**: params from each pattern, `init.body` from `meta.body`, and a status-discriminated response union from the declared responses and `throws` gates — `if (res.status === 404)` narrows `res.json()`. Details in [codegen](/api/openapi#codegen-s200-codegen).

This loop — **route table → OpenAPI → validation → typed client → tests, one source of truth** — is the payoff of the app being data. [`examples/crud-openapi`](https://github.com/wmzy/s200/tree/main/examples/crud-openapi) is the complete, runnable version of it.

## 10. Deploy

`app.ts` never changes; only the entry does.

- **Node** — `npm start` is already the shape. For production wire `lifecycle` for graceful drain plus a health endpoint: [deployment](/guides/deployment).
- **Bun** — swap the adapter: `import { serve } from 's200/bun'`. Same app, same routes.
- **Cloudflare Workers** — `s200/cloudflare` wraps `handle(app, request)` for the platform's event shape; the scaffold offers it as a runtime choice.

Everything about production — Dockerfiles, drain ordering, readiness gates, bind/host knobs — lives in the [deployment guide](/guides/deployment).

## Where to go next

- Guides: [Routing](/guides/routing) · [Middleware](/guides/middleware) · [Responding](/guides/responding) · [Body parsing](/guides/body) · [Static files](/guides/static-files)
- [Batteries](/guides/batteries) — cors, logger, auth, jwt, rate-limit, websocket, and friends
- [OpenAPI & tooling](/api/openapi) — route table, metadata, spec, swagger, codegen, client, test
- [API Reference](/api/core) — every module's exports, signatures, and options
- [Errors](/guides/errors) · [Adapters](/guides/adapters) · [Package surface](/guides/package-surface)
- [Compare s200 with other frameworks](/comparison) · [Benchmarks](/benchmarks) · [Migration guides](/migration-from-express)
- Runnable examples in the repo: [`examples/`](https://github.com/wmzy/s200/tree/main/examples)

The full documentation also ships in the repo under [`docs/`](https://github.com/wmzy/s200/tree/main/docs) — the site includes it verbatim. 中文版: [简体中文](/zh/getting-started).
