# Body parsing

Three readers cover the common body kinds. Invalid JSON rejects with a `400 HttpError` instead of throwing a raw `SyntaxError` at the client.

```ts
const body = await readJson<Login>(ctx);   // invalid JSON → 400 HttpError
const raw = await readText(ctx);
const form = await readForm(ctx);          // FormData (urlencoded + multipart)
```

Every read accepts a byte budget: `readJson(ctx, { limit: 64 * 1024 })` (default: unlimited). The first read counts bytes as they arrive and rejects oversize bodies with a `413 HttpError` **before buffering them** — an oversized payload never sits in memory.

Bodies are single-read by platform contract; s200 caches the parse per request context, so multiple reads (and mixed json/text reads) replay from one buffer instead of throwing.

Full reference: [Body parsing in the README](https://github.com/wmzy/s200#body-parsing).
