# Core API (`s200`)

The core barrel: application data, routing, onion composition, error values, and the dispatch entry point. Everything here is a named export from `s200` — no classes, no `new App()`.

The barrel also re-exports the [response helpers, body readers, and `serveStatic`](/api/respond) — `json`, `text`, `html`, `send`, `redirect`, `setHeader` / `setHeaders` (plus the low-level `drainPendingHeaders`), `newResponse`, `escapeHtml`, `utf8Length`, `readText` / `readJson` / `readForm` / `readStream`, and `serveStatic` (plus the `StatusedResponse`, `JsonResponse`, `BodyOptions`, `StaticFileInfo`, and `ServeStaticOptions` types) — so one import surface serves the whole request/response cycle.

## Types

| Type | Shape |
| --- | --- |
| `Params` | `Record<string, string>` — path params captured from `:name` / `*name` |
| `QueryOf<QS>` | `QueryOf<'page&limit'>` → `Partial<Record<'page' \| 'limit', string \| string[]>>` — compile-time query-string shape |
| `State` | `interface { [key: string]: unknown }` — per-request state bag; extend via `declare module 's200'` |
| `Next` | `() => Promise<void>` — the onion's inner layer |
| `Middleware<S>` | `(ctx: Ctx<Params, S>, next: Next) => Promise<void> \| void` |
| `StateMiddleware<X, S>` | `Middleware<S> & { readonly _state?: X }` — a state injector's compile-time identity: `S` is what it reads, the `_state` phantom names what it writes onto `ctx.state`; produced by `withState`, collected by `use` |
| `StateOf<Ms>` | The state a middleware list injects — every member's `_state` brand intersected (`unknown`, the identity, when none carries one) |
| `Handler<P, S, O>` | `(ctx: Ctx<P, S>) => O \| Promise<O>` — may return a `Response` (adopted as `ctx.res`), `JsonResponse` (branded), or nothing |
| `Ctx<P, S>` | `{ req, url, params, query, state, signal, route, res? }` — the per-request unit of mutation; `route` is the matched route by reference (`undefined` on 404/405 fallbacks) |
| `Segment` | `{ _tag: 'static'; value } \| { _tag: 'param'; name; optional } \| { _tag: 'wildcard'; name }` |
| `RouteDef` | `{ method, pattern, … }` — one registration's compile-time signature |
| `Registrar<M>` | The shared signature of every method registrar (`get`, `post`, …): literal-pattern and dynamic-pattern overloads appending one `RouteDef` |
| `AddRoute` | The dynamic-method registrar's signature — `addRoute(app, method, pattern, chain)` with the def's method branded `Uppercase<M>` |
| `RoutesBuilder<S, R>` | The chainable builder `routes(app)` returns — one method per registrar plus `use`/`mount`, each returning the builder with the phantom log appended, and `.app` exposing the typed `App` |
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
- `ChainIn<Ms>` — the merged input shape a route's gates declare (`_in` phantom — `jsonBody`'s parse type, `queryParams`' read, `requiresHeaders`' keys, `bodyShape`'s structured type)
- `StateOf<Ms>` — the state a `use` argument list injects (`_state` phantom — `withState`'s brand), intersected into the app's `S` so handlers read the keys typed
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
| `logError` | context line + error | Sink for unexpected (non-`HttpError`) errors when no custom `onError` is set; receives `(error, ctx)` (additive — `(error) => void` sinks keep working). Default prints `[s500] <method> <pathname>[ <request id>]` then the error via `console.error` — the id is the request-id battery's `state.requestId` (whatever header name it uses), falling back to a literal `x-request-id` header; the client always sees the anonymous 500 |

`R` is a phantom parameter — a compile-time log of registered `method` + `pattern` literals, consumed by `s200/client`. It never appears in the runtime shape.

## Registration

```ts
use(app, mw);                                   // global middleware
use(app, withState<{ user: User }>(injectUser)); // global injector — widens S
use(app, '/admin', adminMw, auditMw);         // prefix-scoped middlewares
usePlugin(app, plugin);                       // (app) => void extension hook
mount(app, '/v1', v1App);                     // mount a sub-app's routes under a prefix
addRoute(app, 'GET', '/raw', handler);        // dynamic-method registrar (method first)
get / post / put / patch / del / head / options / all (app, pattern, handler, middlewares?)
removeRoute(app, method, pattern);            // runtime filter (typed twin: RouteFilter)

routes(app)                                    // chainable sugar over the same registrars
  .use(withState<{ user: User }>(injectUser))
  .get('/users/:id', (ctx) => json(ctx, { id: ctx.params.id }))
  .post('/users', createUser);
```

- `use(app, prefix, …mws)` scopes by pathname prefix (params allowed, e.g. `/users/:id`); a prefix with no middlewares throws.
- `use` also threads the state channel: every argument branded by `withState` contributes its `_state` phantom, and the returned app's `S` becomes `S & X` — downstream middlewares and handlers read the injected keys typed. Plain middlewares contribute nothing and keep the type unchanged; the brand collection is app-wide (the prefix form cannot narrow it to the prefix's routes) and route chains don't thread it — see the `withState(mw)` section below.
- `mount` joins patterns (`'/v1'` + `'/users/:id'` → `'/v1/users/:id'`), scopes the sub-app's middlewares onto each mounted route, and never mutates the sub-app. The sub-app's `onError` is carried: every mounted route is wrapped in a route-scoped error boundary that applies it (a response the sub `onError` writes wins; a decline rethrows, so the parent's policy maps it — including a crashing sub handler). `onNotFound` and a custom `match` cannot travel (the parent dispatches mounted routes) and are dropped with one `console.warn` per `mount` call when the sub-app actually defines them; empty sub-app middlewares are lost. Type-level, `MountedDefs<R, Base>` logs the mounted defs — patterns prefixed under the base (a sub-app rooted at `/` collapses onto the bare prefix) with the `out`/`status`/`in`/`errors`/`branches` phantom channels riding along — so a mounted app keeps its typed client surface; `MountBase` normalizes the prefix and `MergeRecords` unions overlapping phantom keys.
- Method registrars (`get`, `post`, …) overload on the handler's params type: `get(app, '/users/:id', (ctx) => …)` types `ctx.params` through `ParamsOf<'/users/:id'>`.
- `routes(app)` is pure sugar: each builder method (`get`/`post`/`put`/`patch`/`del`/`head`/`options`/`all`/`use`/`mount`) delegates 1:1 to the plain registrar and registers on `app` immediately, then returns the builder. The phantom `App` type threads through the chain exactly like the plain registrars, so `s200/client` inference works off the builder's `.app` (the very object passed in) identically: `createClient(routes(app).get('/x', h).app)`.
- `all` registers for every method; such routes are skipped by OpenAPI emission.

## `handle(app, request, init?)` → `Promise<Response>`

The whole dispatch contract. Matches the route, builds the `Ctx`, runs the chain, and materializes the response — handler responses, 404/405/500 fallbacks, and error responses all exist **inside** the chain, so unwind middlewares (logger, cors, request-id) always observe the real status. `init.signal` composes with the adapter's cancellation; the URL is reused from the request when the adapter cached it.

## `compose(middlewares)` → `(ctx, next?) => Promise<void>`

Koa-compose semantics: downstream in registration order, upstream in reverse. A throw rejects the chain; a second `next()` before settlement rejects with `Error('next() called multiple times')`. The optional trailing `next` continues into an outer chain, so composed chains are composable.

## `defineMiddleware(mw)` → `M`

The published identity for third-party battery authors: wrap a `(ctx, next)` function to publish it as a reusable s200 battery. Zero runtime cost — the identity function. It exists for discoverability (one importable symbol to author against) and as the attachment point for battery tooling, and it preserves the middleware's full type — including the phantom `_in` gate brands (`jsonBody`'s parse type, `queryParams`' read type) that route registrars and `s200/client` consume. See [Battery Authoring](/guides/battery-authoring).

## `withState(mw)` → `StateMiddleware<X, S>`

```ts
const withUser = withState<{ user: User }>(async (ctx, next) => {
  ctx.state.user = await loadUser(ctx); // X keys are writable in the injector
  await next();
});
const app2 = use(app, withUser); // App<State & { user: User }, R>
get(app2, '/me', (ctx) => json(ctx, ctx.state.user)); // User, typed
```

Brands a middleware as a state injector: `X` names the keys it writes onto `ctx.state` before `next()`, and `use` collects the `_state` phantom into the app's `S` (`S & X`) — downstream middlewares and handlers read the injected keys typed, with no hand-written app state interface and no global `declare module` merge. (The `onError`/`onNotFound` policy callbacks are typed at `createApp` time, before any injection — they observe the injected values at runtime, typed by their own declaration.) The second type parameter (default: the global `State`) is what the middleware may READ — pass it explicitly when the injector consumes earlier injections; `use` then enforces the injection order at compile time. Injections accumulate by intersection across `use` calls and arguments; plain middlewares are the identity case (their contribution collapses, the app's type is unchanged).

