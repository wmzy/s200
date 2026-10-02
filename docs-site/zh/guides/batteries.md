# 电池模块

可选模块住在独立的包入口 —— 只导入用到的那个，核心保持精简。整个模块面上有两种反复出现的形态：**门（gate）**就地应答（`401` / `403` / `429` …），其下的链不再运行；**unwind 盖章器（unwind stamper）**在 `await next()` 之后写响应头 —— 此时响应必然存在，回退与错误响应 included，因为它们都在链内物化。

```ts
import { cors } from 's200/cors';                          // 0.58 kB gz，零运行时导入
import { basicAuth, bearerAuth } from 's200/auth';
import { rateLimit } from 's200/rate-limit';
import { stream, streamSSE } from 's200/streaming';
```

## 安全

### Auth

`s200/auth` —— `basicAuth` / `bearerAuth` 门：注入的 `verify` 函数裁决，失败就地应答 `401` + `WWW-Authenticate`，其下的链不再运行。

完整参考：[README 中的 auth —— 电池模块](https://github.com/wmzy/s200#batteries)。

### CSRF

`s200/csrf` —— 无会话的同步器令牌，HMAC 签名（nonce + 过期时间），只有你的密钥能签发。经 cookie 交付；非安全请求必须在头/表单字段中**原样带回**并匹配请求 `Origin` —— 两个经典 double-submit 漏洞同时关闭。令牌存放在 `ctx.state.csrfToken`，`csrf.token(ctx)` 把它回显进服务端渲染的表单，非安全请求缺失时就地应答 `403`。

完整参考：[README 中的 csrf —— 电池模块](https://github.com/wmzy/s200#batteries)。

### JWT

`s200/jwt` —— 基于 WebCrypto 的 HS/RS/PS/ES × 256/384/512，零依赖。`verifyJwt` 无条件拒绝 `alg:none`，强制 `exp`/`nbf`，按请求检查 `aud`/`iss`，且密钥族必须与头算法匹配 —— 密钥混淆攻击在结构上被关闭。`jwtAuth` 是门（payload 落在 `ctx.state.jwt`，就地 `401`），密钥可来自 secret、`CryptoKey`、JWK、缓存的 JWKS 端点，或自定义 `keyResolver`。

完整参考：[README 中的 jwt —— 电池模块](https://github.com/wmzy/s200#batteries)。

### Secure headers

`s200/secure-headers` —— 在 unwind 时盖上的安全默认基线，fallback 响应 included：nosniff、`DENY` 框架保护、strict-origin-when-cross-origin。处理器自己的头永远胜出，`false` 可丢弃某一项，HSTS 为可选。

完整参考：[README 中的 secure headers —— 电池模块](https://github.com/wmzy/s200#batteries)。

### Rate limit

`s200/rate-limit` —— 每个客户端 key 的真正滑动窗口：每次命中在其落地 `windowMs` 后过期，窗口边缘无法突发。超限请求就地应答 `429` + `Retry-After`，其下的链不再运行。默认 key 读取 `x-forwarded-for`（只有在其被覆写的代理背后才有意义 —— 其他身份标识请传 `key`）；计数器在进程内，跨实例共享限额请注入 Redis-INCR 形态的 `store`。

完整参考：[README 中的 rate limit —— 电池模块](https://github.com/wmzy/s200#batteries)。

## 协商与缓存

### CORS

`s200/cors` —— 应用级或逐路由。预检请求就地应答 204（处理器永不运行）；真实响应在 unwind 时盖上 allow-origin 头 —— fallback 404/405/500 included。默认 `'*'` 输出字面通配符；白名单与 resolver 会回显请求来源并设置 `Vary: Origin`。浏览器拒绝带凭据的通配符（fail-closed）—— `credentials` 必须配显式来源。

完整参考：[README 中的 cors —— 电池模块](https://github.com/wmzy/s200#batteries)。

### Accepts

`s200/accepts` —— 基于 `Accept` / `Accept-Encoding` / `Accept-Language` 的 RFC 9110 内容协商：q 值、通配符、前缀范围，以及「具体 q=0 压过通配符」的优先级。`accepts(ctx).type(['application/json', 'text/html'])` 选出胜者。

完整参考：[README 中的 accepts —— 电池模块](https://github.com/wmzy/s200#batteries)。

### ETag

`s200/etag` —— 在带字节背书的响应上盖弱（或强）SHA-1 实体标签，`If-None-Match` 命中应答 304。带字节背书指显式 `content-length`：s200 的响应辅助函数会设置它，裸 `new Response('…')` 需要手动设置。分块/流式响应直接跳过，不缓冲。

完整参考：[README 中的 etag —— 电池模块](https://github.com/wmzy/s200#batteries)。

### Cache

`s200/cache` —— 带 TTL + 类 LRU 淘汰与有界体积的响应缓存。默认安全：仅 GET/200，`Set-Cookie` 响应永不存储，`Authorization` 请求永不服务，`Cache-Control: no-cache` 强制穿透。默认 store 在进程内；自定义 `store`（对 `{ exp, status, headers, body }` 条目的 `get`/`set`/`delete`）跨实例共享缓存 —— 每次读取时中间件仍会检查过期。

完整参考：[README 中的 cache —— 电池模块](https://github.com/wmzy/s200#batteries)。

### Compress

`s200/compress` —— 通过 Web Standard `CompressionStream` 的 gzip/deflate（不用 `node:zlib` —— Node 18+、Bun、Deno 均可运行），另可通过注入编码器可选 brotli（`s200/node` 提供 `brotliCompress`）。协商 `Accept-Encoding` q 值，跳过无响应体/已编码/`no-transform` 响应与小体积（已知 content-length 时），并维护 `Vary: Accept-Encoding`。brotli 是缓冲路径 —— 仅限带字节背书的响应；流式响应回退到 gzip/deflate。

完整参考：[README 中的 compress —— 电池模块](https://github.com/wmzy/s200#batteries)。

### Trust proxy

`s200/trust-proxy` —— 依据 `X-Forwarded-Proto`/`X-Forwarded-Host` 修正 `ctx.url` 的协议/主机，并把客户端地址记录在 `ctx.state.proxy`，`X-Forwarded-For` 带跳数计数。请在 `s200/csrf`、`s200/secure-headers` 及一切构造绝对 URL 的模块之前注册。

完整参考：[README 中的 trust proxy —— 电池模块](https://github.com/wmzy/s200#batteries)。

## 可观测性

### Logger

`s200/logger` —— 每请求一行（`ISO 时间 方法 路径 状态码 耗时`），经可插拔的 `sink`/`format`。状态码永远是真实状态 —— 回退**与错误响应**都在链内物化，logger 能看到每个请求，包括 500。

完整参考：[README 中的 logger —— 电池模块](https://github.com/wmzy/s200#batteries)。

### Request ID

`s200/request-id` —— 每请求的规范关联 id（`ctx.state.requestId`），尊重传入 id 并盖在响应上 —— 错误响应 included。默认为 `x-request-id`；`header` 与 `generator` 为选项。

完整参考：[README 中的 request id —— 电池模块](https://github.com/wmzy/s200#batteries)。

### OTel

`s200/otel` —— `trace()` 是 OpenTelemetry 兼容的 span 中间件，建立在鸭子类型 `Tracer`/`Span` 接口上（零依赖 —— 用一个 lambda 桥接 `@opentelemetry/api`）。span 观察每个请求的真实状态 —— 处理器、404/405 回退、映射后的 500 一视同仁 —— 因为响应都在链内物化；拒绝以异常记录并重抛。

完整参考：[README 中的 otel —— 电池模块](https://github.com/wmzy/s200#batteries)。

### Timeout

`s200/timeout` —— 让链与截止时间赛跑；迟到的处理器得到 `503 {"error":"Request timeout"}`，且截止时间同时中止 `ctx.signal`，协作型工作（请求体读取、下游 fetch）会停止而非在后台跑完。

完整参考：[README 中的 timeout —— 电池模块](https://github.com/wmzy/s200#batteries)。

### Versioning

`s200/version` —— `apiVersion` 是版本门（头或 Accept media-type 策略；URI 版本化就是 `mount`）。解析出的版本落在 `ctx.state.version`；不支持的版本就地应答 `404`，unwind 时盖 `Vary` 让缓存按版本分键。

完整参考：[README 中的 versioning —— 电池模块](https://github.com/wmzy/s200#batteries)。

## 运维

应用生命周期层 —— 优雅停机、探针、配置、任务与事件，以数据 + 函数形态呈现的 NestJS 生命周期面。

### Lifecycle

`s200/lifecycle` —— 建立在任意适配器 `serve()` 结果上的信号驱动优雅停机：先翻转就绪门（流量停止进入），停止监听，在预算内排空在途请求（截止时间或第二个信号硬杀滞留者），再运行 `onShutdown`。运行时按鸭子类型分派 —— node 与 Bun 走各自的原生优雅路径。

完整参考：[README 中的 lifecycle —— 电池模块](https://github.com/wmzy/s200#batteries)。

### Health

`s200/health` —— `health()` 是存活探针；`readiness(checks)` 并发运行可注入的检查（各自带超时预算与请求的 `ctx.signal`），应答 `200`/`503` 并逐一列明每个检查的结果。`createGate()` 是可组合开关，drain 一开始就关闭就绪。

完整参考：[README 中的 health —— 电池模块](https://github.com/wmzy/s200#batteries)。

### Config

`s200/config` —— `parseEnv`（纯 `.env` 解析器）加 `createConfig`：Standard-Schema 类型化、fail-fast 校验，启动时抛出**一个**聚合全部问题的 `Error`。I/O 保持注入 —— 解析器接收文本，文件由你读。

完整参考：[README 中的 config —— 电池模块](https://github.com/wmzy/s200#batteries)。

### Schedule

`s200/schedule` —— `createScheduler` 运行 cron（5 段）与 interval 任务，带绝对时间重武装（无漂移）、每任务并发 1、可注入时钟，以及等待在途运行的 `stop()` —— 把它接进 `onShutdown`。`nextRun(expr, from)` 是纯匹配器。

完整参考：[README 中的 schedule —— 电池模块](https://github.com/wmzy/s200#batteries)。

### Events

`s200/events` —— `createBus` 是建立在 [`@for-fun/event-emitter`](https://www.npmjs.com/package/@for-fun/event-emitter) 之上的类型化事件总线（唯一有依赖的电池模块）：键、监听器参数与 emit 参数都按声明的事件映射收窄。`emit` 是同步收集错误的（库语义）；`emitAsync` 等待返回 promise 的监听器，拒绝经同一 `onError` 通道处理。

完整参考：[README 中的 events —— 电池模块](https://github.com/wmzy/s200#batteries)。

## 数据与工具

### Validate

`s200/validate` —— 把你的解析函数（zod/valibot/typebox/手写 —— s200 保持零依赖，只调用它）包装为门中间件；解析值落在 `ctx.state.validated`。失败模式由解析函数决定 —— 抛错像任何中间件错误一样拒绝链；`jsonBody` 的 `readJson` 在 schema 运行之前以 400 拒绝无效 JSON。`jsonBody(parse)` 还用解析返回类型给路由加品牌，喂给 `s200/client` 的请求体类型。

完整参考：[README 中的 validate —— 电池模块](https://github.com/wmzy/s200#batteries)。

### Query

`s200/query` —— validate 的查询字符串孪生：`parseQuery(ctx)` 把查询串变成普通 record（重复键收集为数组 —— `?tag=a&tag=b` → `['a','b']`），`queryParams` 用 schema 包一层作为门，`QueryOf<'page&tag'>` 在编译期为查询字符串字面量定类型。

完整参考：[README 中的 query —— 电池模块](https://github.com/wmzy/s200#batteries)。

### Serialize

`s200/serialize` —— `serialize(schema)` 为 JSON-Schema 形状子集（对象、数组、原始值、`nullable`）编译序列化器；`jsonRaw` 把结果带精确 `content-length` 写成响应。收益是声明的形状而非原始速度：输出恰好携带声明的键（内部字段永不泄露），schema 在编译期驱动输入类型。它是序列化形状而非校验器 —— 类型不匹配不检查；`NaN`/`Infinity` 序列化为 `null`。

完整参考：[README 中的 serialize —— 电池模块](https://github.com/wmzy/s200#batteries)。

### Route table

`s200/route-table` —— `data + functions` 的红利：应用是普通数据，因此 `createRouteTable(app)` 不执行任何代码就导出 JSON（每条路由的 `method`、`pattern`、`params`、`middlewareCount`）。便于路由清单或跨语言翻译 —— `s200/openapi` 建立在同一张表上。

完整参考：[README 中的 route table —— 电池模块](https://github.com/wmzy/s200#batteries)。

### OpenAPI

`s200/openapi`（+ `s200/meta`）—— 路由表即 API 面，OpenAPI 3.1 文档直接从它产出：`describeApp` 命名 API，`describeRoute` 标注（摘要、标签、查询/请求体 schema、响应形状），`openapiSpec` 产出规范 —— 未标注的路由仍以参数和裸 200 出现。

完整参考：[README 中的 openapi —— 电池模块](https://github.com/wmzy/s200#batteries)。

### API 文档页

`s200/swagger` —— `swaggerUi(ctx, { url })` 为你的 OpenAPI 规范服务 Scalar API Reference 页面（资源从钉版的 CDN 加载，s200 保持零依赖）；`title`、`theme` 与自托管 `cdn` 为选项，所有插值值经 HTML 转义。

完整参考：[README 中的 openapi —— 电池模块](https://github.com/wmzy/s200#batteries)。

### Codegen

`s200/codegen` —— `generateClient(app)` 从运行时路由表产出独立 TypeScript 客户端模块：每条路由一个类型化方法，带 `ParamsOf<'…'>` 参数、方法内置，只剩 types-only 导入。响应体保持 `Response`（运行时数据不带请求体类型） —— 适合把类型化调用方交给任意技术栈的消费者，而不必发送 s200。

完整参考：[README 中的 codegen —— 电池模块](https://github.com/wmzy/s200#batteries)。

### Client

`s200/client` —— 从应用自身路由表派生的类型安全 fetch 客户端：路径限定为已注册的模式字面量，参数类型由其推导（`:id` 必填、`:id?` 可选、`*path` 保持斜杠连接），`query` 选项构造查询串。类型从注册器返回类型流出 —— 串起返回值（`const b = get(a, …)`）以保留路由日志；门品牌（`jsonBody`、`queryParams`）给请求体和查询定类型，`json(ctx, data)` 处理器携带类型化响应体。畸形调用同步抛错；任何说同种模式语法的服务器都能应答。

完整参考：[README 中的 client —— 电池模块](https://github.com/wmzy/s200#batteries)。

### Testing

`s200/test` —— 无网络驱动应用：`request(app, '/users/1')` 是带完整回退语义的 `handle()`（hono 的 `app.request()` 形态）；`testClient(app)` 是 fetch 在进程内路由的 `createClient`，保留类型化路径/参数/请求体；`probeApp(app)` 用合成参数分发每条已注册路由并报告 `{ method, pattern, status, ok }` —— 机械式「没有路由 500」契约测试。

完整参考：[README 中的 testing —— 电池模块](https://github.com/wmzy/s200#batteries)。

## 传输

### WebSocket

`s200/websocket`（+ `s200/websocket/node`、`s200/websocket/bun`）—— `upgradeWebSocket(app, pattern, handler)` 以路由模式语法注册 ws 路由；处理器拿到 `send`/`close`/`onMessage`/`onClose`/`onError` socket 加请求形态的 `ctx`（params/query/url）。Node 通过适配器的 `upgrade` 选项接线零依赖 RFC 6455 服务端 —— 握手、分片的文本/二进制、ping/pong、关闭握手、`maxPayload` 预算、可选的子协议协商与 permessage-deflate、心跳面；Bun 通过桥接接入 `Bun.serve`。

完整参考：[README 中的 websocket —— 电池模块](https://github.com/wmzy/s200#batteries)。

### Streaming

`s200/streaming` —— `stream` 服务推驱动的分块；`streamSSE` 以感知背压的写入帧 Server-Sent Events，带 `writer.heartbeat()` 辅助函数。

完整参考：[README 中的 streaming —— 电池模块](https://github.com/wmzy/s200#batteries)。

### Cookies

`s200/cookies` —— 以纯函数读取、写入、签名。写入追加规范的 `Set-Cookie` 头（重复调用保持独立头，绝不逗号拼接）；在响应存在后调用 —— 自然位置是 unwind，即 `await next()` 之后。签名 cookie 带 HMAC 伴侣（`sid.sig`）；`getSignedCookie` 除非验证通过否则返回 `undefined`。

完整参考：[README 中的 cookies —— 电池模块](https://github.com/wmzy/s200#batteries)。

### Session

`s200/session` —— `createSession({ secret, store? })` 返回中间件（外加默认 store 清扫器的 `close()`）：签名 cookie 会话，可插拔存储（`get`/`set`/`delete`，TTL 传给 `set` —— 即 Redis `SET … EX` 形态；默认进程内、惰性过期）。客户端只持有不透明的签名 id；被篡改、缺失、过期的 id 表现一致 —— 都是全新的空会话，绝不报错。变更在 unwind 时持久化并（重新）签发 cookie；`destroy()` 从 store 删除并使 cookie 过期；只读请求不写任何东西。

完整参考：[README 中的 cookies —— 电池模块](https://github.com/wmzy/s200#batteries)。

### Uploads

`s200/upload` —— `uploadForm(ctx, sink, options)` 经 `streamForm` 落地 multipart 上传：字段按 parseQuery 语义收集（单个 `string`，重复 `string[]`），文件部分在到达注入的 sink 前经过 `accept`（415）、`maxFiles`/`maxFileSize`（413，报出具体约束）检查 —— 落盘只是一行 `node:fs/promises` 的 `writeFile`。sink 的返回字符串成为文件 `id`；抛错的 sink 中止上传。文件部分按部分缓冲 —— 大文件留在 `streamForm`。

完整参考：[README 中的 batteries](https://github.com/wmzy/s200#batteries)。
