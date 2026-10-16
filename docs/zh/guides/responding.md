# 响应

## 响应助手

响应助手就地写 `ctx.res`（init 头总是胜过默认值）并返回写入的 `Response`：

```ts
json(ctx, { ok: true });                 // application/json
text(ctx, 'plain', { status: 201 });     // text/plain; charset=utf-8
html(ctx, '<h1>hi</h1>');                // text/html; charset=utf-8
redirect(ctx, '/login');                 // 302
send(ctx, bytes, { headers: { 'content-type': 'application/pdf' } });
```

## 设置响应头

`setHeader` / `setHeaders` 是 `ctx.res?.headers.set(...)` 的简洁形式 —— 而且在响应还不存在时也能用：

```ts
use(app, async (ctx, next) => {
  setHeader(ctx, 'x-powered-by', 's200');     // 尚无响应：先挂起
  const start = performance.now();
  await next();
  setHeader(ctx, 'x-duration', String(performance.now() - start));  // 直接写入
});
// 一次设置多个：
use(app, async (ctx, next) => {
  setHeaders(ctx, { 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff' });
  await next();
});
```

响应存在之前设置的头部会盖印到请求首次物化的那个响应上 —— 处理器响应、`404`/`405`/`500` 回退或错误响应 —— 并覆盖响应自带的同名头部（中间件策略胜出）。`await next()` 之后响应必定已物化，头部直接落在它上面。

## 转义

`html` **不**转义 —— 插值用户输入是模板的工作（或先运行 `escapeHtml(value)`），与 `hono/html` 的显式转义契约一致：`html(ctx, \`<p>${escapeHtml(user)}</p>\`)`。

## 返回的 Response

处理器也可以直接**返回** `Response` —— 当还没有写入任何内容时，它会为你写入。如果匹配的链结束时没有写入任何内容，s200 回答 `500 {"error":"No response written"}`；未匹配且未写入的请求交给 `onNotFound`（默认 `404`）。回退在链内物化，因此 unwind 时的中间件（logger、cors）能看到并盖上真实响应。

## content-length

当大小已知时，助手显式设置 `content-length`（平台惰性序列化它，因此裸 `new Response('…')` 不带）：HEAD 响应保留应有的大小，感知大小的中间件（`compress` 的 `minBytes`、`s200/etag`）能看到它。
