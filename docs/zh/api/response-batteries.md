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
| `checkSchema(schema, value)` | 闭形状孪生：`(schema, value) => readonly SchemaIssue[]` —— 同一子集，但未声明的键就是违规；`path` 是键步进（`['items', 1, 'name']`，根为 `[]`），不是字符串 |
| `exampleToSchema(example)` | 从示例值推断 `SerializeSchema` —— `undefined` 表示"无 schema"（无 JSON 对应物） |

`SerializeSchema`（子集）：

```ts
type SerializeSchema =
  | { type: 'object'; properties: { [key: string]: SerializeSchema }; required?: readonly string[] }
  | { type: 'array'; items?: SerializeSchema }
  | { readonly type: PrimitiveType; readonly nullable?: boolean };
// 每个节点还接受可选 `title?: string` —— 纯注解：`toJsonSchema` 把它带入
// 输出的 JSON Schema（在 `s200/openapi` 里为去重后的 `components.schemas`
// 条目命名）；序列化与校验忽略它。不带 `items` 的数组元素不受约束：
// `serialize` 把数组原样交给 `JSON.stringify`，校验器只检查数组性，
// `InferSchema` 读作 `unknown[]`。
```

`PrimitiveType` 命名叶子备选：`'string' | 'number' | 'integer' | 'boolean' | 'null'`。

- `InferSchema<S>` 派生编译期输入类型（`required` 键不可选，`nullable: true` 放宽为 `T | null`）。
- 价值在声明的形状，而非原始速度：内部字段绝不会从序列化泄漏。现代引擎的 `JSON.stringify` 在典型负载上仍有竞争力 —— 在形状契约重要时使用，而非当加速黑客。
- 它是序列化形状而非验证器：不检查类型不匹配，`NaN`/`Infinity` 序列化为 `null`（JSON 语义）。
- `compileValidator` 一对一镜像该子集：类型不匹配在违规节点报告，`nullable` 先放行 `null`，缺失的 `required` 键在自己的路径报告，多余键被忽略。这正是 `s200/openapi` 的 `withRouteValidation` 使用的验证器。
- `checkSchema` 是它的闭形状孪生（`additionalProperties: false`，与 `serialize` 输出侧一致 —— 未声明的键即违规），报告 `SchemaIssue`（`{ path: readonly PropertyKey[]; message }`）。这是 `s200/response-check` 对响应 body 跑的检查器。

`ValidationIssue`：`{ path: string; message }` —— `path` 点连接模式相对位置（`'items.2.name'`；根为 `''`）。

### 示例推断（`exampleToSchema`）

`exampleToSchema(example)` 从运行时值推断 DSL —— 示例衍生表面背后唯一的结构推断层：`s200/codegen` 把它的输出渲染为 `throws` 示例的 TypeScript 类型，`s200/openapi` 经 `toJsonSchema` 把它渲染为错误响应的 schema，因此两个视图不会漂移。

```ts
exampleToSchema({ id: 1, roles: ['a', 'b'] });
// { type: 'object',
//   properties: { id: { type: 'integer' },
//                 roles: { type: 'array', items: { type: 'string' } } },
//   required: ['id', 'roles'] }
```

规则：数字按整型性拆分 `integer`/`number`；对象声明示例展示的每个键，全部 `required`（可选性无法从示例得知）；数组仅在所有元素推断出同一 schema 时携带 `items` —— 空数组或混合数组保持 `{ type: 'array' }`，元素不受约束。`undefined` —— 函数、symbol、bigint 等无 JSON 对应物的值同样 —— 表示"无 schema"；此类键从对象中丢弃，顶层这样的示例使该表面保持未声明。

## ETag（`s200/etag`）

在字节支撑的响应上盖 SHA-1 实体标签（默认弱标签），并以 `304` 应答 `If-None-Match` 命中。字节支撑意味着显式 `content-length` —— s200 的响应助手会设置，裸 `new Response('…')` 不会。分块/流式响应（SSE、`s200/streaming`）与 range 响应（206）被跳过而非缓冲。仅 `2xx` 响应会被盖标签，已带 `etag` 头的响应原样透传 —— 自己设置的标签优先。`304` 会丢弃复制来的 `content-length`（RFC 9110 §15.4.5：省略，而非本应具有的大小），其余盖过标签的头保留。

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

编码选择遵循 RFC 9110 §12.5.3：q 最高的编码胜出；显式编码的 q 压过 `*` 通配（与列表顺序无关）；显式 `q=0` 即使在 `*` 可接受时也封禁该编码。平局按服务器偏好 br > gzip > deflate 打破（brotli 压得最紧）；仅 `*` 时选 `br`（注入了 brotli 编码器时），否则 `gzip`；无可接受项则不压缩。q 被夹到 [0, 1]；无法解析的 q 参数被忽略（q 保持 1）。

跳过：已带 `content-encoding` 的响应、range 响应（`content-range`）、`cache-control: no-transform`（RFC 的不转换指令）与无体响应。凡被压缩的响应均盖 `Vary: Accept-Encoding`。在 `use` 顺序中注册于 logger/cors 之后 —— 它在 unwind 上重写响应。

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

泵的完成关闭流；泵的失败中止流。`init.headers` 接受所有合法的 `HeadersInit` 形态 —— 普通记录、`Headers` 实例、`[name, value]` 键值对数组 —— 且显式头始终优先：助手的默认 `content-type`（以及 `streamSSE` 的 `cache-control`）只补齐你未设置的名称。
