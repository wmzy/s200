# Responding

## The helpers

Response helpers write `ctx.res` in place (init headers always win over the defaults) and return the written `Response`:

```ts
json(ctx, { ok: true });                 // application/json
text(ctx, 'plain', { status: 201 });     // text/plain; charset=utf-8
html(ctx, '<h1>hi</h1>');                // text/html; charset=utf-8
redirect(ctx, '/login');                 // 302
send(ctx, bytes, { headers: { 'content-type': 'application/pdf' } });
```

## Setting headers

`setHeader` / `setHeaders` are the concise form of `ctx.res?.headers.set(...)` — and they work before a response exists, too:

```ts
use(app, async (ctx, next) => {
  setHeader(ctx, 'x-powered-by', 's200');     // no response yet: deferred
  const start = performance.now();
  await next();
  setHeader(ctx, 'x-duration', String(performance.now() - start));  // direct
});
// many at once:
use(app, async (ctx, next) => {
  setHeaders(ctx, { 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff' });
  await next();
});
```

A header set before the response exists is stamped onto whichever response the request first materializes — the handler's, a `404`/`405`/`500` fallback, or an error response — and overrides the response's own header of the same name (middleware policy wins). After `await next()` the response is always materialized, so the header lands on it directly.

## Escaping

`html` does **not** escape — interpolating user input is a template's job (or run `escapeHtml(value)` first), mirroring `hono/html`'s explicit-escape contract: `html(ctx, \`<p>${escapeHtml(user)}</p>\`)`.

## Returned Responses

Handlers may also simply **return** a `Response` — it is written for you when nothing has been written yet. If a matched chain finishes without writing anything, s200 answers `500 {"error":"No response written"}`; an unmatched, unwritten request goes to `onNotFound` (default `404`). The fallbacks are materialized inside the chain, so middlewares on the unwind (logger, cors) see and stamp the real response.

## content-length

The helpers set `content-length` explicitly when the size is known (platforms serialize it lazily, so a bare `new Response('…')` carries none): HEAD responses keep the would-be size, and size-aware middlewares (`compress`'s `minBytes`, `s200/etag`) can see it.

