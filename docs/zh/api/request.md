# 请求接入（`s200/validate`、`s200/query`、`s200/accepts`、`s200/multipart`、`s200/upload`）

验证闸门、带类型的查询解析、内容协商与 multipart 处理。

## 验证（`s200/validate`）

把任意注入的解析函数包装为**闸门中间件**；解析值落在 `ctx.state.validated`。零依赖：带手写检查（或库的 `.parse`）即可 —— s200 只调用它。

```ts
post(app, '/articles', jsonBody(ArticleSchema.parse), (ctx) => {
  json(ctx, { saved: ctx.state.validated });
});
```

| 函数 | 含义 |
| --- | --- |
| `validate(parse, options?)` | 纯解析函数 `(ctx) => unknown` 上的闸门 —— 接收整个上下文，可自行读取方法、请求头或手工解析的请求体；抛出的值原样拒绝链（由应用的错误路径决定状态码） |
| `jsonBody<S>(schema)` | JSON 体模式上的闸门 —— 解析函数**或** Standard Schema 值（任何带 `~standard` 的） |
| `requiresHeaders<K>(...keys)` | 声明路由读取的请求头 —— `throws` 同款的纯透传闸门：不检查任何东西，键只随路由的 `in` 通道走，让 `s200/client` 把它们要求为 `init.headers`（每个键必填的 record）。执法归中间件 —— 读 `ctx.req.headers` 的 `validate(parse)` 是运行时孪生 |
| `bodyShape<T>()` | 声明路由读取的结构化请求体类型（上传路由 `bodyShape<FormData>()`、二进制路由 `bodyShape<Blob>()`）—— 同款纯声明模具；`s200/client` 把 `init.body` 类型化（并要求）为恰好 `T`，并按运行时的值编码：普通对象/数组会被 JSON 序列化并带上默认 `content-type: application/json`，而 `FormData`/`Blob`/流则原样传给 fetch。运行时读取留在 handler（`streamForm`、`uploadForm` 或裸 `ctx.req.body`） |
| `standardValidate(schema, data)` | 裸 Standard Schema 调用：`validate()` → `{ value }` 或 `{ issues }`；空 `issues` 算成功 |
| `isStandardSchema(value)` | 结构性 `~standard` 谓词 |

`ValidateOptions`：`{ key?: string }` —— 解析值的 `ctx.state` 槽位，默认 `'validated'`。

### Standard Schema 通道

```ts
type StandardSchemaV1 = { '~standard': { version: 1; vendor: string; validate(value: unknown): StandardResult } };
type StandardSchema<T = unknown> = StandardSchemaV1 & { types?: { input: unknown; output: T } };
type StandardIssue = { message: string; path?: readonly PropertyKey[] };
type StandardResult = { value?: unknown; issues?: readonly StandardIssue[] };
type InputOf<S> = …;   // schema.types.input
type OutputOf<S> = …;  // schema.types.output
```

幻影 `types` 属性免费类型化两侧：`jsonBody(schema)` 要求并类型化客户端的 `init.body`（输入侧，因此变换模式端到端诚实），而 `types.output` 是落到 `ctx.state.validated` 的产物。`jsonBody` 的首个验证问题变成携带其消息的单个 `422` `HttpError`。

## 查询（`s200/query`）

`validate` 的查询串孪生：

```ts
get(app, '/list', queryParams((q) => ({
  page: Number(q.page ?? 1),
  tags: q.tag ?? [],                    // 重复的 ?tag=a&tag=b → ['a','b']
})), (ctx) => json(ctx, ctx.state.validated));
```

| 函数 | 含义 |
| --- | --- |
| `parseQuery(ctx)` | 查询串 → `QueryRecord`（零原型对象；重复键收集为 `string[]`） |
| `queryParams<S>(schema)` | Standard Schema 上的闸门 —— `jsonBody` 的查询孪生 |
| `queryParams<Q, T>(read)` | 纯读取函数 `(query: Q) => T` 上的闸门 |

| 类型 | 含义 |
| --- | --- |
| `QueryRecord` | `Record<string, string \| string[]>` |
| `QueryInput` | `queryParams` 回调可声明的读取形状（值、数字、布尔、数组、可选键） |
| `QueryParamsOptions` | `{ key?: string }` —— `ctx.state` 槽位，默认 `'validated'` |

## 内容协商（`s200/accepts`）

基于 `Accept` / `Accept-Encoding` / `Accept-Language` 的 RFC 9110 协商 —— q 值、通配符、前缀区间，以及 §12.4.2 优先级（更具体的区间压过通配符，含特定 q=0 禁令）：

