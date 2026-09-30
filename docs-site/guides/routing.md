# Routing

Patterns use `:name` params and a terminal `*name` wildcard. Matching is strict (no trailing-slash tolerance by default; `createApp({ strict: false })` relaxes it), first registration wins, `ALL` matches every method, and `HEAD` falls back to `GET` routes. Captured values reach handlers **percent-decoded** (`/users/foo%20bar` → `'foo bar'`), while matching runs on the raw path — an encoded `/` can never fake a segment boundary. Duplicate capture names are rejected at registration.

```ts
get(app, '/users/:id', (ctx) => text(ctx, ctx.params.id));    // ctx.params.id: string — inferred
get(app, '/files/*path', (ctx) => text(ctx, ctx.params.path)); // captures the rest incl. '/'
get(app, '/users/:id?', (ctx) => json(ctx, { id: ctx.params.id ?? null })); // id is optional
```

The pattern literal drives the type: `ParamsOf<'/users/:id/posts/:postId'>` is `{ id: string; postId: string }`, so `ctx.params` is fully typed inside literal-pattern handlers — `/:id?` is an optional segment typed `{ id?: string }`. Dispatch runs over a static-prefix trie indexed by **every** static segment, so matching cost tracks URL depth, not route count. Routes can be removed again (`removeRoute`), the route table is snapshot-immutable, and the whole matcher is replaceable (`createApp({ match: fn })`). Sub-apps mount as a pure data transform: `mount(app, '/v1', api)` copies `api`, never mutating it. A path match with no method match answers `405` with an `Allow` header (RFC 9110).

Full reference: [Routing in the README](https://github.com/wmzy/s200#routing).
