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

## 转义

`html` **不**转义 —— 插值用户输入是模板的工作（或先运行 `escapeHtml(value)`），与 `hono/html` 的显式转义契约一致：`html(ctx, \`<p>${escapeHtml(user)}</p>\`)`。

## 返回的 Response

处理器也可以直接**返回** `Response` —— 当还没有写入任何内容时，它会为你写入。如果匹配的链结束时没有写入任何内容，s200 回答 `500 {"error":"No response written"}`；未匹配且未写入的请求交给 `onNotFound`（默认 `404`）。回退在链内物化，因此 unwind 时的中间件（logger、cors）能看到并盖上真实响应。

## content-length

当大小已知时，助手显式设置 `content-length`（平台惰性序列化它，因此裸 `new Response('…')` 不带）：HEAD 响应保留应有的大小，感知大小的中间件（`compress` 的 `minBytes`、`s200/etag`）能看到它。
