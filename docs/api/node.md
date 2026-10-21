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
| `server` | — | `NodeServerTunables`: curated node server knobs (`maxHeaderSize`, `requestTimeout`, `headersTimeout`, `keepAliveTimeout`, `connectionsCheckingInterval`, `keepAlive`, `noDelay`, `highWaterMark`), applied at construction on every path — http, https, http2-over-TLS. Only these whitelisted fields travel to node's constructors |
| `closeGraceMs` | `10_000` | Graceful-close budget in ms. `close()` stops accepting, destroys idle keep-alive sockets, and lets in-flight responses finish — resolving as soon as the last one lands. At the budget's elapse whatever is still open is hard-killed (`closeAllConnections()`, plus upgraded/websocket sockets the adapter tracks itself). `0` hard-kills immediately: in-flight responses die the moment `close()` is called |
| `clientError` | — | `(err, socket) => void` wired to the server's `'clientError'` event — malformed requests reach your hook instead of node's default (destroy the offending socket). Without it node's own behavior applies unchanged |

`NodeServer`:

| Field | Meaning |
| --- | --- |
| `server` | The raw `NodeServerKind` (`HttpServer \| HttpsServer \| Http2SecureServer`) — the graceful-drain surface for `s200/lifecycle` |
| `url` | `http://host:port` |
| `port` | Bound port |
| `close()` | Graceful by default: stops accepting, drains in-flight within `closeGraceMs` (see below), then resolves |

`NodeUpgradeHandler`: the `node:http` `'upgrade'` event signature `(req, socket, head) => void`.

## Graceful close

`close()` is graceful by default — the drain pattern `s200/lifecycle` and the shard executor use:

