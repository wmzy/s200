# s200

A data + functions server framework for the Web Standard. Koa-style onion middleware, hono-style multi-runtime portability, and a fully tree-shakable, replaceable module surface. Zero dependencies at the core — every battery too, except `s200/events`, which builds on [`@for-fun/event-emitter`](https://www.npmjs.com/package/@for-fun/event-emitter).

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

## The paradigm: data + functions

An application is **plain data** — routes, middlewares, config. Behavior never hangs off it; every capability is a top-level function taking the app (or request context) as its first argument:

```ts
const app = createApp();       // data
use(app, logger);              // behavior: (app, middleware) => app
get(app, '/x', handler);       // behavior: (app, pattern, handler) => app
handle(app, request);          // behavior: (app, Request) => Promise<Response>
```

No `class`, no `new App()`, no `app.get(...)` method calls. The payoff is mechanical: bundlers can drop every capability you don't import (`pnpm verify:tree-shaking` proves the body/static modules vanish from a minimal bundle, and `pnpm size` gates the shipped sizes), and the core translates directly to `struct + procedure` shapes in any language.

## Installation

```sh
npm install s200
```

- Node.js ≥ 20.3 (adapter: `s200/node`), Bun (adapter: `s200/bun`). Deno/edge runtimes can consume the core directly — it only touches Web Standard `Request`/`Response`.
- `s200` — the runtime-agnostic core
- `s200/node` — node:http adapter (`serve`, `createFileReader`, `createRealPathGuard`, …)
- `s200/bun` — Bun.serve adapter (`serve`, `createFileReader`, `createRealPathGuard`, …)
- `s200/cors` / `s200/logger` / `s200/route-table` / `s200/query` / `s200/websocket` / `s200/etag` / … — opt-in batteries (see [Batteries](https://wmzy.github.io/s200/guides/batteries))

## Documentation

The full API documentation lives on the docs site — [wmzy.github.io/s200](https://wmzy.github.io/s200/) — available in English and [简体中文](https://wmzy.github.io/s200/zh/):

- **Guides**: [Routing](https://wmzy.github.io/s200/guides/routing) · [Middleware](https://wmzy.github.io/s200/guides/middleware) · [Responding](https://wmzy.github.io/s200/guides/responding) · [Body parsing](https://wmzy.github.io/s200/guides/body) · [Static files](https://wmzy.github.io/s200/guides/static-files) · [Errors](https://wmzy.github.io/s200/guides/errors) · [Adapters](https://wmzy.github.io/s200/guides/adapters) · [Batteries](https://wmzy.github.io/s200/guides/batteries) · [Package surface](https://wmzy.github.io/s200/guides/package-surface)
- **API Reference** — every module's exports, signatures, and options: [Core & routing](https://wmzy.github.io/s200/api/core) · [Responding · bodies · static](https://wmzy.github.io/s200/api/respond) · [Node](https://wmzy.github.io/s200/api/node) / [Bun](https://wmzy.github.io/s200/api/bun) / [Edge](https://wmzy.github.io/s200/api/edge) adapters · [Request intake](https://wmzy.github.io/s200/api/request) · [Security](https://wmzy.github.io/s200/api/security) · [Cookies & sessions](https://wmzy.github.io/s200/api/cookies-session) · [Response batteries](https://wmzy.github.io/s200/api/response-batteries) · [Observability](https://wmzy.github.io/s200/api/observability) · [Data & config](https://wmzy.github.io/s200/api/data) · [WebSocket](https://wmzy.github.io/s200/api/websocket) · [OpenAPI & tooling](https://wmzy.github.io/s200/api/openapi) · [Lifecycle · health · hot reload](https://wmzy.github.io/s200/api/lifecycle) · [Sharding & execution](https://wmzy.github.io/s200/api/sharding)
- **Reference**: [Stability & contracts](https://wmzy.github.io/s200/stability) · [Benchmarks](https://wmzy.github.io/s200/benchmarks) · [Comparison](https://wmzy.github.io/s200/comparison) · [Migration: from Express](https://wmzy.github.io/s200/migration-from-express) / [from Koa](https://wmzy.github.io/s200/migration-from-koa) / [from Hono](https://wmzy.github.io/s200/migration-from-hono)
- The Markdown sources live in [`docs/`](docs/) (English) and [`docs/zh/`](docs/zh/) (Chinese); the site includes them verbatim.

## Stability & versioning

s200 is heading to 1.0 with an explicit contract: the surface real apps touch — `createApp` options, the registrars, the `Ctx` guarantees (pre-decoded params, cached `url`, disconnect-aware `signal`, per-request `state`, always-materialized `res`), the respond helpers and their `content-length` contract, the error model (`httpError`/`isHttpError`/`toErrorResponse` + the `throws` gate), routing semantics (first registration wins, `HEAD`→`GET`, `405`+`Allow`, strict trailing slashes), and the battery entry map — freezes at 1.0 and changes only in majors after that. Releases are automated by semantic-release over conventional commits; before 1.0 the 0.x allowance applies (any minor may break, with migration notes), after 1.0 deprecations run the mark → migration guide → two minors rhythm. What is honestly **not** frozen yet: light-mode details, the JSR publishing flow, and the codegen output format.

The full frozen-surface list and policy: [docs/stability.md](docs/stability.md). Migration guides: [from Express](docs/migration-from-express.md), [from Koa](docs/migration-from-koa.md), [from Hono](docs/migration-from-hono.md).

## Development

```sh
pnpm build                 # vite lib build (es + cjs, 50 entries) + d.ts/d.mts emission
pnpm test                  # vitest watch
pnpm vitest run            # single run (all tests; add --maxWorkers=4 to cap concurrency)
pnpm lint / lint:ci
pnpm check:paradigm        # enforces data + functions (no class/this/new/extends in src)
pnpm verify:tree-shaking   # asserts unused modules are shaken from a minimal bundle
pnpm smoke                 # runs scripts/smoke.mjs under node AND bun
node scripts/smoke-deno.mjs # serves dist through Deno.serve and checks the core (auto-skips without deno)
pnpm bench                 # router dispatch micro-benchmark (ROUTES/ITERATIONS env)
pnpm bench:http            # whole-request throughput vs hono/express/fastify/elysia (isolated processes; + deno when installed)
pnpm docs:dev / docs:build # vitepress documentation site (docs-site/)
pnpm publish:jsr           # build + prepare declarations for JSR + npx jsr publish
```

The docs site deploys automatically to GitHub Pages (`/s200/`) by
[.github/workflows/docs.yml](.github/workflows/docs.yml) on pushes to `main`
that touch `docs-site/`, `docs/`, or the lockfile. The Pages base is set from
`GITHUB_ACTIONS` in `docs-site/.vitepress/config.mts`, so local dev and
preview stay rooted at `/`. Available in English and
[简体中文](/zh/) — `docs/` holds the English source of truth and `docs/zh/`
the Chinese translation, included verbatim into `docs-site/`.

Runnable examples live in [examples/](examples/) — `rest-jwt` (JWT-gated REST API + typed client), `sse-dashboard` (SSE ticker + static page), `ws-chat` (websocket rooms), `upload-app` (streaming multipart uploads with `s200/upload`): `pnpm --filter @s200-example/rest-jwt smoke` and friends.

See [docs/benchmarks.md](docs/benchmarks.md) for benchmark numbers and methodology, [docs/comparison.md](docs/comparison.md) for how s200 stacks up against the alternatives (Hono, Express, Fastify, Koa, Elysia), and the [migration guides](docs/) when coming from Express, Koa, or Hono.

## License

MIT
