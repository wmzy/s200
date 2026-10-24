# hello-world — the smallest s200 app

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/fork/github/wmzy/s200/tree/main/examples/hello-world)

One middleware, one route, zero configuration:

- a prefix-free `use` middleware — the unwind shape: after `await next()`
  the response is materialized (500s included) and can be stamped
- `get(app, '/', handler)` answering `json(ctx, …)`

## Run

```sh
node app.ts
```

`s200` resolves to the workspace package here; outside the repo, install it
first (`npm i s200`). Node ≥ 23.6 (or ≥ 22.18) strips the `.ts` types
natively — no build step. Then:

```sh
curl localhost:3000/
# {"hello":"world"}   (+ x-powered-by: s200)
```

## Smoke

```sh
node smoke.ts
```

Drives the real `app.ts` against the workspace `src/` (via
`../ts-resolve.mjs`) on an ephemeral port: one request → 200, the JSON
payload, and the middleware's header, then closes the server and exits 0.
