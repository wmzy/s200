# Body parsing

## Reading

```ts
const body = await readJson<Login>(ctx);   // invalid JSON → 400 HttpError
const raw = await readText(ctx);
const form = await readForm(ctx);          // FormData (urlencoded + multipart)
```

Every read accepts a byte budget: `readJson(ctx, { limit: 64 * 1024 })`. The first read counts bytes as they arrive and rejects oversize bodies with a 413 `HttpError` **before buffering them** — an oversized payload never sits in memory (a later limited read of an already-buffered body enforces the limit after the fact). Default: unlimited.

Bodies are single-read by platform contract; s200 caches the parse per request context, so multiple reads (and mixed json/text reads) replay from one buffer instead of throwing.

## Streaming

For bodies too large to buffer, `readStream` streams the raw bytes instead — a `limit` enforces the byte budget as bytes flow (over budget errors the stream with a 413 `HttpError` and cancels the upload), and an aborted `ctx.signal` errors it with an `AbortError`. It is terminal for the body (later buffered reads reject 409); a buffered read that already ran replays as a single chunk:

```ts
const bytes = readStream(ctx, { limit: 64 * 1024 });   // ReadableStream<Uint8Array>
```

## Multipart

`s200/multipart`'s `streamForm` parses `multipart/form-data` incrementally over that budget: parts arrive one by one as they complete (per-part buffering, never the whole body), with name/filename/content-type parsed, `415` for non-multipart content types, `413` when the limit trips mid-body, and `400` for truncated/malformed bodies:

```ts
import { streamForm } from 's200/multipart';
await streamForm(ctx, (part) => {
  parts.push(part);   // { name, filename?, contentType?, data: Uint8Array }
}, { limit: 10 * 1024 * 1024 });
```

## Uploads

`s200/upload`'s `uploadForm(ctx, sink, options)` is the landing helper over `streamForm`: fields collect into `fields` (parseQuery semantics — single value `string`, repeats `string[]`), and file parts pass through `accept` (prefix list or callback; a miss answers `415`), `maxFiles`/`maxFileSize` (`413`, naming which constraint tripped) before reaching your injected `sink` — zero-dependency, disk is a one-line `node:fs/promises` `writeFile` away (see its JSDoc). The sink's return string becomes the file's `id` in the result; a throwing sink aborts the whole upload to the error boundary. File parts are buffered per-part — for huge files stay on `streamForm` directly:

```ts
const { files, fields } = await uploadForm(ctx,
  async (file) => (await writeFile(join(dir, file.filename ?? file.name), file.data), file.filename),
  { limit: 10 * 1024 * 1024, maxFileSize: 5 * 1024 * 1024, accept: ['image/'] });
```

