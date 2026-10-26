# production-ready — the operations layer in one file

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/fork/github/wmzy/s200/tree/main/examples/production-ready)

The web surface is two routes; the point is everything around them — the
NestJS-style operations stack in data + functions form:

- **`s200/config`** — `parseEnv` + `createConfig`: env (plus an optional
  `.env`) validated at import time, fail-fast with every issue listed
- **`s200/health`** — `health()` liveness, `readiness()` wired to a
  `createGate()` drain switch: flip it and `/readyz` answers 503 while
  in-flight requests keep draining
- **`s200/schedule`** — an interval sweeper over a `lastSeen` registry
  (scheduled work lives in the same process, stopped in `onShutdown`)
- **`s200/lifecycle`** — SIGTERM/SIGINT drain: readiness flips first,
  listening stops, in-flight requests finish (try the `/slow` route), the
  scheduler stops, cleanup hooks run in order — then exit 0
- `logger` + `request-id` stamp every request, 500s included

## Run

```sh
node app.ts
```

`s200` resolves to the workspace package here; outside the repo, install it
first (`npm i s200`). Node ≥ 23.6 (or ≥ 22.18) strips the `.ts` types
natively — no build step. Then:

- `GET /` — the configured `TITLE` plus this request's id
- `GET /slow` — takes `SLOW_MS` (default 750 ms); send SIGTERM while it
  runs and watch it complete before shutdown
- `GET /healthz` / `GET /readyz` — liveness and drain-aware readiness

## Configuration

| Env | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | listen port (1–65535) |
| `TITLE` | `production-ready` | non-blank banner text |
| `SLOW_MS` | `750` | artificial latency for `/slow` |
| `SWEEP_MS` | `30000` | sweeper interval |
| `DRAIN_MS` | `10000` | graceful-drain budget |

A `.env` in the working directory is tolerated when absent and parsed when
present — invalid configuration kills the process at boot with the full
issue list (the smoke test pins this too).

## Smoke

```sh
npm run smoke
```

Asserts the in-process routes, then spawns the app, drains a `/slow`
request across a SIGTERM, and checks ordered shutdown logs and exit code.
