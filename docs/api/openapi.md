# OpenAPI & Tooling (`s200/route-table`, `s200/meta`, `s200/openapi`, `s200/swagger`, `s200/codegen`, `s200/client`, `s200/test`)

The route table as the API surface: export it, annotate it, emit OpenAPI 3.1 from it, serve a docs UI, generate clients from it, and test against it — all from the same plain data.

## Route table (`s200/route-table`)

The `data + functions` payoff: the app is plain data, so it exports as JSON without executing anything.

```ts
createRouteTable(app);
// { routes: [{ method: 'GET', pattern: '/users/:id', params: ['id'], middlewareCount: 1 }, …] }
```

`createRouteTable(app)` → `RouteTable`: `{ routes: readonly RouteTableEntry[] }`.

`formatRouteTable(table)` renders that table as aligned ASCII — `METHOD  PATTERN`, one line per registration, the method column padded to the longest method present (an empty table renders as an empty string). The `s200 routes` command and the dev runner's startup report print exactly this.

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

`RouteMeta`: `{ summary?, description?, tags?, deprecated?, query?: Record<string, QueryParam>, params?: Record<string, QueryParam>, body?: SerializeSchema, responses?: Record<number, { description: string; schema?: SerializeSchema }>, security?: ReadonlyArray<Record<string, readonly string[]>> }`. `AppMeta`: `{ title?, version?, description? }`.

A `QueryParam` is the parameter's `SerializeSchema` bare (optional — the default), or the `{ schema, required: true }` marker form when the request must carry the key. The marker is one flag with three synchronized views: `openapiSpec` emits `parameters[].required: true`, `withRouteValidation` answers a missing key with a `422` (`'query.<key>: required'`), and `s200/mcp`'s tool input schema lists the name under `required`. `querySchemaOf(entry)`/`isQueryRequired(entry)` (from `s200/meta`) unwrap either form for custom tooling.

`params` annotates path parameters — the `id` of `/users/:id` — with the same entry forms: `openapiSpec` emits the entry's JSON Schema as the path parameter's schema (unannotated parameters keep the bare `{ type: 'string' }`), and `withRouteValidation` checks the captured value (`'params.<key>: …'` on failure; a `required` marker rejects an optional segment's absence). The emitted `required` stays segment-driven (`:id` required, `:id?` optional) — OpenAPI pins every path parameter to the segment it fills. For runtime schemas over the captured params (or headers) with a Standard Schema vendor, see `s200/validate`'s `validateParams`/`validateHeaders` gates.

`SerializeSchema` also accepts an optional `title` on every node — a pure annotation: `toJsonSchema` carries it into the emitted JSON Schema, serialization and validation ignore it, and the spec emitter uses it to name deduplicated schemas (below).

`security` is OpenAPI's requirement shape — one entry per alternative (OR), each entry mapping a scheme name to its required scopes (`[]` when the scheme needs none). It lands on the operation verbatim; declare the schemes themselves via `openapiSpec`'s `securitySchemes` option.

## OpenAPI (`s200/openapi`)

The OpenAPI 3.1 document comes out of the route table directly — no code generation, no execution, no schema library. Every route becomes a path item; `RouteMeta` annotations fill in summaries, query/params/body schemas, security requirements, and response shapes. Unannotated routes still appear with their params and a bare 200. Error branches declared by `throws` gates on a route's chain become error `responses` too (see below). `ALL` routes are skipped (no single method to document) with one `console.warn` per distinct pattern per app (deduped for the process lifetime) — `[s200] openapi: route /x uses ALL — expand to explicit methods to document it`; dynamic-pattern routes emit with their pattern verbatim.

```ts
import { openapiJson } from 's200/openapi';
get(app, '/openapi.json', (ctx) => openapiJson(ctx, app));   // serve the spec
const spec = openapiSpec(app, { title: 'Users API', version: '1.0.0' });
```

`openapiSpec`'s options (and `openapiJson`'s optional third parameter) are the `info` block plus two document-level extras:

| Field | Default | Meaning |
| --- | --- | --- |
| `title` / `version` | (required) | The OpenAPI `info` block |
| `description` | — | `info.description` |
| `servers` | — | `ReadonlyArray<{ url: string; description?: string }>` — emitted verbatim as the document's `servers` (omitted when absent or empty) |
| `securitySchemes` | — | `Record<string, SecuritySchemeObject>` — emitted under `components.securitySchemes`, referenced by name from `RouteMeta.security` |
| `refSchemas` | `true` | Pass `false` to disable schema dedup (see below) and keep every schema inline |

