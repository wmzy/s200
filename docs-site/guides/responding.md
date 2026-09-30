# Responding

Response helpers write `ctx.res` in place (init headers always win over the defaults) and return the written `Response`:

```ts
json(ctx, { ok: true });                 // application/json
text(ctx, 'plain', { status: 201 });     // text/plain; charset=utf-8
html(ctx, '<h1>hi</h1>');                // text/html — does NOT escape
redirect(ctx, '/login');                 // 302
send(ctx, bytes, { headers: { 'content-type': 'application/pdf' } });
```

Handlers may also simply **return** a `Response` — it is written for you when nothing has been written yet. If a matched chain finishes without writing anything, s200 answers `500 {"error":"No response written"}`; an unmatched, unwritten request goes to `onNotFound` (default `404`). All fallbacks are materialized inside the chain, so middlewares on the unwind (logger, cors) see and stamp the real response.

`html` does **not** escape — interpolating user input is a template's job (or run `escapeHtml(value)` first). The helpers set `content-length` explicitly when the size is known (platforms serialize it lazily), so HEAD responses keep the would-be size and size-aware middlewares (`compress`'s `minBytes`, `s200/etag`) can see it.

Full reference: [Responding in the README](https://github.com/wmzy/s200#responding).
