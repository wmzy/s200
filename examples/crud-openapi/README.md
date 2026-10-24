# crud-openapi — the route table is the spec

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/fork/github/wmzy/s200/tree/main/examples/crud-openapi)

A `users` resource (in-memory `Map`, no database) where **one set of
annotations feeds every consumer**: the same live route table produces
the served API, the OpenAPI 3.1 document, the docs page, and a generated
typed client. Annotate once, consume everywhere — no build-time plugin,
no reflection, no second source of truth to drift.

The loop this example demonstrates, end to end:

```
route registrations ── describeRoute annotations (summary/body/responses)
        │
        ├── openapiJson  → GET /openapi.json   (OpenAPI 3.1, errors included)
        ├── swaggerUi    → GET /docs           (Scalar reference page)
        └── generateClient → typed client.ts   (zero s200 imports)
```

What's on show:

- **`s200/meta`** — `describeRoute`/`describeApp`: pure annotations keyed
  by the route objects themselves, so the core `App` shape stays
  untouched and tree-shaking keeps them out of non-OpenAPI builds.
- **`s200/openapi` + `s200/swagger`** — the spec derives from the table
  (unannotated routes still appear); error branches declared as
  `responses` (404/409 here) land in the document.
- **`s200/validate`** — the body gate speaks **Standard Schema**
  (`standardschema.dev`): the example's schema is hand-rolled in the
  vendor-neutral `~standard` shape with zero dependencies; a zod /
  valibot / typebox schema drops into the same `jsonBody(schema)` slot
  unchanged. Issues map to a single 422; invalid JSON is a 400 from
  `readJson` before the schema ever runs.
- **`s200/codegen`** — `generateClient(app)` emits a standalone
  TypeScript client module (deterministic, no s200 imports): params from
  each pattern, `init.body` from the declared body schema, and a
  status-discriminated response union from the declared responses —
  `if (res.status === 404)` narrows the body.
- **`s200/test`** — `request(app, '/users/1')` dispatches in-process
  with full fallback semantics; no port is bound anywhere in the tests.

Routes:

| Route               | Behavior                                                    |
| ------------------- | ----------------------------------------------------------- |
| `GET /users`        | list all users                                              |
| `POST /users`       | create (201); body via `jsonBody(newUserSchema)`; dup email 409 |
| `GET /users/:id`    | one user or 404 (non-integer `:id` addresses no user)       |
| `PUT /users/:id`    | full replace or 404; another user's email 409               |
| `DELETE /users/:id` | 204 (`send(ctx, null, { status: 204 })`) or 404             |
| `GET /openapi.json` | the OpenAPI 3.1 document, derived from the table            |
| `GET /docs`         | the Scalar API reference page                               |

## Files

| File         | What it is                                                       |
| ------------ | ---------------------------------------------------------------- |
| `app.ts`     | the whole app: store, Standard Schema gate, routes, annotations, docs pair, serve entry |
| `smoke.ts`   | the proof: full CRUD lifecycle in-process, then spec + codegen assertions |
| `package.json` | `start` / `smoke` scripts, `s200` workspace dependency          |

## Requirements

`start`/`smoke` run the `.ts` sources directly through Node's native
type stripping — no build step for the example itself. Node ≥ 23.6, or
≥ 22.18, does this with no flags (CI runs this example flag-free on
Node 22). On Node 22.6–22.17 prefix the command with
`NODE_OPTIONS=--experimental-strip-types`; older Node cannot run `.ts`.
The s200 runtime floor itself is Node ≥ 20.3 (compiled output).

## Run

```sh
pnpm install
pnpm --filter @s200-example/crud-openapi start
# from the repo root, after a root build, the same works without the
# ts-resolve hook: cd examples/crud-openapi && node app.ts
```

## Try it

```sh
curl -s localhost:3000/users
curl -s -X POST localhost:3000/users -H 'content-type: application/json' \
  -d '{"name":"grace hopper","email":"grace@example.com"}'
curl -s localhost:3000/users/1
curl -s -X PUT localhost:3000/users/1 -H 'content-type: application/json' \
  -d '{"name":"grace m. hopper","email":"grace@example.com"}'
curl -i -X DELETE localhost:3000/users/1        # 204
curl -i localhost:3000/users/1                  # 404 {"error":"No user 1"}
curl -s localhost:3000/openapi.json | head -c 400
open http://localhost:3000/docs                  # Scalar API reference
```

## Generate the client

The CLI reads the same table the server serves:

```sh
npx s200 codegen ./app.ts --out client.ts --name createUsersClient
```

Or programmatically (what `smoke.ts` asserts):

```ts
import { generateClient } from 's200/codegen';
const source = generateClient(app, { name: 'createUsersClient' });
await writeFile('client.ts', source);
```

The emitted module is self-contained (`fill`/`send` helpers inline, zero
s200 imports) and deterministic — it diffs and commits like hand-written
source. `deleteUsersId({ id: '1' })` returns a status-discriminated
union whose `404` branch narrows `res.json()` to `{ error: string }`,
because the route's annotation declared it.

## Smoke

```sh
pnpm --filter @s200-example/crud-openapi smoke
# or: cd examples/crud-openapi && node smoke.ts
```

`smoke.ts` imports the real `app.ts` (workspace `src/` via
`../ts-resolve.mjs`) and drives it with `s200/test`'s `request()` — no
server, no port: empty list → create (Standard-Schema-parsed body) →
read → duplicate-email 409 → invalid-body 422 → 404s → update
(200/404/409) → delete (204, then 404, list reflects it); then it
asserts `openapiSpec(app)` documents `/users` and `/users/{id}` with the
404 branch, and that `generateClient(app)` emits the `'/users/:id'`
pattern literal and one typed method per route. Exits non-zero on any
failure.
