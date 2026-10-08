# Node Adapter (`s200/node`)

Serves an app on Node's `http`/`https`/`http2` servers.

## `serve(app, options?)` → `Promise<NodeServer>`

```ts
import { serve } from 's200/node';
const server = await serve(app, { port: 3000 });
console.log(server.url);        // http://127.0.0.1:3000
await server.close();
```

`NodeServeOptions`:

| Field | Default | Meaning |
| --- | --- | --- |
| `port` | `0` (ephemeral) | Port to listen on |
| `host` | — | Hostname |
| `upgrade` | — | WebSocket `'upgrade'` callback — pass `createUpgradeHandler(app)` from `s200/websocket/node` (see [`s200/websocket`](/api/websocket)) |
| `light` | `false` | Opt-in fast path: the adapter constructs light-weight `Request`/`Response` objects (nothing global is patched; handlers still see Web Standard shapes). Caveats: `clone()` works only for byte-backed bodies; exotic `BodyInit` (Blob/FormData) pays one real `Response` construction |
| `abortOnDisconnect` | `true` | Aborts `ctx.signal` when the client drops the connection before the response finishes; `false` skips the per-request `AbortController` |
| `https` | — | `NodeHttpsOptions`: serve TLS via `node:https`, or HTTP/2-over-TLS with `http2: true` (plaintext h2c unsupported; HTTP/2 has no `upgrade` event, so `http2: true` + `upgrade` throws at `serve` time — WSS needs HTTP/1.1-over-TLS) |

`NodeServer`:

| Field | Meaning |
| --- | --- |
| `server` | The raw `HttpServer \| HttpsServer \| Http2SecureServer` — the graceful-drain surface for `s200/lifecycle` |
| `url` | `http://host:port` |
| `port` | Bound port |
| `close()` | Stops accepting, drains in-flight requests, then resolves |

`NodeUpgradeHandler`: the `node:http` `'upgrade'` event signature `(req, socket, head) => void`.

## Filesystem injectors for `serveStatic`

The adapter implements the [`serveStatic`](/api/respond#static-files) injection surface so the core stays filesystem-free:

| Function | Signature | Meaning |
| --- | --- | --- |
| `createFileReader(root, { stream? })` | `(path) => Promise<Uint8Array \| ReadableStream \| null>` | Buffered whole-file reader by default; `{ stream: true }` streams (memory-safe for large files, but no `stat`-backed sizes/ranges) |
| `createFileStat(root)` | `(path) => Promise<StaticFileInfo \| null>` | File metadata for conditional requests + streamed content-length |
| `createFileRangeReader(root)` | `(path, start, end) => Promise<ReadableStream \| null>` | Memory-safe `[start, end]` range streaming |
| `createRealPathGuard(root)` | `(path) => Promise<string \| null>` | Symlink-escape guard: `null` when the resolved real path escapes `root` |

`NodeHttpsOptions`: `{ key, cert, ca?, http2? }` — `key`/`cert` accept strings, `Buffer`s, or arrays (the `node:https` shape).

## `brotliCompress(bytes)` → `Promise<Uint8Array>`

The Node `CompressionStream` has no brotli — this is the injected encoder `s200/compress` accepts as `brotli`:

```ts
import { brotliCompress } from 's200/node';
use(app, compress({ brotli: { compress: brotliCompress } }));
```
