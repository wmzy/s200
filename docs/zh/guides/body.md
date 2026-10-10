# 请求体解析

## 读取

```ts
const body = await readJson<Login>(ctx);   // invalid JSON → 400 HttpError
const raw = await readText(ctx);
const form = await readForm(ctx);          // FormData (urlencoded + multipart)
```

每次读取都接受字节预算：`readJson(ctx, { limit: 64 * 1024 })`。第一次读取在字节到达时计数，并在**缓冲之前**以 413 `HttpError` 拒绝超限的请求体 —— 超限负载永远不会驻留内存（对已缓冲请求体的后续限读在事后强制执行限制）。默认：无限。

按平台契约请求体是单次读取的；s200 按请求上下文缓存解析结果，因此多次读取（以及混合 json/text 读取）从一个缓冲重放，而不是抛出。

## 流式

对于太大无法缓冲的请求体，`readStream` 改为流式读取原始字节 —— `limit` 在字节流动时强制执行字节预算（超预算以 413 `HttpError` 错误流并取消上传），已中止的 `ctx.signal` 以 `AbortError` 错误流。它对该请求体是终结性的（后续缓冲读取以 409 拒绝）；已运行的缓冲读取以单个块重放：

```ts
const bytes = readStream(ctx, { limit: 64 * 1024 });   // ReadableStream<Uint8Array>
```

## multipart

`s200/multipart` 的 `streamForm` 在该预算之上增量解析 `multipart/form-data`：部分逐个随完成到达（逐部分缓冲，绝非整个请求体），解析 name/filename/content-type，非 multipart 内容类型回答 `415`，限制在请求体中途触发回答 `413`，截断/畸形请求体回答 `400`：

```ts
import { streamForm } from 's200/multipart';
await streamForm(ctx, (part) => {
  parts.push(part);   // { name, filename?, contentType?, data: Uint8Array }
}, { limit: 10 * 1024 * 1024 });
```

## 上传

`s200/upload` 的 `uploadForm(ctx, sink, options)` 是 `streamForm` 之上的落地助手：字段收集进 `fields`（parseQuery 语义 —— 单值 `string`，重复 `string[]`），文件部分通过 `accept`（前缀列表或回调；未命中回答 `415`）、`maxFiles`/`maxFileSize`（`413`，指明触发的约束）后到达你注入的 `sink` —— 零依赖，磁盘只是一行 `node:fs/promises` `writeFile` 之遥（见其 JSDoc）。`sink` 的返回字符串成为结果中文件的 `id`；抛出的 `sink` 将整个上传中止到错误边界。文件部分逐部分缓冲 —— 大文件请直接用 `streamForm`：

```ts
const { files, fields } = await uploadForm(ctx,
  async (file) => (await writeFile(join(dir, file.filename ?? file.name), file.data), file.filename),
  { limit: 10 * 1024 * 1024, maxFileSize: 5 * 1024 * 1024, accept: ['image/'] });
```
