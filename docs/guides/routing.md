# Routing

## Pattern basics

Patterns use `:name` params and a terminal `*name` wildcard; matching is strict (no trailing-slash tolerance), first registration wins, `ALL` matches every method, and `HEAD` falls back to `GET` routes. Duplicate capture names (`/users/:id/posts/:id`) are rejected at registration. Captured values are handed to handlers **percent-decoded** (`/users/foo%20bar` → `'foo bar'`) — the Express/Hono contract — while matching runs on the raw path, so an encoded `/` can never fake a segment boundary.

```ts
get(app, '/users/:id', (ctx) => text(ctx, ctx.params.id));   // ctx.params.id: string — inferred
get(app, '/files/*path', (ctx) => text(ctx, ctx.params.path)); // captures the rest incl. '/'
get(app, '/users/:id?', (ctx) => json(ctx, { id: ctx.params.id ?? null })); // id is optional
```

## Wildcards

`*name` must be the **final** segment — `/files/*path` is valid, while
`/a/*rest/b` throws at registration (`createSegments` in `src/router.ts`
rejects it: `Invalid route pattern '…': wildcard '*rest' must be the last
segment`). Two reasons, both deliberate:

- **Capture ambiguity**: a mid-path wildcard has no unambiguous capture
  rule. Greedy-to-the-end would swallow the `/b` that follows; lazy
  matching makes `/a/x/y/b` capture either `x` or `x/y` depending on
  backtracking policy — every consumer would have to know which.
- **Index integrity**: the trie indexes every static segment
  (see [Trie dispatch](#trie-dispatch)). A wildcard mid-pattern leaves the
  segments after it reachable only by scanning, eroding the sub-µs
  dispatch the design is built around.

The rule is part of the matching contract — frozen with the rest of the
routing semantics (see [stability](/stability)); revisited only in a
major.

## Optional params and trailing slashes

`/:id?` is an optional param — the segment may be absent, and `ParamsOf<'/users/:id?'>` types it as `{ id?: string }` (absent keys are omitted at runtime). Matching is greedy with backtracking, so `/x/:a?/y` matches both `/x/y` and `/x/1/y`, and chained optionals resolve left-to-right. Strict trailing slashes still hold: `/users/` keeps its empty segment and does not match `/users/:id?` (set `strict: false` to trim it).

Trailing-slash strictness is configurable per app (`strict: false` tolerates `/a/` → `/a`; the default stays strict):

```ts
const app = createApp({ strict: false });
```

## Types and the route table

The pattern literal drives the type: `ParamsOf<'/users/:id/posts/:postId'>` is `{ id: string; postId: string }`, so `ctx.params` is fully typed inside literal-pattern handlers. Routes can be removed again — `removeRoute(app, 'GET', '/users/:id')` — and the table is snapshot-immutable: registration replaces the frozen route/middleware arrays, so the dispatch caches are versioned by array identity and can never go stale (a direct `push` on the arrays throws instead of silently corrupting matching). The router itself is replaceable — pass a custom `match` to `createApp` and the whole matching strategy is yours:

```ts
const app = createApp({ match: myTrieMatcher });
```

## Trie dispatch

Dispatch runs over a static-prefix trie, indexed by **every** static segment, not just the leading prefix: a request only visits the trie nodes its own segments spell out, and routes like `/:tenant/resourceN` are reached through their later static segments instead of a linear scan — matching cost tracks URL depth, not route count. The residual linear case is a table of routes with no static segments at all (`/:a/:b/:c` style) — see `pnpm bench`.

## Method mismatch

When the path matches but no route's method does, s200 answers `405 {"error":"Method Not Allowed"}` with an `Allow` header listing the methods that would have matched (RFC 9110). Middlewares run first and can answer such requests themselves — a CORS preflight or a custom `OPTIONS` handler short-circuits before the fallback.

## Sub-apps

Sub-apps mount as a pure data transform — `sub` is copied, never mutated, and its app-level middlewares become route-scoped on the mounted routes:

```ts
import { mount } from 's200';

const api = createApp();
get(api, '/users/:id', handler);

const app = createApp();
mount(app, '/v1', api);   // /v1/users/:id — api itself stays reusable
```

The sub-app's `onError` is carried: each mounted route is wrapped in a route-scoped error boundary that applies it, so a thrown sub error still maps through the sub's policy (a decline rethrows and the parent's policy takes over). What mount cannot carry it says out loud: a sub-app that defines `onNotFound` or a custom `match` triggers one `console.warn` per `mount` call, because mounted routes are dispatched by the parent — its 404 policy and its router are the ones that run. The same warning covers a sub-app created with `strict: false` under a strict parent: the parent's matcher decides, so the sub's trailing-slash tolerance (`/users/` matching `/users`) is lost. Post-mount registration on `sub` stays invisible to the mount (snapshot semantics).

