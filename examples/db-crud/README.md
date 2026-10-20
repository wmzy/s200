# db-crud — REST CRUD over SQLite

A `users` resource with the full CRUD verb set, backed by **real
persistence**: Node's built-in `node:sqlite` (`DatabaseSync`) — no database
driver, no npm dependency. Demonstrates the **`s200/serialize`** battery
(`serialize` + `jsonRaw` — schema'd responses with exact content-length),
**`s200/validate`** (`jsonBody` gating typed bodies), and how database
facts map to HTTP facts inside the chain:

- a missing row → `httpError(404)` (same for non-integer `:id` — it
  addresses no user);
- a `UNIQUE` constraint violation on `users.email` → 409 Conflict;
- invalid JSON body → 400 (from `readJson`, before the parse fn runs);
  wrong shape → 422 (the example's parse fn throws);
- unregistered method on a known path → the router's own 405 + `Allow`
  (there is no collection `DELETE /users`).

Routes:

| Route              | Behavior                                                     |
| ------------------ | ------------------------------------------------------------ |
| `GET /users`       | list all users                                               |
| `POST /users`      | create (201); body via `jsonBody(parseNewUser)`; dup email 409 |
| `GET /users/:id`   | one user or 404                                              |
| `PUT /users/:id`   | full replace or 404; taken email 409                         |
| `DELETE /users/:id`| 204 (`send(ctx, null, { status: 204 })`) or 404              |

The database is `:memory:` by default (fresh + seeded with two users per
process); `DB_PATH=/path/to/db pnpm start` persists to a file — schema
creation and seeding are idempotent, so restarts keep the data.

## Requirements

`start`/`smoke` run the `.ts` sources directly through Node's native type
stripping — the example itself has no build step. Node ≥ 23.6, or ≥ 22.18,
does this with no flags (CI runs this example on the latest Node 22,
flag-free). On Node 22.15–22.17 prefix the command with
`NODE_OPTIONS=--experimental-strip-types`; older Node cannot run `.ts` at
all.

`node:sqlite` is a separate matter, also settled by ≥ 22.18: it shipped in
22.5 behind `--experimental-sqlite`, and imports **without the flag from
22.13 on** (verified empirically: 22.12 fails with
`ERR_UNKNOWN_BUILTIN_MODULE` unflagged but works with the flag; 22.13 and
22.18 import unflagged). Unflagged versions still print a one-line
`ExperimentalWarning: SQLite is an experimental feature` — cosmetic. So on
Node 22.5–22.12 you'd additionally need `--experimental-sqlite`; on the
floor this example declares (≥ 22.18) neither flag is needed.

## Run

```sh
pnpm install
pnpm build          # workspace root once — app.ts imports the built s200 entries
pnpm --filter @s200-example/db-crud start
# file-backed: DB_PATH=./users.db pnpm --filter @s200-example/db-crud start
```

## Try it

```sh
curl -s localhost:3000/users
curl -s -X POST localhost:3000/users -H 'content-type: application/json' \
  -d '{"name":"grace hopper","email":"grace@example.com"}'
curl -s -X PUT localhost:3000/users/1 -H 'content-type: application/json' \
  -d '{"name":"ada king","email":"ada@example.com"}'
curl -i -X DELETE localhost:3000/users/2          # 204, no content-length
curl -i -X POST localhost:3000/users -H 'content-type: application/json' \
  -d '{"name":"x","email":"ada@example.com"}'     # 409 — UNIQUE constraint
curl -i -X DELETE localhost:3000/users            # 405 + Allow: GET, POST
```

## Smoke

```sh
pnpm --filter @s200-example/db-crud smoke
# or: cd examples/db-crud && node smoke.ts
```

`smoke.ts` drives the real `app.ts` against the workspace `src/` (via
`../ts-resolve.mjs`, which redirects the public `s200*` entry names) on an
ephemeral port, with a fresh `:memory:` database per run: seeded list →
read → 404s (missing + non-integer id) → create (parsed shape, assigned
id) → duplicate-email 409 → 422s → invalid-JSON 400 → update (200/404/409)
→ delete (204 with no content-length, then 404, list reflects it) → 405 +
`Allow`, then closes the server and exits 0.
