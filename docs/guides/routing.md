# Routing

Patterns use `:name` params and a terminal `*name` wildcard; matching is strict (no trailing-slash tolerance), first registration wins, `ALL` matches every method, and `HEAD` falls back to `GET` routes. Duplicate capture names (`/users/:id/posts/:id`) are rejected at registration. Captured values are handed to handlers **percent-decoded** (`/users/foo%20bar` → `'foo bar'`) — the Express/Hono contract — while matching runs on the raw path, so an encoded `/` can never fake a segment boundary.

```ts
get(app, '/users/:id', (ctx) => text(ctx, ctx.params.id));   // ctx.params.id: string — inferred
get(app, '/files/*path', (ctx) => text(ctx, ctx.params.path)); // captures the rest incl. '/'
get(app, '/users/:id?', (ctx) => json(ctx, { id: ctx.params.id ?? null })); // id is optional
```

`/:id?` is an optional param — the segment may be absent, and `ParamsOf<'/users/:id?'>` types it as `{ id?: string }` (absent keys are omitted at runtime). Matching is greedy with backtracking, so `/x/:a?/y` matches both `/x/y` and `/x/1/y`, and chained optionals resolve left-to-right. Strict trailing slashes still hold: `/users/` keeps its empty segment and does not match `/users/:id?` (set `strict: false` to trim it).

Trailing-slash strictness is configurable per app (`strict: false` tolerates `/a/` → `/a`; the default stays strict):

```ts
const app = createApp({ strict: false });
```

The pattern literal drives the type: `ParamsOf<'/users/:id/posts/:postId'>` is `{ id: string; postId: string }`, so `ctx.params` is fully typed inside literal-pattern handlers. Routes can be removed again — `removeRoute(app, 'GET', '/users/:id')` — and the table is snapshot-immutable: registration replaces the frozen route/middleware arrays, so the dispatch caches are versioned by array identity and can never go stale (a direct `push` on the arrays throws instead of silently corrupting matching). The router itself is replaceable — pass a custom `match` to `createApp` and the whole matching strategy is yours:

```ts
const app = createApp({ match: myTrieMatcher });
```

Dispatch runs over a static-prefix trie, indexed by **every** static segment, not just the leading prefix: a request only visits the trie nodes its own segments spell out, and routes like `/:tenant/resourceN` are reached through their later static segments instead of a linear scan — matching cost tracks URL depth, not route count. The residual linear case is a table of routes with no static segments at all (`/:a/:b/:c` style) — see `pnpm bench`.

When the path matches but no route's method does, s200 answers `405 {"error":"Method Not Allowed"}` with an `Allow` header listing the methods that would have matched (RFC 9110). Middlewares run first and can answer such requests themselves — a CORS preflight or a custom `OPTIONS` handler short-circuits before the fallback.

Sub-apps mount as a pure data transform — `sub` is copied, never mutated, and its app-level middlewares become route-scoped on the mounted routes:

```ts
import { mount } from 's200';

const api = createApp();
get(api, '/users/:id', handler);

const app = createApp();
mount(app, '/v1', api);   // /v1/users/:id — api itself stays reusable
```

