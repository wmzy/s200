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
setHeader(ctx, name, value)                         // 直接写入；响应未物化时挂起
setHeaders(ctx, { name: value })                    // 一次多个，按插入顺序
resOf(ctx): Response                                // next() 之后读取 res，误用时点名抛错
escapeHtml(value): string                            // & < > " '
utf8Length(value): number                            // ASCII 快速路径，不分配编码器
newResponse(ctx, body, init?): Response             // light 路径上为 LightResponse
drainPendingHeaders(ctx, res)                       // 低层钩子：见下
```

| 类型 | 含义 |
| --- | --- |
| `StatusedResponse<S>` | `Response & { _status?: S }` —— 构建器用过的状态字面量（仅编译期） |
| `JsonResponse<T, S>` | `Response & { _out?: T; _status?: S }` —— 为 `client.get(...).json()` 品牌化体类型 |
| `SettledCtx<S>` | `Ctx & { res: Response }` —— `await next()` 结束后的 ctx，`res` 从 `undefined` 收窄掉（仅编译期） |

注意：

- 四个写字节的助手都显式设置 `content-length` —— 这是 `s200/etag` 与 `s200/compress` 依赖的契约（平台惰性序列化 content-length；裸 `new Response('…')` 不设置）。无主体状态豁免：`send` 在 1xx/204 上绝不宣告，304 则省略该头（RFC 9110 §15.4.5）——既不回显本应具有的大小，也不宣告 `0`。
- `json`/`text`/`html` 接受 `init.status` 并刻进品牌；`redirect` 的第三参数即状态。
- `html` **不**转义 —— 用户输入先过 `escapeHtml`（对齐 `hono/html` 的显式转义契约）。

### 设置响应头

`setHeader(ctx, name, value)` 与 `setHeaders(ctx, { name: value })` 是 `ctx.res?.headers.set(...)` 的简洁形式 —— 且与裸写法不同，链内任意时机都能用：

- **`await next()` 之后**响应必定已物化（处理器的、回退的或错误的 —— 链内全部就地物化）；头部直接落在它上面。
- **响应尚未存在时**（中间件顶部、或 `onError` 内部）头部被挂起，盖印到请求首次物化的那个响应上 —— 处理器响应、`404`/`405`/`500` 回退或错误响应。挂起值覆盖响应自带的同名头部：中间件策略（`x-powered-by`、`cache-control`、安全头）胜过处理器构建的内容。

`drainPendingHeaders(ctx, res)` 是该契约背后的低层 drain 钩子 —— `newResponse`、裸 `Response` 采用与错误映射都会调用它。绕过 `newResponse` 采用响应的电池/适配器作者也需要调用它；应用代码永远用不到。

### next() 之后的收窄 {#post-next-narrowing}

同一份不变量支撑两个读取助手。`resOf(ctx)` 返回 `ctx.res` —— `await next()` 结束后它必定存在（处理器的、回退的或错误的响应 —— 链内全部就地物化），unwind 上的中间件因此跳过 `?.`：

```ts
use(app, async (ctx, next) => {
  await next();
  logger.info(`${ctx.req.method} ${ctx.url.pathname} → ${resOf(ctx).status}`);
});
```

在响应存在之前调用它是程序员错误，抛出一个点名误用的普通 `Error`（不是 `HttpError` —— 它永远不会到达客户端；响应前的头部工作请用 `setHeader`/`setHeaders`）。`SettledCtx<S>` 是类型层的孪生：`Ctx & { res: Response }`，面向只在 next() 之后运行的辅助函数：

```ts
function statusLine(ctx: SettledCtx): string {
  return `${ctx.req.method} ${ctx.url.pathname} → ${ctx.res.status}`;
}
```

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
| `realPath` | 否 | 符号链接逃逸守卫 —— 注入适配器的 `createRealPathGuard(root)`；适配器自己的 `createFileReader`/`createFileStat`/`createFileRangeReader` 已默认内置该守卫，这里主要供自定义 reader 使用。`null` 表示查找逃出 root；仅仅不存在的路径不得返回 `null`（未命中不是逃逸，SPA 回退依赖这一区分） |

`StaticFileInfo`：`{ size: number; mtimeMs: number }`。

**条件请求与范围。** 注入 `stat` 后，响应携带 `ETag`/`Last-Modified`；`If-None-Match`/`If-Modified-Since` 命中以 `304` 应答 —— 无主体且不带 `content-length`（RFC 9110 §15.4.5：s200 选择省略该头，而非回显本应具有的大小）。单个 `Range: bytes=…` 以 `206` 服务（不可满足时 `416`），并按 RFC 9110 §13.1.5 受 `If-Range` 门控：只有与 `Last-Modified` 精确匹配的 HTTP-date 才放行范围；其余情形（弱实体标签、日期不匹配、无法解析的值、或无验证器的响应）回退到完整 `200` 主体。本层自己的标签是弱标签（`W/"size-mtime"`），而 If-Range 要求强比较 —— 因此实体标签形式的 `If-Range` 在这里永不放行范围，即便是文件自己的标签。

Node 与 Bun 适配器带现成的注入器 —— `createFileReader(root, { stream?, realPath?, streamThreshold? })`（realpath 包含性检查默认开启、超过 `streamThreshold` —— 默认 16 MiB —— 的文件流式返回而非缓冲）、`createFileStat(root)`、`createFileRangeReader(root)`、`createRealPathGuard(root)`（见 [`s200/node`](/zh/api/node)、[`s200/bun`](/zh/api/bun)）。三个工厂函数（read、stat、range）都默认应用 realpath 包含性检查并拒绝目录，因此 `Range` 请求无法触及普通读取拒绝的文件。`createRealPathGuard` 遵循同一契约：仅逃逸的真实路径（或无法解析的 root）返回 `null`；未命中返回其解析路径，SPA 回退仍可执行。
