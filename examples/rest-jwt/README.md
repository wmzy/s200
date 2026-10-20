# rest-jwt — JWT-protected mini API

A tiny article API behind bearer tokens. Demonstrates the **`s200/jwt`**
battery (`signJwt`/`jwtAuth`) and **`s200/validate`** (`jsonBody` wrapping a
hand-rolled parse fn — no schema library), plus two core contracts:

- route-scoped gates: `get(app, '/me', jwtAuth({ secret }), handler)` — the
  verified payload lands on `ctx.state.jwt` and the chain below only runs
  on success;
- error responses are materialized **inside** the chain, so the example's
  prefix middleware stamps `WWW-Authenticate: Bearer` on the real 401s
  (s200's `jwtAuth` answers 401 in place but sends no challenge of its own).

Routes:

| Route            | Auth | Behavior                                              |
| ---------------- | ---- | ----------------------------------------------------- |
| `POST /login`    | —    | hardcoded users → `{ token }` (HS256, 1 h expiry)     |
| `GET /me`        | JWT  | the verified payload (`ctx.state.jwt`)                |
| `GET /articles`  | JWT  | list stored articles                                  |
| `POST /articles` | JWT  | create; body goes through `jsonBody(parseArticle)`    |
| `GET /articles/:id` | JWT | one article or 404                                 |

Users: `ada`/`lovelace`, `alan`/`turing`.

## Requirements

`start`/`smoke` run the `.ts` sources directly through Node's native type
stripping — the example itself has no build step. Node ≥ 23.6, or ≥ 22.18,
does this with no flags (CI runs these examples on the latest Node 22,
flag-free). On Node 22.15–22.17 prefix the command with
`NODE_OPTIONS=--experimental-strip-types` (22.15 is also where the smoke
hook's `registerHooks` landed); older Node cannot run `.ts` at all. Bun
needs no flags.

## Run

```sh
pnpm install
pnpm build          # workspace root once — app.ts imports the built s200 entries
pnpm --filter @s200-example/rest-jwt start
```

## Try it

```sh
TOKEN=$(curl -s localhost:3000/login -H 'content-type: application/json' \
  -d '{"user":"ada","password":"lovelace"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')

curl -s localhost:3000/me -H "authorization: Bearer $TOKEN"
curl -s localhost:3000/articles -H "authorization: Bearer $TOKEN"
curl -i localhost:3000/me                      # 401 + WWW-Authenticate: Bearer
```

## Smoke

```sh
pnpm --filter @s200-example/rest-jwt smoke
# or: cd examples/rest-jwt && node smoke.ts
```

`smoke.ts` drives the real `app.ts` against the workspace `src/` (via
`../ts-resolve.mjs`, which redirects the public `s200*` entry names) on an
ephemeral port: login → `/me` → create → read-back → forged-token 401s →
invalid-body 422 → 404, then closes the server and exits 0.
