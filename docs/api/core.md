# Core API (`s200`)

The core barrel: application data, routing, onion composition, error values, and the dispatch entry point. Everything here is a named export from `s200` — no classes, no `new App()`.

The barrel also re-exports the [response helpers, body readers, and `serveStatic`](/api/respond) — `json`, `text`, `html`, `send`, `redirect`, `newResponse`, `escapeHtml`, `utf8Length`, `readText` / `readJson` / `readForm` / `readStream`, and `serveStatic` (plus the `StatusedResponse`, `JsonResponse`, `BodyOptions`, `StaticFileInfo`, and `ServeStaticOptions` types) — so one import surface serves the whole request/response cycle.

## Types

| Type | Shape |
| --- | --- |
| `Params` | `Record<string, string>` — path params captured from `:name` / `*name` |
| `QueryOf<QS>` | `QueryOf<'page&limit'>` → `Partial<Record<'page' \| 'limit', string \| string[]>>` — compile-time query-string shape |
| `State` | `interface { [key: string]: unknown }` — per-request state bag; extend via `declare module 's200'` |
| `Next` | `() => Promise<void>` — the onion's inner layer |
| `Middleware<S>` | `(ctx: Ctx<Params, S>, next: Next) => Promise<void> \| void` |
| `Handler<P, S, O>` | `(ctx: Ctx<P, S>) => O \| Promise<O>` — may return a `Response` (adopted as `ctx.res`), `JsonResponse` (branded), or nothing |
| `Ctx<P, S>` | `{ req, url, params, query, state, signal, res? }` — the per-request unit of mutation |
| `Segment` | `{ _tag: 'static'; value } \| { _tag: 'param'; name; optional } \| { _tag: 'wildcard'; name }` |
| `RouteDef` | `{ method, pattern, … }` — one registration's compile-time signature |
| `Route` | Immutable registration entry produced by `createRoute` |
| `MatchResult` | `{ route, params } \| { allowedMethods }` — the latter feeds the 405 `Allow` list |
| `MatchFn` | `(routes, method, pathname) => MatchResult \| undefined` — pluggable router |
| `ErrorHandler<S>` | `(ctx, error) => Promise<void> \| void` — maps a thrown value to a response |
| `NotFoundHandler<S>` | `(ctx) => Promise<void> \| void` — last chance to answer; default is a 404 |
| `Plugin<S>` | `(app: App<S>) => void` — extension hook over the mutable app data |
| `HandleInit` | `{ signal?: AbortSignal }` — `handle`'s optional init; the signal composes with the adapter's own cancellation |

### Phantom type channels

Handler/gate return types carry compile-time brands (never runtime data):

- `ResolveOut<O>` / `ResolveStatus<O>` — the body/status a handler's return declares (from `JsonResponse`'s `_out` / `_status`)
- `ChainIn<Ms>` — the merged input shape a route's gates declare (`_in` phantom, e.g. `jsonBody`'s parse type)
- `ChainErrors<Ms>` / `OutErrors<O>` / `RouteErrors<Ms, O>` — the error branches a route may answer with (`throws` gates + returned `httpError` values)
- `BranchesOf<O>` — the status → body pairs a handler's return union declares; consumed by `s200/client`
- `UnionToIntersection<T>` — turns a union of function types into an overload set

## `createApp(options?)` → `App<S, R>`

```ts
const app = createApp<MyState>({ strict: false });
```

An `App` is plain data: `{ routes, middlewares, match, onError, onNotFound, logError }`. The arrays are **snapshot-immutable** — every registration replaces them with a frozen copy, so the dispatch caches version on array identity. Mutate only through the registration functions; a direct `push` throws.

`AppOptions`:

| Field | Default | Meaning |
| --- | --- | --- |
| `match` | trie matcher | Pluggable `MatchFn` — swap in a radix tree without touching `App` |
| `strict` | `true` | Trailing-slash tolerance of the default matcher (`false` = `/users/` matches `/users`) |
| `onError` | — | Custom error mapping; runs inside the chain |
| `onNotFound` | 404 | Custom unmatched-request answer |
| `logError` | `console.error` | Sink for unexpected (non-`HttpError`) errors when no custom `onError` is set; the client always sees the anonymous 500 |

`R` is a phantom parameter — a compile-time log of registered `method` + `pattern` literals, consumed by `s200/client`. It never appears in the runtime shape.

