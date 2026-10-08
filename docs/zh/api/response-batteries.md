# 响应电池（`s200/serialize`、`s200/etag`、`s200/compress`、`s200/streaming`）

模式驱动的序列化、实体标签、压缩与流式响应。

## 序列化（`s200/serialize`）

模式驱动的 JSON 序列化：`serialize(schema)` 为 JSON-Schema 形状子集编译序列化器，`jsonRaw` 把结果带精确 `content-length` 写成响应。

```ts
const toUser = serialize({
  type: 'object',
  properties: { id: { type: 'integer' }, name: { type: 'string' } },
  required: ['id', 'name'] as const,   // as const：数组字面量驱动可选性
});
get(app, '/users/:id', (ctx) => jsonRaw(ctx, toUser({ id: 1, name: 'ada' })));
```

| 函数 | 含义 |
| --- | --- |
| `serialize<S>(schema)` | 编译 `(value: InferSchema<S>) => string` —— 按模式顺序输出声明的键，丢弃未声明的 |
| `jsonRaw(ctx, json, init?)` | 写入已序列化的 JSON 串：`content-type: application/json`、精确 `content-length` |
| `compileValidator(schema)` | 读取侧孪生：`(data) => readonly ValidationIssue[]` —— 空列表即合规；绝不抛错或改写 |

`SerializeSchema`（子集）：

```ts
type SerializeSchema =
  | { type: 'object'; properties: { [key: string]: SerializeSchema }; required?: readonly string[] }
  | { type: 'array'; items: SerializeSchema }
  | { readonly type: PrimitiveType; readonly nullable?: boolean };
```

`PrimitiveType` 命名叶子备选：`'string' | 'number' | 'integer' | 'boolean' | 'null'`。

- `InferSchema<S>` 派生编译期输入类型（`required` 键不可选，`nullable: true` 放宽为 `T | null`）。
- 价值在声明的形状，而非原始速度：内部字段绝不会从序列化泄漏。现代引擎的 `JSON.stringify` 在典型负载上仍有竞争力 —— 在形状契约重要时使用，而非当加速黑客。
- 它是序列化形状而非验证器：不检查类型不匹配，`NaN`/`Infinity` 序列化为 `null`（JSON 语义）。
- `compileValidator` 一对一镜像该子集：类型不匹配在违规节点报告，`nullable` 先放行 `null`，缺失的 `required` 键在自己的路径报告，多余键被忽略。这正是 `s200/openapi` 的 `withRouteValidation` 使用的验证器。

`ValidationIssue`：`{ path: string; message: string }` —— `path` 点连接模式相对位置（`'items.2.name'`；根为 `''`）。

## ETag（`s200/etag`）

在字节支撑的响应上盖 SHA-1 实体标签（默认弱标签），并以 `304` 应答 `If-None-Match` 命中。字节支撑意味着显式 `content-length` —— s200 的响应助手会设置，裸 `new Response('…')` 不会。分块/流式响应（SSE、`s200/streaming`）与 range 响应（206）被跳过而非缓冲。

```ts
use(app, etag());                    // 默认 W/"…"
use(app, etag({ strong: true }));    // "…"
```

`EtagOptions`：`{ strong?: boolean }`。比较按 RFC 9110 §8.8.3 做弱比较（`W/` 前缀无关紧要）；`*` 匹配一切。

## 压缩（`s200/compress`）

基于 Web Standard `CompressionStream` 的响应压缩 —— 所有支持的运行时都提供。gzip/deflate 流式压缩体；brotli 经注入编码器可选启用（Node 的 `CompressionStream` 无 brotli —— node 适配器带 `brotliCompress`）：

```ts
import { compress } from 's200/compress';
import { brotliCompress } from 's200/node';
use(app, compress({ brotli: { compress: brotliCompress } }));
```

`CompressOptions`：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `minBytes` | `1024` | 压缩前最小未压缩字节数；仅在响应带 content-length 时参考（流式响应照压，像代理一样） |
| `brotli` | — | `{ compress: (bytes) => Promise<Uint8Array> }` —— 注入时才协商 `br`；brotli 是缓冲路径（仅字节支撑响应；流式响应回退 gzip/deflate） |

编码选择：最佳 `Accept-Encoding` 匹配 —— gzip 赢得平局，`*` 算 gzip，`q=0` 取消资格，`br` 平局负于 gzip。

## 流式（`s200/streaming`）

`ReadableStream` 上的推驱动流式响应 —— 零依赖，每个 Web Standard 运行时原生服务生成的 `Response`。在 handler 或中间件内调用：助手就地写 `ctx.res` 并返回；泵在中间件链之外分离运行。

```ts
import { stream, streamSSE } from 's200/streaming';

get(app, '/log', (ctx) => stream(ctx, async (w) => {
  for (const line of lines) { await w.write(line); }   // write 等待背压
  w.close();
}));

get(app, '/events', (ctx) => streamSSE(ctx, async (sse) => {
  await sse.writeSSE({ id: '1', event: 'tick', data: { t: Date.now() } });
  sse.heartbeat();                                     // keep-alive 注释
}));
```

| 函数 | 含义 |
| --- | --- |
| `stream(ctx, pump, init?)` | 分块纯文本输出（`application/octet-stream`）；`pump(writer)` 驱动 `StreamWriter`；`init` 覆盖状态码/头 |
| `streamSSE(ctx, pump, init?)` | Server-Sent Events（`text/event-stream`、`cache-control: no-cache`）；`pump(writer)` 驱动 `SseWriter`；`init` 覆盖状态码/头 |

| 类型 | 含义 |
| --- | --- |
| `StreamWriter` | `{ write(chunk): Promise<void>; close(): void; abort(error?): void }` —— `write` 缓冲后 resolve，背压下等待（泵内 await 它） |
| `SseWriter` | `StreamWriter & { writeSSE(event): Promise<void>; heartbeat(message?): Promise<void> }` |
| `SseEvent` | `{ id?, event?, data: string \| unknown, retry? }` —— `data` 对象会被 JSON 序列化 |

泵的完成关闭流；泵的失败中止流。
