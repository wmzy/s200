# sse-dashboard — SSE ticker + static page

A live-ticker dashboard: a static HTML page fed by a Server-Sent Events
endpoint. Demonstrates the **`s200/streaming`** battery (`streamSSE` with
`writeSSE`/`heartbeat`) and **`serveStatic`** over the node adapter's
injected readers (`createFileReader`/`createFileStat` — ETag/304 support).

- `GET /events` — one heartbeat comment, five `tick` events ~30 ms apart,
  then a `done` event; the pump is bounded, so the stream closes on its own
- `GET /` — `public/index.html`, a real dashboard page (`fetch('/health')`
  + `EventSource('/events')`)
- `GET /health` — the plain-JSON endpoint the page fetches on load

Static misses fall through to `next()`, so `/events` and `/health` answer
even though `serveStatic` is registered first.

## Run

```sh
pnpm install
pnpm build          # workspace root once — app.ts imports the built s200 entries
pnpm --filter @s200-example/sse-dashboard start
# open http://localhost:3000/
```

## Try it

```sh
curl -s localhost:3000/health
curl -N localhost:3000/events        # watch event: tick / data: {"n":1,...} frames
curl -sI localhost:3000/ | grep -i content-type
```

## Smoke

```sh
pnpm --filter @s200-example/sse-dashboard smoke
# or: cd examples/sse-dashboard && node smoke.ts
```

`smoke.ts` drives the real `app.ts` against the workspace `src/` (via
`../ts-resolve.mjs`, which redirects the public `s200*` entry names) on an
ephemeral port: it fetches `/events`, reads the raw stream through a
`getReader()` loop, and parses the SSE wire format by hand — five ordered
tick frames, one heartbeat comment, a terminating `done` frame, and the
self-closing stream — plus the text/html dashboard page, then closes the
server and exits 0.