```ts
const want = accepts(ctx);
const type = want.type(['application/json', 'text/html']) ?? 'application/json';
```

`Accepts`（`accepts(ctx)` 的返回）：

| 方法 | 含义 |
| --- | --- |
| `type(candidates)` | 最佳媒体类型匹配，或 `undefined` |
| `encoding(candidates)` | 最佳 `Accept-Encoding` 匹配 |
| `language(candidates)` | 最佳 `Accept-Language` 匹配 |

## Multipart（`s200/multipart`）

增量 `multipart/form-data` 解析 —— 全体**从不**缓冲；每个 part 在其闭合边界一出现时就交给 `onPart`：

```ts
import { streamForm } from 's200/multipart';
await streamForm(ctx, (part) => { /* part.name, part.data, … */ });
// streamForm(ctx, onPart, options?) —— options.limit 限制全体字节预算；
// maxParts（默认 256）与 maxPartSize（默认 8 MiB）约束表单
```

`FormPart`：`{ name: string; filename?: string; contentType?: string; data: Uint8Array }` —— 二进制安全、字节精确。

内存按 part 而非按体受限：一个 part 的字节累积到其定界符到达，另加跨块边界的扫描窗口。part 的头块上限 16 KiB、传输填充上限 256 字节；越过任一即判为畸形。累积本身也在流中受限：`maxPartSize`（默认 8 MiB）在超限 part 的字节仍在到达途中时即以 `413` `HttpError` 拒绝（该 part 永远不会被完整缓冲），`maxParts`（默认 256）在违规 part 的头部处以 `413` 拒绝无尽小 part 的表单 —— 两者都会取消平台体。`Number.POSITIVE_INFINITY` 可解除任一上限。`limit` 预算在字节到达途中以 `413` 拒绝超限上传；已中止的 `ctx.signal` 浮现为 `AbortError`；对已流式化体的二次读取以 `409` 拒绝。

## 上传（`s200/upload`）{#upload-s200-upload}

`uploadForm` 经 `streamForm` 解析 multipart 请求，把每个接受的文件走过注入的 **sink** —— s200 保持零依赖，sink 决定字节落点（磁盘、对象存储、哈希）。

```ts
import { uploadForm } from 's200/upload';
import { writeFile } from 'node:fs/promises';

const result = await uploadForm(
  ctx,
  (file) => writeFile(`/tmp/${file.filename}`, file.data),   // sink
  {
    limit: 10 * 1024 * 1024,          // 总体预算，流式过程中强制执行
    maxFileSize: 5 * 1024 * 1024,     // 每文件上限（413）；只管文件，且仅在 8 MiB 流式地板之上才中途强制
    maxFiles: 8,                        // 文件 part 数上限（413）
    accept: ['image/'],                 // content-type 白名单（415）
  }
);
// result: { files: UploadedFile[], fields: QueryRecord }
```

| 函数 | 含义 |
| --- | --- |
| `uploadForm(ctx, sink, options?)` | 解析、过滤并落地上传；字段以文本返回，文件以缓冲的 `UploadFile` 加 sink 返回的任意 id 返回 |

| 类型 | 含义 |
| --- | --- |
| `UploadFile` | `{ name, filename, contentType?, data: Uint8Array, size }` —— 一个缓冲的文件 part |
| `UploadSink` | `(file: UploadFile) => Promise<string \| void> \| string \| void` —— 返回的字符串作为该文件的 `id` 报告；拒绝则中止整个上传 |
| `UploadAccept` | `readonly string[]`（媒体类型前缀）或 `(part: FormPart) => boolean` |
| `UploadOptions` | `{ limit?, maxFileSize?, maxFiles?, maxParts?, accept? }` —— 全部可选；即上文示例展示的闸门 |
| `UploadedFile` | `{ name, filename, contentType?, size, id? }` |
| `UploadResult` | `{ files: readonly UploadedFile[]; fields: QueryRecord }` |

闸门：`accept`（415）与 `maxFiles`（413）在 part 交付时运行；`maxFileSize` 只管文件 part —— 超限文件在 sink 看到它之前即以 `413` 拒绝（消息里带上文件名与上限）：低于 8 MiB 流式地板的文件在 part 交付时拒绝，高于它的则中途拒绝（越限字节即拒、源被取消）。文本字段不受它约束：它们保留总体 `limit` 与流自身的 8 MiB 每 part 默认上限。`maxParts`（默认 256，字段也计入）以同样方式在流中拒绝无尽 part 的表单。任何拒绝与任何 sink 错误都会中止上传：解析停止、平台源取消、错误冒泡。part 是缓冲单元：文件到达 sink 时已整体在内存 —— 真正巨大的文件请直接用 `streamForm`。
