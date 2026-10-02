# 响应

响应辅助函数就地写入 `ctx.res`（显式头永远胜过默认值），并返回写入的 `Response`：

```ts
json(ctx, { ok: true });                 // application/json
text(ctx, 'plain', { status: 201 });     // text/plain; charset=utf-8
html(ctx, '<h1>hi</h1>');                // text/html —— 不转义
redirect(ctx, '/login');                 // 302
send(ctx, bytes, { headers: { 'content-type': 'application/pdf' } });
```

处理器也可以直接**返回** `Response` —— 尚未写入任何内容时它会被替你写入。若匹配的链结束而未写入任何内容，s200 回答 `500 {"error":"No response written"}`；未匹配且未写入的请求交给 `onNotFound`（默认 `404`）。所有回退都在链内物化，因此 unwind 上的中间件（logger、cors）能看到并盖上真实响应。

`html` **不**转义 —— 插值用户输入是模板的工作（或先运行 `escapeHtml(value)`）。当大小已知时辅助函数显式设置 `content-length`（平台是惰性序列化的），因此 HEAD 响应保留应有大小，感知大小的中间件（`compress` 的 `minBytes`、`s200/etag`）能看到它。

完整参考：[README 中的响应](https://github.com/wmzy/s200#responding)。
