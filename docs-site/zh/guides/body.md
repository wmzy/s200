# 请求体解析

三个读取器覆盖常见的请求体类型。无效 JSON 以 `400 HttpError` 拒绝，而不是向客户端抛原始 `SyntaxError`。

```ts
const body = await readJson<Login>(ctx);   // 无效 JSON → 400 HttpError
const raw = await readText(ctx);
const form = await readForm(ctx);          // FormData（urlencoded + multipart）
```

每次读取都接受字节预算：`readJson(ctx, { limit: 64 * 1024 })`（默认：无限制）。第一次读取在字节到达时计数，并在**缓冲之前**以 `413 HttpError` 拒绝超限请求体 —— 超大负载从不进入内存。

按平台契约，请求体是单次读取的；s200 按请求上下文缓存解析结果，因此多次读取（以及混合 json/text 读取）从一个缓冲区重放，而不是抛错。

完整参考：[README 中的请求体解析](https://github.com/wmzy/s200#body-parsing)。
