# OpenAPI & Tooling (`s200/route-table`, `s200/meta`, `s200/openapi`, `s200/swagger`, `s200/codegen`, `s200/client`, `s200/test`)

The route table as the API surface: export it, annotate it, emit OpenAPI 3.1 from it, serve a docs UI, generate clients from it, and test against it — all from the same plain data.

## Route table (`s200/route-table`)

The `data + functions` payoff: the app is plain data, so it exports as JSON without executing anything.

```ts
createRouteTable(app);
// { routes: [{ method: 'GET', pattern: '/users/:id', params: ['id'], middlewareCount: 1 }, …] }
```

`RouteTableEntry`: `{ method: string; pattern: string; params: readonly string[]; middlewareCount: number }` — param names in capture order (`:id`, then `*rest`); the functions themselves are not serializable, so only the middleware count travels. Handy for route listing or cross-language translation — and `s200/openapi` builds on the same table.

## Metadata (`s200/meta`)

Pure annotations stored off-app in a `WeakMap` keyed by the route objects themselves, so the core `App` shape stays untouched and tree-shaking keeps the metadata out of every non-OpenAPI consumer. Schemas reuse `SerializeSchema` (`s200/serialize`).

```ts
describeApp(app, { title: 'Users API', version: '1.0.0' });
describeRoute(app, 'GET', '/users/:id', {
  summary: 'Fetch one user',
  responses: { 200: { description: 'ok', schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } } },
});
```

| Function | Meaning |
| --- | --- |
| `describeRoute(app, method, pattern, meta)` | Annotates every route registered for `method` (normalized uppercase) + `pattern`; no-op when nothing matches — describe after registration |
| `describeApp(app, meta)` | Annotates the app itself (the OpenAPI `info` block) |
| `getRouteMeta(route)` / `getAppMeta(app)` | Read back what was set |

`RouteMeta`: `{ summary?, description?, tags?, deprecated?, query?: Record<string, SerializeSchema>, body?: SerializeSchema, responses?: Record<number, { description: string; schema?: SerializeSchema }> }`. `AppMeta`: `{ title?, version?, description? }`.

## OpenAPI (`s200/openapi`)

The OpenAPI 3.1 document comes out of the route table directly — no code generation, no execution, no schema library. Every route becomes a path item; `RouteMeta` annotations fill in summaries, query/body schemas, and response shapes. Unannotated routes still appear with their params and a bare 200. `ALL` routes are skipped (no single method to document); dynamic-pattern routes emit with their pattern verbatim.

```ts
import { openapiJson } from 's200/openapi';
get(app, '/openapi.json', (ctx) => openapiJson(ctx, app));   // serve the spec
const spec = openapiSpec(app, { title: 'Users API', version: '1.0.0' });
```