## Registration

```ts
use(app, mw);                                   // global middleware
use(app, '/admin', adminMw, auditMw);         // prefix-scoped middlewares
usePlugin(app, plugin);                       // (app) => void extension hook
mount(app, '/v1', v1App);                     // mount a sub-app's routes under a prefix
addRoute(app, route);                         // raw Route registration
get / post / put / patch / del / head / options / all (app, pattern, handler, middlewares?)
removeRoute(app, method, pattern);            // runtime filter (typed twin: RouteFilter)
```

- `use(app, prefix, …mws)` scopes by pathname prefix (params allowed, e.g. `/users/:id`); a prefix with no middlewares throws.
- `mount` joins patterns (`'/v1'` + `'/users/:id'` → `'/v1/users/:id'`), scopes the sub-app's middlewares onto each mounted route, and never mutates the sub-app. The parent's `match`/`onError`/`onNotFound` apply; empty sub-app middlewares are lost. Type-level, `MountedDefs<R, Base>` logs the mounted defs — patterns prefixed under the base (a sub-app rooted at `/` collapses onto the bare prefix) with the `out`/`status`/`in`/`errors`/`branches` phantom channels riding along — so a mounted app keeps its typed client surface; `MountBase` normalizes the prefix and `MergeRecords` unions overlapping phantom keys.
- Method registrars (`get`, `post`, …) overload on the handler's params type: `get(app, '/users/:id', (ctx) => …)` types `ctx.params` through `ParamsOf<'/users/:id'>`.
- `all` registers for every method; such routes are skipped by OpenAPI emission.

## `handle(app, request, init?)` → `Promise<Response>`

The whole dispatch contract. Matches the route, builds the `Ctx`, runs the chain, and materializes the response — handler responses, 404/405/500 fallbacks, and error responses all exist **inside** the chain, so unwind middlewares (logger, cors, request-id) always observe the real status. `init.signal` composes with the adapter's cancellation; the URL is reused from the request when the adapter cached it.

## `compose(middlewares)` → `(ctx, next?) => Promise<void>`

Koa-compose semantics: downstream in registration order, upstream in reverse. A throw rejects the chain; a second `next()` before settlement rejects with `Error('next() called multiple times')`. The optional trailing `next` continues into an outer chain, so composed chains are composable.

## `defineMiddleware(mw)` → `M`

The published identity for third-party battery authors: wrap a `(ctx, next)` function to publish it as a reusable s200 battery. Zero runtime cost — the identity function. It exists for discoverability (one importable symbol to author against) and as the attachment point for battery tooling, and it preserves the middleware's full type — including the phantom `_in` gate brands (`jsonBody`'s parse type, `queryParams`' read type) that route registrars and `s200/client` consume. See [Battery Authoring](/guides/battery-authoring).

## Router primitives (core barrel)

These ship from the core barrel — `import { matchRoutes } from 's200'` — not a separate package entry:

| Function | Meaning |
| --- | --- |
| `createSegments(pattern)` | Parses `:param` / `:param?` / terminal `*wildcard` into `Segment[]` |
| `createRoute(method, pattern, handler, middlewares?)` | Builds one immutable `Route` (method normalized uppercase) |
| `matchSegments(segments, pattern, pathname)` | Matches a parsed pattern against a pathname |
| `matchRoutes(routes, method, pathname, strict?)` | The trie matcher: static-prefix nodes, plain lists, indexed secondary maps |
| `createMatcher({ strict? })` | A `MatchFn` over `matchRoutes` — what `createApp` installs by default |
| `ParamsOf<P>` | `ParamsOf<'/users/:id'>` → `{ id: string }` — compile-time param shape |

## Errors (`s200` errors)

```ts
export type HttpError = { status: number; message: string; body?: unknown };

httpError<S extends number, B>(status, message?, body?): HttpError & { status: S; body?: B };
isHttpError(e): e is HttpError;          // duck typing — never instanceof
toErrorResponse(error): Response;        // any thrown value → Response
throws(401, 404);                        // declares error branches (type-level)
throws<{ 401: { error: string } }>({ … });
```

- `httpError` requires an integer status in `[400, 599]`; `body` rides through `toErrorResponse` verbatim instead of the default `{ error: message }` envelope.
- `throws(...)` is a type-level declaration (a no-op middleware): it brands the route's error channel so `s200/client`'s response union names the statuses and bodies.