`SecuritySchemeObject` is OpenAPI 3.1's scheme shape, kept permissive (s200 emits data, it does not validate it): `{ type: 'apiKey' | 'http' | 'oauth2' | 'openIdConnect' | 'mutualTLS', description?, name?, in?, scheme?, bearerFormat?, flows?, openIdConnectUrl? }` — the non-`type` fields are the ones each flavor reads.

**Error responses from `throws` gates.** A route whose chain carries `throws` gates gets their statuses emitted as error responses. The bare form (`throws(401, 404)`) documents the default `{ error: string }` envelope; the record form (`throws({ 422: { issues: ['x'] } })`) infers the schema structurally from the record's example value — strings/booleans/null map directly, integrality splits `integer` from `number`, arrays describe their items when every element agrees, objects list the keys present (required-ness is unknowable from an example, so no key is `required`). Gates merge with `meta.responses` without clobbering: a status only one side declares is emitted, and on conflict **`meta.responses` wins** — its description and schema were written for the spec, the gate's example is only an inference seed. Several gates naming the same status: the later registration wins (the type layer unions body shapes; example values cannot).

**Schema dedup into `components.schemas`.** Any query, params, body or response schema that occurs **≥2 times** in the document (structural JSON equality — distinct-but-equal objects dedup too) is hoisted into `components.schemas` and every occurrence becomes `{ "$ref": "#/components/schemas/<name>" }`. The name is the schema's `title` when the DSL carries one, else a synthetic `Schema1`, `Schema2`, … in first-occurrence order — deterministic, so specs diff cleanly across builds; colliding titles (same `title`, different JSON) get `_2`, `_3`, … suffixes. Schemas that occur once stay inline (no pointless fragmentation), and `components.securitySchemes` merges into the same `components` object untouched. Pass `refSchemas: false` to keep everything inline.

**Schema pass-through.** `toJsonSchema` forwarding covers exactly the fields a `SerializeSchema` carries at runtime — `type`, `properties`/`required`, `items`, `nullable`, `title`. The DSL has no `enum`/`format`/`description`/bounds markers, so none are invented.

