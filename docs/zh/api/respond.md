# 响应、请求体与静态文件（`s200`）

核心 barrel 的三项能力：响应助手、请求体读取、静态文件服务。

## 响应助手

每个助手都就地写 `ctx.res` 并返回构建好的 `Response` —— 可作 handler 返回值，也可独立调用。

```ts
send(ctx, body, init?): StatusedResponse<S>          // BodyInit | Uint8Array | null
json<T, S>(ctx, data, init?): JsonResponse<T, S>    // JSON.stringify + content-length
text<S>(ctx, body, init?): StatusedResponse<S>      // text/plain; charset=utf-8
html<S>(ctx, body, init?): StatusedResponse<S>      // text/html; charset=utf-8 —— 不转义
redirect<S>(ctx, location, status?): StatusedResponse<S>  // 默认 302
escapeHtml(value): string                            // & < > " '
utf8Length(value): number                            // ASCII 快速路径，不分配编码器
newResponse(ctx, body, init?): Response             // light 路径上为 LightResponse
```

| 类型 | 含义 |
| --- | --- |
| `StatusedResponse<S>` | `Response & { _status?: S }` —— 构建器用过的状态字面量（仅编译期） |
| `JsonResponse<T, S>` | `Response & { _out?: T; _status?: S }` —— 为 `client.get(...).json()` 品牌化体类型 |

注意：

- 四个写字节的助手都显式设置 `content-length` —— 这是 `s200/etag` 与 `s200/compress` 依赖的契约（平台惰性序列化 content-length；裸 `new Response('…')` 不设置）。
- `json`/`text`/`html` 接受 `init.status` 并刻进品牌；`redirect` 的第三参数即状态。
- `html` **不**转义 —— 用户输入先过 `escapeHtml`（对齐 `hono/html` 的显式转义契约）。

## 请求体读取

请求体是**单次读取**：全部解析结果按 `ctx` 缓存，二次读取重放字节而非抛 "body already consumed"。`readStream` 是例外 —— 它从不缓冲，之后所有缓冲读取都以 `409` 拒绝。

```ts
readText(ctx, options?): Promise<string>
readJson<T = unknown>(ctx, options?): Promise<T>     // 非法 JSON → 400 HttpError
readForm(ctx, options?): Promise<FormData>           // urlencoded + multipart，经全新 Request 重放
readStream(ctx, options?): ReadableStream<Uint8Array> // 从不缓冲；预算随字节流动强制执行
```

`BodyOptions`：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `limit` | 无限 | 最大体字节数；超限体以 `413` `HttpError` 在接收中途拒绝，并取消平台体 |

- `ctx.signal` 全程生效：已中止的信号在触碰流之前就拒绝；读取中中止会取消源并以 `AbortError` 拒绝。
- `readForm` 把缓存字节经合成 `Request` 重放，使平台解析器看到原始 content-type。
- 增量 `multipart/form-data` 解析（永不缓冲全体）见 [`s200/multipart`](/zh/api/request#multipart-s200-multipart)；上传落地见 [`s200/upload`](/zh/api/request#upload-s200-upload)。

## 静态文件

```ts
serveStatic(options): Middleware
```

`ServeStaticOptions`（注入式 —— 核心绝不触碰文件系统）：

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `read` | 是 | `(path) => Promise<Uint8Array \| ReadableStream \| null>` —— 字节、流或未命中 `null`；字节读取器另经 subarray 支持 ranges |
| `stat` | 否 | `(path) => Promise<StaticFileInfo \| null>` —— 开启条件请求（ETag/Last-Modified → 304）与流式响应的 content-length |
| `readRange` | 否 | `(path, start, end) => Promise<ReadableStream \| null>` ——  内存安全的 `[start, end]`（闭区间）range 流 |
| `root` | 否 | 拼到每个查找键上的路径前缀（默认 `''`：请求路径原样） |
| `prefix` | 否 | 查找前剥离的 URL 前缀（如 `'/static'`） |
| `index` | 否 | 目录索引文件，默认 `'index.html'` |
| `spa` | 否 | `true` → `'index.html'`，或文件名：GET + text/html 的客户端路由回退 |
| `cacheControl` | 否 | 刻在 200/206/304 上的 `Cache-Control` 值；默认无 |
| `redirectToSlash` | 否 | `true`（默认）：无尾斜杠的目录路径 301 到 `<path>/` |
| `dotfiles` | 否 | `'deny'`（默认）对 `.env` 式路径放行到 next()；`'allow'` 像普通路径一样服务 |
| `realPath` | 否 | 符号链接逃逸守卫 —— 注入适配器的 `createRealPathGuard(root)` |

`StaticFileInfo`：`{ size: number; mtimeMs: number }`。

Node 与 Bun 适配器带现成的注入器 —— `createFileReader(root, { stream? })`、`createFileStat(root)`、`createFileRangeReader(root)`、`createRealPathGuard(root)`（见 [`s200/node`](/zh/api/node)、[`s200/bun`](/zh/api/bun)）。
