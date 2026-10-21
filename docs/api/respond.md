# Responding, Bodies & Static Files (`s200`)

Three capabilities of the core barrel: response helpers, request-body reading, and static file serving.

## Response helpers

Every helper writes `ctx.res` in place and returns the built `Response` — usable as a handler's return value or standalone.

```ts
send(ctx, body, init?): StatusedResponse<S>          // BodyInit | Uint8Array | null
json<T, S>(ctx, data, init?): JsonResponse<T, S>    // JSON.stringify + content-length
text<S>(ctx, body, init?): StatusedResponse<S>      // text/plain; charset=utf-8
html<S>(ctx, body, init?): StatusedResponse<S>      // text/html; charset=utf-8 — NOT escaped
redirect<S>(ctx, location, status?): StatusedResponse<S>  // default 302
setHeader(ctx, name, value)                         // direct, or deferred pre-response
setHeaders(ctx, { name: value })                    // many at once, insertion order
escapeHtml(value): string                            // & < > " '
utf8Length(value): number                            // ASCII fast path, no encoder allocation
newResponse(ctx, body, init?): Response             // LightResponse on the light path
drainPendingHeaders(ctx, res)                       // low-level: see below
```

| Type | Meaning |
| --- | --- |
| `StatusedResponse<S>` | `Response & { _status?: S }` — the status literal its builder used (compile-time only) |
| `JsonResponse<T, S>` | `Response & { _out?: T; _status?: S }` — brands the body type for `client.get(...).json()` |

Notes:

- All four byte-writing helpers set an explicit `content-length` — the contract `s200/etag` and `s200/compress` rely on (platforms serialize content-length lazily; a bare `new Response('…')` does not set it). Null-body statuses are exempt: `send` never advertises one on 1xx/204, and 304 omits it (RFC 9110 §15.4.5) instead of echoing the would-be size or advertising `0`.
- `json`/`text`/`html` accept `init.status` and stamp it into the brand; `redirect`'s third argument is the status.
- `html` does **not** escape — run user input through `escapeHtml` first (mirrors `hono/html`'s explicit-escape contract).

### Setting headers

`setHeader(ctx, name, value)` and `setHeaders(ctx, { name: value })` are the concise form of `ctx.res?.headers.set(...)` — and unlike the raw form they work at any point in the chain:

- **After `await next()`** the response is always materialized (handler's, fallback, or error response — the chain materializes all of them in-band); the header lands on it directly.
- **Before the response exists** (top of the middleware, or inside `onError`) the header is deferred and stamped onto whichever response the request first materializes — handler response, `404`/`405`/`500` fallback, or error response. A deferred value overrides the response's own header of the same name: middleware policy (`x-powered-by`, `cache-control`, security headers) wins over what the handler built.

`drainPendingHeaders(ctx, res)` is the low-level drain hook behind that contract — `newResponse`, the bare-`Response` adoption, and the error mapping call it. Battery/adapter authors adopting a response that bypassed `newResponse` call it too; application code never needs it.

## Body reading

Request bodies are **single-read**: all parse results are cached per `ctx`, so a second read replays the bytes instead of throwing "body already consumed". `readStream` is the exception — it never buffers, and every later buffered read rejects with a `409`.

```ts
readText(ctx, options?): Promise<string>
readJson<T = unknown>(ctx, options?): Promise<T>     // 400 HttpError on invalid JSON
readForm(ctx, options?): Promise<FormData>           // urlencoded + multipart, replayed through a fresh Request
readStream(ctx, options?): ReadableStream<Uint8Array> // never buffers; budget enforced as bytes flow
```

`BodyOptions`:

| Field | Default | Meaning |
| --- | --- | --- |
| `limit` | unlimited | Max body size in bytes; oversize bodies reject with a `413` `HttpError` mid-receive and the platform body is cancelled |

- `ctx.signal` is honored end to end: an already-aborted signal refuses before touching the stream; aborting mid-read cancels the source and rejects with an `AbortError`.
- `readForm` replays cached bytes through a synthetic `Request` so the platform's parser sees the original content-type.
- For incremental `multipart/form-data` parsing (never buffering the whole body) see [`s200/multipart`](/api/request#multipart-s200-multipart); for upload landing see [`s200/upload`](/api/request#upload-s200-upload).

## Static files

```ts
serveStatic(options): Middleware
```

`ServeStaticOptions` (injection-based — the core never touches a filesystem):

| Field | Required | Meaning |
| --- | --- | --- |
| `read` | yes | `(path) => Promise<Uint8Array \| ReadableStream \| null>` — bytes, a stream, or `null` on miss; byte readers also support ranges via subarray |
| `stat` | no | `(path) => Promise<StaticFileInfo \| null>` — enables conditional requests (ETag/Last-Modified → 304) and content-length for streamed responses |
| `readRange` | no | `(path, start, end) => Promise<ReadableStream \| null>` — memory-safe `[start, end]` (inclusive) range streaming |
| `root` | no | Path prefix joined onto every lookup key (default `''`: request paths as-is) |
| `prefix` | no | URL prefix stripped before lookup (e.g. `'/static'`) |
| `index` | no | Directory index file, default `'index.html'` |
| `spa` | no | `true` → `'index.html'`, or a filename: GET + text/html fallback for client-side routing |
| `cacheControl` | no | `Cache-Control` value stamped on 200/206/304; default none |
| `redirectToSlash` | no | `true` (default): directory path without trailing slash gets a 301 to `<path>/` |
| `dotfiles` | no | `'deny'` (default) falls through on `.env`-style paths; `'allow'` serves them |
| `realPath` | no | Symlink-escape guard — inject the adapter's `createRealPathGuard(root)`; the adapters' own `createFileReader`s already apply it by default, so custom readers are the ones that need it here |

`StaticFileInfo`: `{ size: number; mtimeMs: number }`.

**Conditionals and ranges.** With `stat` injected, responses carry `ETag`/`Last-Modified`; `If-None-Match`/`If-Modified-Since` hits answer `304` — bodyless and without `content-length` (RFC 9110 §15.4.5: s200 omits the header rather than echoing the would-be size). A single `Range: bytes=…` is served as `206` (`416` when unsatisfiable), gated by `If-Range` per RFC 9110 §13.1.5: only an `If-Range` that is an exact HTTP-date match with `Last-Modified` lets the range through; anything else (weak entity tag, mismatched date, unparseable value, or a response without validators) falls back to the full `200` body. The layer's own tag is weak (`W/"size-mtime"`), and If-Range requires a strong comparison — so an entity-tag `If-Range` never authorizes a range here, not even the file's own tag.

The Node and Bun adapters ship ready-made injectors — `createFileReader(root, { stream?, realPath?, streamThreshold? })` (realpath containment on by default, files over `streamThreshold` — default 16 MiB — stream instead of buffering), `createFileStat(root)`, `createFileRangeReader(root)`, `createRealPathGuard(root)` (see [`s200/node`](/api/node), [`s200/bun`](/api/bun)).
