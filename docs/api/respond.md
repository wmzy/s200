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
escapeHtml(value): string                            // & < > " '
utf8Length(value): number                            // ASCII fast path, no encoder allocation
newResponse(ctx, body, init?): Response             // LightResponse on the light path
```

| Type | Meaning |
| --- | --- |
| `StatusedResponse<S>` | `Response & { _status?: S }` — the status literal its builder used (compile-time only) |
| `JsonResponse<T, S>` | `Response & { _out?: T; _status?: S }` — brands the body type for `client.get(...).json()` |

Notes:

- All four byte-writing helpers set an explicit `content-length` — the contract `s200/etag` and `s200/compress` rely on (platforms serialize content-length lazily; a bare `new Response('…')` does not set it).
- `json`/`text`/`html` accept `init.status` and stamp it into the brand; `redirect`'s third argument is the status.
- `html` does **not** escape — run user input through `escapeHtml` first (mirrors `hono/html`'s explicit-escape contract).

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
| `realPath` | no | Symlink-escape guard — inject the adapter's `createRealPathGuard(root)` |

`StaticFileInfo`: `{ size: number; mtimeMs: number }`.

The Node and Bun adapters ship ready-made injectors — `createFileReader(root, { stream? })`, `createFileStat(root)`, `createFileRangeReader(root)`, `createRealPathGuard(root)` (see [`s200/node`](/api/node), [`s200/bun`](/api/bun)).
