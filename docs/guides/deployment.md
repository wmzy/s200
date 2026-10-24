# Deployment

## What you deploy

s200 is a function before it is a server. The entire runtime contract is `handle(app, request)` — a Web Standard `Request` in, a `Response` out:

```ts
import { createApp, handle } from 's200';

const app = createApp();
const response = await handle(app, request);
```

Every adapter is a thin wrapper over that call — build the `Request` from the platform's event, call `handle`, write the `Response` back (see [adapters](/guides/adapters)). Any runtime that can construct a `Request` is already a deployment target; the rest of this guide is production wiring, not porting.

## Node in production

A production entry is `serve` + `lifecycle`. `serve(app, options)` binds the port (`port` defaults to 0 — ephemeral, so set it explicitly; `host` omitted binds all interfaces). `lifecycle(server, options)` turns SIGTERM/SIGINT into a graceful drain in the load-balancer-safe order: the readiness gate closes FIRST (probes answer 503, traffic stops arriving), then the server stops accepting connections, in-flight requests get the budget to finish, stragglers are hard-killed on deadline — or on a second signal — and only then `onShutdown` runs:

```js
// server.mjs — the whole production entry
import { createApp, get } from 's200';
import { serve } from 's200/node';
import { lifecycle } from 's200/lifecycle';
import { createGate, health, readiness } from 's200/health';

const gate = createGate();
const app = createApp();
get(app, '/live', health());
get(app, '/ready', readiness({
  db: () => db.query('select 1'),  // any () => void | Promise<void>
  drain: gate.check,               // 503 "draining" from the first drain step
}));

const server = await serve(app, {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',  // bind 127.0.0.1 behind a local reverse proxy
});

const drain = lifecycle(server, {
  timeout: 15_000,        // in-flight budget in ms — default 10_000
  readiness: gate,        // closed with "draining" before any socket closes
  onShutdown: () => db.close(),
});
await drain.stopped;      // signals ride the same path as stop(); never rejects
```

`lifecycle` duck-types the raw server the adapter exposes: the node path reaps keep-alive sockets that go idle mid-drain and force-closes on deadline; the Bun path maps to `stop(false)`/`stop()`; anything else falls back to the adapter's `close()`. Options: `signals` (default `['SIGTERM', 'SIGINT']`, pass `[]` to keep them to yourself), `timeout` (drain budget, default 10 000 ms), `readiness` (the gate — structural, anything with `close(reason?)`), `onShutdown` (your cleanup hook).

### Dockerfile

Multi-stage keeps the image to `node_modules` + what your build emits — no toolchain in the final layer:

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable pnpm
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build                          # your build — emits server.mjs and friends

FROM node:22-alpine AS prod-deps
WORKDIR /app
RUN corepack enable pnpm
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/server.mjs ./
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
```

Run with `docker run --init` (or Compose `init: true`) so signals reach node properly as PID 1.

### systemd

`KillSignal=SIGTERM` matches what `lifecycle` listens for by default, and `TimeoutStopSec` must exceed the drain budget — otherwise systemd SIGKILLs the process mid-drain:

```ini
[Unit]
Description=s200 app
After=network-online.target
Wants=network-online.target

[Service]
User=app
WorkingDirectory=/srv/app
ExecStart=/usr/bin/node server.mjs
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=HOST=127.0.0.1
KillSignal=SIGTERM
TimeoutStopSec=20
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

## Health probes

`s200/health` gives the two-signal split orchestrators want. `health()` is liveness — a process that can answer at all is alive, zero dependencies, so one bad database never gets the container restarted:

```ts
import { get } from 's200';
import { health, readiness } from 's200/health';

get(app, '/live', health());   // 200 {"status":"ok"}
get(app, '/ready', readiness({
  db: () => db.query('select 1'),  // each check: returns/resolves = healthy
  drain: gate.check,               // the gate trips while draining
}, { timeout: 500 }));             // per-check budget in ms — default 1000
```

`readiness(checks, options)` runs every check concurrently under one per-check budget (default 1000 ms): all healthy → 200 `{"status":"ok","checks":{"db":"ok",...}}`, any failure → 503 with the failing checks' reasons. The `drain: gate.check` entry is what ties probes to [graceful drain](#node-in-production): wire the same `createGate()` gate into `lifecycle`'s `readiness` option, and `/ready` starts answering 503 the moment the drain begins — before any socket closes, so the load balancer or the kubelet stops routing to the pod first.

Kubernetes one-liners:

```yaml
livenessProbe:
  httpGet: { path: /live, port: 3000 }
readinessProbe:
  httpGet: { path: /ready, port: 3000 }
```

## Serverless / edge

Cloudflare Workers — `s200/cloudflare` builds the module worker's default export, with the client-disconnect signal wired through:

```ts
import { createHandler } from 's200/cloudflare';

export default createHandler(app);
```

Vercel — `s200/vercel` builds the platform's entry from the same app: `createVercelHandler(app)` is `handle` under the Web Standard `fetch` export, for both the Edge Runtime and Node.js (Fluid Compute included):

```ts
// api/index.ts
import { createVercelHandler } from 's200/vercel';
export default createVercelHandler(app);
```

AWS Lambda — `s200/aws-lambda` translates the API Gateway HTTP event both ways (payload format v2 only): `cookies` are joined into the request's `Cookie` header and a base64-flagged `body` is decoded on the way in; on the way out, each `Set-Cookie` becomes its own `cookies` array entry, textual bodies go back as strings, and everything else returns base64-encoded:

```ts
// src/lambda.ts
import { createLambdaHandler } from 's200/aws-lambda';
export const handler = createLambdaHandler(app);
```

Point the function at `<file>.handler` — a function URL or an HTTP API Lambda proxy integration both work. The full event/result mapping is on the [serverless adapters](/api/serverless) page. Any runtime without a shipped adapter still speaks the plain `handle(app, request)` contract above — wire it into whatever entry shape the platform wants.

## Bun

`s200/bun` serves through `Bun.serve` — same `serve(app, { port })` shape, see [adapters](/guides/adapters). `lifecycle` works on its result unchanged (`stop(false)` graceful, `stop()` forced). For a single-file binary, compile the entry:

```sh
bun build --compile server.ts --outfile app
./app
```

## Production checklist

- **Behind a proxy?** Register `trustProxy({ hops: 1 })` from `s200/trust-proxy` before anything that reasons about the origin — it rewrites `ctx.url` from `X-Forwarded-Proto`/`X-Forwarded-Host` and puts the client IP on `ctx.state.proxy.clientIp`. `hops` is the number of proxies you trust (default 1).
- **Rate-limit at the edge** — `rateLimit` from `s200/rate-limit` (sliding window, injectable store) before the routes anonymous traffic can reach.
- **Correlate everything** — `requestId` from `s200/request-id` stamps a unique header the logger and your logs can join on.
- **Compress and cache** — `compress` (`s200/compress`, `Content-Encoding` negotiation) and `etag` (`s200/etag`, conditional 304s on byte-backed bodies).
- **Bound slow handlers** — `timeout(ms)` from `s200/timeout` answers 504 instead of pinning a connection.
- **Set browser-facing headers centrally** — `secureHeaders` from `s200/secure-headers` (HSTS belongs at the TLS edge) and `cors` from `s200/cors` for cross-origin browser APIs.
- **Wire the drain** — `serve` + `lifecycle` + the `createGate()` gate in `/ready` (see above), and align the orchestrator's stop timeout with `lifecycle`'s `timeout`.
- **Bind deliberately** — `HOST=127.0.0.1` when a local reverse proxy terminates TLS; expose `PORT` as the one knob your platform sets.