The identity function — zero runtime cost, the brand rides the type like `throws`' `_errors`. Boundaries: the collected type is app-wide (the prefix-scoped `use` form cannot narrow it to the prefix's routes — prefix-scoped injection is a programmer's assertion, like a hand-written `createApp<MyState>`), and a branded middleware inside a route's own chain runs but does not thread its brand into the handler's `ctx.state`. Long chains (dozens of injections) stay fast; past that, collapse to an explicit `interface MyState` — see [Middleware: inferred injection](/guides/middleware#inferred-injection-withstate).

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
export type HttpError = { status: number; message: string; body?: unknown; headers?: Record<string, string> };

httpError<S extends number, B>(status, message?, body?, headers?): HttpError & { status: S; body?: B };
isHttpError(e): e is HttpError;          // duck typing — never instanceof
toErrorResponse(error): Response;        // any thrown value → Response
throws(401, 404);                        // declares error branches (type-level)
throws<{ 401: { error: string } }>({ … });
```

- `httpError` requires an integer status in `[400, 599]`; `body` rides through `toErrorResponse` verbatim instead of the default `{ error: message }` envelope; `headers` (a `Record<string, string>`, e.g. a gate's `www-authenticate` challenge or `retry-after` + IETF `RateLimit-*`) merges onto the error response, so a rejection can take the error-boundary path (`onError` included) instead of being answered in place.
- `throws(...)` is a pass-through middleware for request handling: it brands the route's error channel so `s200/client`'s response union names the statuses and bodies — and the same declaration is now readable at runtime (`_errors` on the gate), which is how `s200/openapi` documents the error branches and `s200/codegen` emits them into typed clients.