1. **Stop accepting** — `server.close()`: new connections are refused from this moment.
2. **Destroy idle keep-alive sockets** now, and again whenever they go idle mid-drain (a response finishing leaves its keep-alive socket parked; without the re-sweep `close()` would wait out that socket's own `keepAliveTimeout`).
3. **Wait for in-flight responses** — `close()`'s promise resolves as soon as the last one lands, not at the budget.
4. **Hard-kill at the budget** — when `closeGraceMs` (default `10_000`) elapses, `closeAllConnections()` plus the adapter's own registry of upgraded (websocket) sockets destroy whatever is still open. Sockets taken over by `'upgrade'` are invisible to node's own `closeAllConnections()`; the registry is what makes the grace a real bound for websocket servers.

`closeGraceMs: 0` skips all of the above: destroy everything immediately, in-flight responses included.

On HTTP/2-over-TLS the same sequence runs — node's `close()` tears the sessions down; the idle/all-connection calls have no http2 equivalent and are skipped.

## Server tunables {#server-tunables}

`server: NodeServerTunables` passes a curated subset of node's own server knobs to the underlying constructor — the same eight fields apply on the http, https and http2-over-TLS paths:

| Field | Node default | Meaning |
| --- | --- | --- |
| `maxHeaderSize` | `16384` | Per-request header budget in bytes |
| `requestTimeout` | `300_000` | Whole-request deadline in ms (`0` disables) |
| `headersTimeout` | `60_000` | Headers-only deadline in ms — must be ≤ `requestTimeout` |
| `keepAliveTimeout` | `5_000` | Keep-alive idle window in ms |
| `connectionsCheckingInterval` | `30_000` | Incomplete-request reaping cadence in ms |
| `keepAlive` | `false` | TCP keep-alive probes on sockets |
| `noDelay` | `true` | `socket.setNoDelay` — disable Nagle |
| `highWaterMark` | `16384` | Per-socket stream buffer size in bytes |

**Production notes.** Keep `keepAliveTimeout` comfortably below the upstream load balancer's idle timeout: an LB that drops a connection it considers idle while the backend still holds it open is the classic silent-502 trap (the next request rides a socket the LB already discarded). The usual recipe is LB idle timeout ≥ `keepAliveTimeout` + a margin of a few seconds. `requestTimeout` bounds the *whole* request, body included — a long streaming upload or download legitimately outliving it is cut off, so size it (or disable with `0` and rely on `headersTimeout` + your own body limits) for streaming endpoints.

## Host header hardening

The adapter builds each request URL from the `Host` header (`:authority` on HTTP/2). A Host outside the authority grammar — anything but alphanumerics, `.`, `-`, `:` (port), and `[`/`]` (IPv6 literals), including `/ \ ? # @`, whitespace, percent-escapes, and the empty value — falls back to `localhost` instead of flowing into the URL: a crafted `Host: evil.com/a` can neither pollute the parsed pathname nor make the URL unparseable. Legal hosts pass through unchanged — `example.com`, `example.com:8080`, `[::1]:3000`.

## `onFinish(ctx, fn)` (core barrel) {#onfinish}

```ts
import { onFinish } from 's200';

get(app, '/report', (ctx) => {
  onFinish(ctx, ({ aborted }) => {
    console.log('report response finished', aborted ? 'early' : 'cleanly');
  });
  return json(ctx, buildReport());
});
```

Registers a callback that runs **exactly once** per request — first trigger wins, later triggers are no-ops:

- `{ aborted: false }` — the response was fully written.
- `{ aborted: true }` — the connection ended first: client disconnect, a cancelled response body, or a mid-write failure.

Callbacks are fire-and-forget: a synchronous throw (or a returned promise's rejection) is logged through the app's `logError` and never interrupts the response or the other callbacks. Register before the finish — registrations after it are dropped silently.

On the node adapter the triggers are the completed socket write and the premature `'close'`; they fire with and without `light`, and `abortOnDisconnect: false` only skips the `ctx.signal` abort — the finish callbacks still run.

## Disconnect propagation for streamed responses

While a streamed response body is being pulled, a client disconnect (the per-request signal of `abortOnDisconnect`, on by default) cancels the body reader: a handler-side generator receives its `finally`, a pending backpressure wait rejects instead of hanging on a dead socket, and the response is destroyed. With `abortOnDisconnect: false` the loop rides plain drain backpressure and no cancel is propagated.

## Filesystem injectors for `serveStatic`

The adapter implements the [`serveStatic`](/api/respond#static-files) injection surface so the core stays filesystem-free:

| Function | Signature | Meaning |
| --- | --- | --- |
| `createFileReader(root, { stream?, realPath?, streamThreshold? })` | `(path) => Promise<Uint8Array \| ReadableStream \| null>` | Safe by default: the resolved real path must stay under `root` (a symlink pointing elsewhere reads as a miss; `realPath: false` opts out), and files strictly larger than `streamThreshold` (default 16 MiB) stream instead of buffering. `{ stream: true }` streams everything regardless of size |
| `createFileStat(root)` | `(path) => Promise<StaticFileInfo \| null>` | File metadata for conditional requests + streamed content-length |
| `createFileRangeReader(root)` | `(path, start, end) => Promise<ReadableStream \| null>` | Memory-safe `[start, end]` range streaming |
| `createRealPathGuard(root)` | `(path) => Promise<string \| null>` | Symlink-escape guard: `null` when the resolved real path escapes `root` — applied by `createFileReader` by default |

Files above the threshold are streamed, so inject `createFileStat`/`createFileRangeReader` alongside the reader to keep content-length, validators (ETag/Last-Modified/304) and `206`/`416` range semantics on those responses.

`NodeHttpsOptions`: `{ key, cert, ca?, http2? }` — `key`/`cert` accept strings, `Buffer`s, or arrays (the `node:https` shape).

## `brotliCompress(bytes)` → `Promise<Uint8Array>`

The Node `CompressionStream` has no brotli — this is the injected encoder `s200/compress` accepts as `brotli`:

```ts
import { brotliCompress } from 's200/node';
use(app, compress({ brotli: { compress: brotliCompress } }));
```
