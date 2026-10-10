# Bun Adapter (`s200/bun`)

Serves an app on `Bun.serve`.

## `serve(app, options?)` → `BunServer`

```ts
import { serve } from 's200/bun';
const server = serve(app, { port: 3000 });   // synchronous — Bun.serve is sync
console.log(server.url);                      // http://localhost:3000
await server.close();
```

`BunServeOptions`:

| Field | Default | Meaning |
| --- | --- | --- |
| `port` | `0` | Port to listen on |
| `hostname` | — | Hostname |
| `websocket` | — | The bridge from `s200/websocket/bun`: `{ upgrade, websocket }` — `upgrade` decides inside the fetch handler whether the request becomes a WebSocket; the `websocket` half carries the per-connection callbacks |

`BunServer`:

| Field | Meaning |
| --- | --- |
| `url` / `port` | Bound address |
| `server` | The raw `Bun.serve` handle (`BunServedServer`): `stop(closeActiveConnections?)` — `stop(false)` waits for in-flight requests, `stop()`/`stop(true)` force-closes. This is the graceful-drain surface `s200/lifecycle` duck-types onto |
| `close()` | `stop(true)` — also drops in-flight connections, so `close()` resolves immediately |

Note: Bun does not reliably abort `request.signal` on client disconnect, so the adapter does no disconnect wiring (unlike the Node adapter's `abortOnDisconnect`).

## Filesystem injectors for `serveStatic`

Backed by `Bun.file` — the same injection surface as the Node adapter (see [`s200/node`](/api/node#filesystem-injectors-for-servestatic)):

| Function | Signature | Meaning |
| --- | --- | --- |
| `createFileReader(root, { stream? })` | `(path) => Promise<Uint8Array \| ReadableStream \| null>` | `Bun.file` bytes by default; `{ stream: true }` streams |
| `createFileStat(root)` | `(path) => Promise<StaticFileInfo \| null>` | `size` + `lastModified` for conditional requests |
| `createFileRangeReader(root)` | `(path, start, end) => Promise<ReadableStream \| null>` | `Bun.file(...).slice(start, end).stream()` |
| `createRealPathGuard(root)` | `(path) => Promise<string \| null>` | Symlink-escape guard via `realpathSync` |