| Function | Meaning |
| --- | --- |
| `openapiSpec(app, info)` | The `OpenApiDocument` — `{ openapi: '3.1.0', info, paths }`, JSON-compatible by construction |
| `openapiJson(ctx, app, init?)` | Response helper: the spec as a JSON response |
| `withRouteValidation(app)` | Pure data transform (mount's family) that rebuilds only routes carrying a `body` or `query` annotation, checking requests with `compileValidator` from `s200/serialize` |

`withRouteValidation` is the runtime twin of the spec: a violation answers `422` naming the first offending path (`{"error":"body.tags.1: expected string, got number"}`); valid input flows on untouched — nothing lands on `ctx.state` and nothing is coerced (query values stay strings, so `?page=2` against `{ type: 'integer' }` is a 422 — use `s200/query`'s `queryParams` when you want parsing). The spec and the gates share one source: annotations are re-attached to the rebuilt routes.

## Swagger UI (`s200/swagger`)

Serves the Scalar API Reference page — the assets load from a pinned CDN, so s200 stays zero-dependency:

```ts
import { swaggerUi } from 's200/swagger';
get(app, '/docs', (ctx) => swaggerUi(ctx, { url: '/openapi.json', title: 'Users API' }));
```

`SwaggerUiOptions`:

| Field | Default | Meaning |
| --- | --- | --- |
| `url` | (required) | URL of the OpenAPI document — typically the `openapiJson` route |
| `title` | `'API Reference'` | Page `<title>` |
| `theme` | Scalar default | Scalar theme name (`default`, `alternate`, `moon`, `kepler`, …) |
| `cdn` | pinned `@scalar/api-reference` build | Scalar bundle URL — override for a self-hosted mirror |

Every interpolated value runs through `escapeHtml`, so a hostile `url`/`title`/`theme` cannot break out of an attribute or the document.

## Codegen (`s200/codegen`)

`generateClient(app)` returns the TypeScript source of a self-contained client module derived from the app's **runtime** route table — no build-time plugin, no reflection; the table is the spec. The emitted module's only s200 touch is a types-only `ParamsOf` import; path filling and query-string logic are emitted inline, so the generated file runs anywhere web fetch runs, with no s200 in `node_modules`. Output is deterministic — registration order, no timestamps — so it diffs and commits like hand-written source.

```ts
import { generateClient } from 's200/codegen';
await writeFile('src/api/client.ts', generateClient(app, { name: 'createUsersClient', baseUrl: 'https://api.example' }));
```

`GenerateClientOptions`: `{ name? (default 'createClient'), baseUrl?, fetcherName? (default 'fetcher') }`.

The honest contract: the route table is runtime data, so no request/response body types exist — every generated method returns `Promise<Response>`; read bodies with `.json()`/`.text()`. For compile-time-typed bodies use `createClient` from `s200/client` against the app itself.

## Client (`s200/client`)

Type-safe fetch client derived from an app's route table — the `data + functions` payoff on the calling side. `createClient(app)` builds, at creation time, one path-filling function per registered route; the `Client<R>` type (driven by the app's phantom route log) restricts calls to registered pattern literals with typed params.

```ts
import { createClient } from 's200/client';
const client = createClient(app, { baseUrl: 'https://api.example' });
const res = await client.get('/users/:id', { id: '1' });   // typed params, typed response union
const user = (await client.get('/users/:id', { id: '1' })).json();
```

The client sends plain `fetch` requests (any base URL, any `fetch` implementation) and returns Web Standard `Response`s — it adds nothing to the wire protocol: an s200 client talks to any server that speaks the same patterns.

| Function / Type | Meaning |
| --- | --- |
| `createClient(app, options?)` | `Client<R>` — one method per route (`getApiV1Users`-style names), restricted to registered pattern literals |
| `ClientInit` | `RequestInit & { query?: Record<string, string \| number \| boolean \| readonly (…)[] \| undefined> }` — array values repeat the key, `undefined` is skipped, numbers/booleans stringify |
| `ClientOptions` | `{ baseUrl?, fetch? }` — base URL prepended to every path; injectable fetch for tests and edge runtimes |
| `ClientResponse<S, T>` | The status-discriminated response union: `res.status` narrows `res.json()`'s type |
| `BranchResponse<S, T>` | One branch: `{ status: S } & Response` with the body type `T` |

Route call signatures: params are **required** exactly when the pattern captures them (`:id`), **optional** when declared (`:id?`), absent for plain patterns (the `init` moves up one position). Input phantoms ride the same signature: a `jsonBody` gate types (and demands) `init.body`, a `queryParams` gate narrows `init.query`; error branches from `throws` gates and returned `httpError` values name the error statuses in the response union.

## Test (`s200/test`)

In-process testing primitives — the full app semantics (route chains, scoped middlewares, `onError`/`onNotFound`, the 404/405/500 fallbacks) come free because `handle` is the whole dispatch contract.

| Function | Meaning |
| --- | --- |
| `request(app, input, init?)` | Dispatches one request in-process — the testing equivalent of hono's `app.request()`. Relative string inputs (`'/users/1'`) resolve against `http://s200.test`; `URL` and `Request` inputs pass through |
| `testClient(app)` | A typed `Client` routed entirely in-process: `createClient` with a fetch that loops back into `request` — path filling, query sugar and the phantom route log are the real client's; only transport is swapped |
| `probeApp(app, options?)` | Smoke-probes every registered route: dispatches the route's own method against a synthesized matching pathname (captures filled with `'p' + name`), in registration order; `'ALL'` routes are probed once per method in `options.methodsForAll` (default `['GET', 'POST']`) |

`ProbeRow`: `{ method, pattern, status, ok }` — `ok` is `status < 500`. The probe is a contract, not a correctness suite: every route must *answer*, and params are synthesized from the pattern so a miss can never masquerade as a 404. One `probeApp(app)` call in a test pins the whole surface.