| Function | Meaning |
| --- | --- |
| `openapiSpec(app, options)` | The `OpenApiDocument` — `{ openapi: '3.1.0', info, servers?, components?, paths }`, JSON-compatible by construction |
| `openapiJson(ctx, app, options?)` | Response helper: the spec as a JSON response (`info` fields fall back to `describeApp`; `servers`/`securitySchemes`/`refSchemas` pass through verbatim) |
| `withRouteValidation(app)` | Pure data transform (mount's family) that rebuilds only routes carrying a `body`, `query` or `params` annotation, checking requests with `compileValidator` from `s200/serialize` |

`withRouteValidation` is the runtime twin of the spec: a violation answers `422` naming every offending path — `error` keeps the first (`{"error":"body.tags.1: expected string, got number"}`) while `issues` carries the full list with scope-qualified paths, all built by the `validationError` helper shared with `s200/validate`; valid input flows on untouched — nothing lands on `ctx.state` and nothing is coerced (query values stay strings, so `?page=2` against `{ type: 'integer' }` is a 422 — use `s200/query`'s `queryParams` when you want parsing). Query keys marked required (`{ schema, required: true }`) are isomorphic to the spec: the key's absence answers the same 422 (`{"error":"query.format: required"}`); an empty value (`?format=`) counts as present, and a present value is still checked against its schema. `params` entries check the captured path parameter the same way (`'params.<key>: …'` — captured values stay strings too); a `required` marker rejects an optional segment's absence (`{"error":"params.name: required"}`). The spec and the gates share one source: annotations are re-attached to the rebuilt routes. The response side has the same twin — [`s200/response-check`](/api/response-check) runs `responses[status].schema` against the materialized response on the unwind.

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
| `document` | Scalar CDN shell | Full HTML document override, served **verbatim** — the air-gapped escape hatch: vendor Scalar yourself and point the shell at your own assets. A string, or a `() => string \| Promise<string>` factory resolved per request. When set it wins over everything else: `url`/`title`/`theme`/`cdn` are ignored and nothing is escaped (still `text/html` with an honest `content-length`) |

Every interpolated value runs through `escapeHtml`, so a hostile `url`/`title`/`theme` cannot break out of an attribute or the document.

## Codegen (`s200/codegen`)

`generateClient(app)` returns the TypeScript source of a self-contained, **typed** client module derived from the app's **runtime** route table plus its `s200/meta` annotations and `throws` declarations — no build-time plugin, no reflection; the table is the spec. The emitted module has zero s200 imports: params, path filling, query-string and JSON-body logic are emitted inline, so the generated file runs anywhere web fetch runs, with no s200 in `node_modules`. Output is deterministic — registration order, no timestamps — so it diffs and commits like hand-written source.

```ts
import { generateClient } from 's200/codegen';
await writeFile('src/api/client.ts', generateClient(app, { name: 'createUsersClient', baseUrl: 'https://api.example' }));
```

`GenerateClientOptions`: `{ name? (default 'createClient'), baseUrl?, fetcherName? (default 'fetcher') }`.

Where the types come from — exactly what exists at runtime:

- **Params** from each pattern: `/users/:id` → `args: { id: string }`, `/posts/:postId?` → `{ postId?: string }`, `*path` wildcards included.
- **Query** from `meta.query`: `init.query` narrows to the declared keys — optional by default (`{ query?: { verbose?: boolean } }`); a `{ schema, required: true }` marker drops the `?` (`{ query?: { format: string } }`), matching the spec's `parameters[].required` and the gate's 422.
- **Request body** from `meta.body`: `init.body` retypes to the schema's shape and `init` becomes **required** (the route reads a body, the caller must send one). A JSON-shape body is stringified at call time with a default `content-type: application/json` unless one is set — s200/client's rule; strings and structured bodies (streams, blobs, forms, buffers) pass to fetch untouched.
- **Responses** from `meta.responses` merged with the route's `throws` gates (meta wins a status both declare): one `Branch<S, T>` member per status — a `Response` whose `status` is the branch's literal and whose `json()` resolves to the branch's body type — so `if (res.status === 404)` narrows the body. Throws examples infer structurally, same as the spec emitter.

The honest contract: handlers' own `json()` body brands are compile-time phantoms the runtime table cannot see — anything neither `meta` nor `throws` declares types `unknown`, and routes with no declarations at all keep the bare `Promise<Response>`. For inference straight off the handler types, use `createClient` from `s200/client` against the app itself.

## Client (`s200/client`)

Type-safe fetch client derived from an app's route table — the `data + functions` payoff on the calling side. `createClient(app)` builds, at creation time, one path-filling function per registered route; the `Client<R>` type (driven by the app's phantom route log) restricts calls to registered pattern literals with typed params.

```ts
import { createClient } from 's200/client';
const client = createClient(app, { baseUrl: 'https://api.example' });
const res = await client.get('/users/:id', { id: '1' });   // typed params, typed response union
const user = await (await client.get('/users/:id', { id: '1' })).json();
```

The client sends plain `fetch` requests (any base URL, any `fetch` implementation) and returns Web Standard `Response`s — it adds nothing to the wire protocol: an s200 client talks to any server that speaks the same patterns.

`ClientOptions` carries `signal` and `timeoutMs` beyond `baseUrl`/`fetch`: `signal` rides every request (a per-call `init.signal` overrides it for that call), and `timeoutMs` opens a **fresh per-request** `AbortSignal.timeout` window — when both are set the effective signal and the timeout are raced via `AbortSignal.any` (manual listener linkage on runtimes without it; the Node floor, 20.3, has it), so one composite signal aborts with whichever fired first.

Without a `baseUrl` the client needs a URL base to resolve against: browsers and edges have `globalThis.location` and relative URLs keep working, but in Node `createClient` **throws at creation time** with a message advising `options.baseUrl` — instead of a confusing per-request `TypeError` from fetch. An injected `fetch` owns URL resolution itself, so the guard fires only when the global `fetch` would be called.

`options.middleware` is the interceptor hook — auth-header injection, retry, tracing: `ClientMiddleware[]` in **onion order** (the first entry is the outermost layer). Each entry is `(req, next) => Promise<Response>` over the **fully built** `Request` — URL filled, query appended, JSON body stringified, effective signal stamped — and the innermost `next` is the fetch itself; `next` may be awaited more than once (retry), and the request it takes may be a rebuilt copy (`new Request(req, { headers })`) so per-attempt headers, body or signal can be swapped:

```ts
const authAndRetry: ClientMiddleware[] = [
  async (req, next) => {
    const headers = new Headers(req.headers);
    headers.set('authorization', `Bearer ${token}`);
    return next(new Request(req, { headers }));
  },
  async (req, next) => {
    const res = await next(req);
    return res.status === 503 ? next(req) : res;   // one bounded retry
  },
];
const client = createClient(app, { baseUrl: 'https://api.example', middleware: authAndRetry });
```

Abort semantics are unchanged and belong to the *call*, not the attempt: the effective signal (per-call `init.signal`, else `signal`, raced with `timeoutMs`) is stamped once on the `Request`, so aborting it ends the whole call — retries included — and a `timeoutMs` window is one window per call, not per attempt. A middleware wanting per-attempt limits swaps the signal itself (`new Request(req, { signal: AbortSignal.any([req.signal, AbortSignal.timeout(1000)]) })`). Two contracts to know: with middleware set every call is materialized as a `Request` before the chain, so a *relative* path needs a base the runtime can resolve (`baseUrl`, or a runtime `location`) even when `fetch` is injected — absolute patterns are unaffected; and a non-function entry is options-level misuse, thrown at `createClient` time with the offending index (the same contract as the missing-`baseUrl` guard).

| Function / Type | Meaning |
| --- | --- |
| `createClient(app, options?)` | `Client<R>` — eight method namespaces over the app's route log; each call names a registered pattern literal with typed params |
| `Client<R>` | Eight method namespaces — `get`, `post`, `put`, `patch`, `delete` (with the `del` alias), `head`, `options` — each holding the call signatures of that method's routes; patterns registered under other methods type as `never` |
| `ClientInit` | `RequestInit & { query?: Record<string, string \| number \| boolean \| readonly (…)[] \| undefined> }` — array values repeat the key, `undefined` is skipped, numbers/booleans stringify |
| `ClientMiddleware` | `(req: Request, next: (req: Request) => Promise<Response>) => Promise<Response>` — one interceptor over the fully built request; the innermost `next` is the fetch, `next` re-issues on retry |
| `ClientOptions` | `{ baseUrl?, fetch?, signal?, timeoutMs?, middleware? }` — base URL prepended to every path; injectable fetch for tests and edge runtimes; client-level abort signal; per-request timeout in milliseconds (raced with the signal, default: none); interceptor chain in onion order (first entry outermost, non-function entries throw at creation) |
| `ClientResponse<S, T>` | The status-discriminated response union: `res.status` narrows `res.json()`'s type |
| `BranchResponse<S, T>` | One branch: `{ status: S } & Response` with the body type `T` |

Route call signatures: params are **required** exactly when the pattern captures them (`:id`), **optional** when declared (`:id?`), absent for plain patterns (the `init` moves up one position). Input phantoms ride the same signature: a `jsonBody` gate types (and demands) `init.body`, a `bodyShape<T>()` gate demands `init.body` as its declared structured type (the client encodes from the runtime value: a plain object/array is JSON-stringified with a default `content-type: application/json`; `FormData`/`Blob`/streams ride to fetch untouched), a `queryParams` gate narrows `init.query`, a `requiresHeaders` gate demands `init.headers` as a `Record<string, string>` with the declared keys required (extra keys still allowed); error branches from `throws` gates and returned `httpError` values name the error statuses in the response union.

## Test (`s200/test`)

In-process testing primitives — the full app semantics (route chains, scoped middlewares, `onError`/`onNotFound`, the 404/405/500 fallbacks) come free because `handle` is the whole dispatch contract.

| Function | Meaning |
| --- | --- |
| `request(app, input, init?)` | Dispatches one request in-process — the testing equivalent of hono's `app.request()`. Relative string inputs (`'/users/1'`) resolve against `http://s200.test`; `URL` and `Request` inputs pass through |
| `testClient(app)` | A typed `Client` routed entirely in-process: `createClient` with a fetch that loops back into `request` — path filling, query sugar and the phantom route log are the real client's; only transport is swapped |
| `probeApp(app, options?)` | Smoke-probes every registered route: dispatches the route's own method against a synthesized matching pathname (captures filled with `'p' + name`), in registration order; `'ALL'` routes are probed once per method in `options.methodsForAll` (default `['GET', 'POST']`) |

`ProbeRow`: `{ method, pattern, status, ok }` — `ok` is `status < 500`. The probe is a contract, not a correctness suite: every route must *answer*, and params are synthesized from the pattern so a miss can never masquerade as a 404. One `probeApp(app)` call in a test pins the whole surface.
