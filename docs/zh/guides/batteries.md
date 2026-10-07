# 电池模块

可选模块住在独立的包入口 —— 只导入用到的那个，核心保持精简。

```ts
import { cors } from 's200/cors';           // 0.58 kB gz, zero runtime imports
import { logger } from 's200/logger';
import { createRouteTable } from 's200/route-table';
import { getCookie, setCookie, getSignedCookie, setSignedCookie } from 's200/cookies';
import { validate, jsonBody } from 's200/validate';
import { parseQuery, queryParams } from 's200/query';
import { rateLimit } from 's200/rate-limit';
import { compress } from 's200/compress';
import { stream, streamSSE } from 's200/streaming';
import { requestId } from 's200/request-id';
import { timeout } from 's200/timeout';
import { upgradeWebSocket } from 's200/websocket';
import { createUpgradeHandler } from 's200/websocket/node';
import { createBunWebSocketBridge } from 's200/websocket/bun';
import { etag } from 's200/etag';
import { secureHeaders } from 's200/secure-headers';
import { basicAuth, bearerAuth } from 's200/auth';
import { accepts } from 's200/accepts';
import { serialize, jsonRaw } from 's200/serialize';
import { createClient } from 's200/client';
import { createCsrf } from 's200/csrf';
import { describeRoute, describeApp } from 's200/meta';
import { openapiSpec, openapiJson } from 's200/openapi';
import { signJwt, verifyJwt, jwtAuth } from 's200/jwt';
import { cache } from 's200/cache';
import { trustProxy } from 's200/trust-proxy';
import { serve as serveDeno } from 's200/deno';
import { createHandler } from 's200/cloudflare';
import { trace } from 's200/otel';
import { generateClient } from 's200/codegen';
import { request, testClient, probeApp } from 's200/test';
import { streamForm } from 's200/multipart';
import { createSession } from 's200/session';
import { swaggerUi } from 's200/swagger';
import { uploadForm } from 's200/upload';
import { lifecycle } from 's200/lifecycle';
import { health, readiness, createGate } from 's200/health';
import { parseEnv, createConfig } from 's200/config';
import { createScheduler, nextRun } from 's200/schedule';
import { createBus } from 's200/events';
import { apiVersion } from 's200/version';
```

**CORS** —— 应用级或路由级。预检就地以 204 应答（处理器永不运行）；真实响应在 unwind 时盖上 allow-origin 头 —— 回退 404/405/500 响应 included，因为它们在链内物化：

```ts
use(app, cors({ origin: 'https://app.example', credentials: true }));
use(app, cors({ origin: ['https://a.example'], maxAge: 600, exposeHeaders: ['x-request-id'] }));
```

默认的 `'*'` origin 发出字面通配符；白名单与 resolver 反射请求 origin 并设置 `Vary: Origin`。浏览器拒绝带凭据的通配符 origin（fail-closed）—— 将 `credentials` 与显式 origin 配对。`exposeHeaders` 发出 `Access-Control-Expose-Headers`，让页面脚本能读自定义响应头。

**Logger** —— 每请求一行（`ISO-time METHOD path status duration`），通过可插拔的 `sink`/`format`。状态永远是真实状态 —— 回退**与错误响应**在链内物化，因此 logger 看到每个请求，包括 500。

**路由表** —— `数据 + 函数`的回报：应用是普通数据，因此无需执行任何内容即可导出为 JSON：

```ts
createRouteTable(app);
// { routes: [{ method: 'GET', pattern: '/users/:id', params: ['id'], middlewareCount: 1 }, …] }
```

便于路由清单或跨语言翻译 —— `s200/openapi` 从同一张表构建 OpenAPI 3.1 文档（见下）。

**OpenAPI** —— 路由表就是 API 面，因此 OpenAPI 3.1 文档直接出自它：`describeRoute` 标注（summary、tags、`SerializeSchema` DSL 的 query/body schema、响应形状），`openapiSpec` 发出 spec，未标注的路由仍以其参数和裸 200 出现：

```ts
describeApp(app, { title: 'Users API', version: '1.0.0' });
describeRoute(app, 'GET', '/users/:id', {
  summary: 'Fetch one user',
  responses: { 200: { description: 'ok',
    schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } } },
});
get(app, '/openapi.json', (ctx) => openapiJson(ctx, app));   // serve the spec
```

同一套标注可以变成运行时门：`withRouteValidation(app)` 是纯数据变换（mount 家族），只重建带 `body` 或 `query` 标注的路由，用 `s200/serialize` 的 `compileValidator` 检查请求 —— `serialize()` 的读取侧孪生，覆盖完全相同的 DSL 子集。违规以 `422` 应答并点名第一个出问题的路径（`{"error":"body.tags.1: expected string, got number"}`）；合法输入原样流过 —— 什么都不落到 `ctx.state`，什么都不强制转换（query 值保持字符串，因此 `?page=2` 对上 `{ type: 'integer' }` 是 422 —— 想要解析时用 `s200/query` 的 `queryParams`）。spec 与门共享一个来源：标注被重新挂到重建的路由上，因此 `openapiSpec(gated)` 继续记录它们。在 `mount` 之后于父应用上标注挂载的子应用（元数据注册表按路由身份寻址）。

为 spec 配上文档 UI —— `swaggerUi` 服务 Scalar API Reference 页面（资源从固定的 CDN 加载，因此 s200 保持零依赖）：

```ts
import { swaggerUi } from 's200/swagger';
get(app, '/docs', (ctx) => swaggerUi(ctx, { url: '/openapi.json', title: 'Users API' }));
```

**Cookies** —— 读写签名都是纯函数。写入会追加一个规范的 `Set-Cookie` 头（重复调用保持独立的头，绝不逗号拼接）；在响应存在后调用 —— 自然是 unwind 时、`await next()` 之后：

```ts
use(app, async (ctx, next) => {
  await next();
  setCookie(ctx, 'theme', 'dark', { httpOnly: true, sameSite: 'lax', maxAge: 86400 });
});
get(app, '/theme', async (ctx) => json(ctx, { theme: getCookie(ctx, 'theme') }));
await setSignedCookie(ctx, 'sid', userId, SECRET);       // + sid.sig HMAC partner
const sid = await getSignedCookie(ctx, 'sid', SECRET);   // undefined unless verified
```

**Sessions** —— `createSession({ secret, store? })` 返回一个中间件（外加 `close()` 用于默认 store 的清扫定时器）。客户端只持有不透明的已签名 id（HMAC 经 cookies 电池 —— 全框架一套签名约定）；数据住在服务端、可插拔的 `store` 里（`get`/`set`/`delete`，TTL 传给 `set` —— Redis `SET … EX` 形状；默认是进程内 map，惰性过期）。被篡改、缺失或过期的 id 看起来一模一样：一个全新的空 session，绝不是错误。变更（`set`/`delete`/`clear`/`touch`）持久化并在 unwind 时（重新）签发 cookie；`destroy()` 从 store 删除并使 cookie 过期；只读请求什么都不写：

```ts
const { middleware } = createSession({ secret: SECRET, cookie: { maxAge: 3600 } });
use(app, middleware);
get(app, '/', (ctx) => {
  const session = ctx.state.session as Session;
  session.set('user', 'alice');            // persisted + cookie issued on unwind
  return json(ctx, { visits: session.get('visits') });
});
```

**Config** —— 类型化、fail-fast 的配置，走 `s200/validate` 使用的同一条 Standard Schema 通道（nest 的 `@nestjs/config`，零依赖）：`parseEnv` 是纯 `.env` 解析器（注释、空行、`export ` 前缀、带转义的引号值、重复键后者胜；无多行值），`createConfig` 在构造时校验合并后的记录。校验失败抛出**一个**聚合所有问题的 `Error`，因此错误的部署在启动时死掉并带完整清单，而非第一个问题：

```ts
import { parseEnv, createConfig } from 's200/config';

const schema = { /* Standard Schema: input strings, output coerced */ };
const { valid } = createConfig(schema, { ...parseEnv(await readFile('.env', 'utf8')), ...process.env });
// valid: schema.types.output — fully typed from here on
```

环境值以字符串到达 —— 把 schema 的输入侧声明为字符串、在输出侧强制转换（input ≠ output 推断，同 `jsonBody`）。I/O 保持注入：`parseEnv` 接收文本，文件由你读取（核心绝不触碰文件系统）。

**Validate** —— 把你的解析函数（zod/valibot/typebox/手写 —— s200 保持零依赖，只调用它）包成门中间件；解析后的值落到 `ctx.state`：

```ts
post(app, '/articles', jsonBody(ArticleSchema.parse), (ctx) => {
  json(ctx, { saved: ctx.state.validated });
});
```

Standard Schema 值无需包装：任何带 `~standard` prop 的东西（zod、valibot、typebox、arktype…）都可以直接交给 `jsonBody`/`queryParams`。门在解析后的请求体/记录上调用 `validate()` —— 报告的第一个问题成为携带其消息的 `422 HttpError`；空的 `issues` 数组算成功。schema 的幻影 `types` prop 免费标注两侧：`types.input` 是调用方发送的东西（`jsonBody(schema)` 要求并标注客户端的 `init.body`，`queryParams(schema)` 以同样方式标注 `init.query` —— 都是输入侧，因此转换型 schema 端到端诚实），而解析后的 `types.output` 产物落到处理器的 `ctx.state.validated`；`standardValidate(schema, data)` 为你自己的门导出完全相同的 422 语义。

**Query** —— `validate` 的查询字符串孪生：`parseQuery(ctx)` 把查询变成纯记录（重复键收集为数组），`queryParams` 用 schema 把它包成门，`QueryOf<'page&tag'>` 在编译期类型化查询字符串字面量：

```ts
get(app, '/list', queryParams((q) => ({
  page: Number(q.page ?? 1),
  tags: q.tag ?? [],                    // repeated ?tag=a&tag=b → ['a','b']
})), (ctx) => json(ctx, ctx.state.validated));
```

**WebSocket** —— `upgradeWebSocket(app, pattern, handler)` 注册一条 ws 路由（路由器模式语法，先注册先得）；处理器得到一个 `send`/`close`/`onMessage`/`onClose`/`onError` socket 外加请求形状的 `ctx`（params/query/url）。Node 通过适配器的 `upgrade` 选项接线一个零依赖的 RFC 6455 服务器 —— 明文 `ws://`，或把 `upgrade` 与 `https` 配对得到 `wss://`（只有 `http2: true` 排除它）；Bun 通过桥接插入 `Bun.serve`：

```ts
import { upgradeWebSocket } from 's200/websocket';
import { createUpgradeHandler } from 's200/websocket/node';   // node
import { createBunWebSocketBridge } from 's200/websocket/bun'; // bun

upgradeWebSocket(app, '/chat/:room', (socket, ctx) => {
  socket.onMessage((data) => socket.send(`[${ctx.params.room}] ${data}`));
});

await serve(app, { port: 3000, upgrade: createUpgradeHandler(app) });            // node
serve(app, { port: 3000, websocket: createBunWebSocketBridge(app) });            // bun
```

node 服务器实现协议 —— 握手、文本/二进制（含分片）、ping/pong、关闭握手、`maxPayload` 预算（默认 64 MiB，超出为 1009）—— 外加可选的子协议协商与 permessage-deflate（RFC 7692，双向 no-context-takeover），以及心跳面（`socket.ping()` / `socket.onPong()`）：

```ts
upgradeWebSocket(app, '/graphql', (socket) => socket.onMessage(handle),
  { protocols: ['graphql-ws', 'graphql-transport-ws'], perMessageDeflate: true });
// socket.protocol carries the negotiated subprotocol; bun negotiates it too
```

**ETag** —— 在字节背书的响应上盖弱 SHA-1 实体标签，并以 304 应答 `If-None-Match` 命中。字节背书指显式的 `content-length` —— s200 的响应助手（`json`/`text`/`html`/`send`）会设置它，裸 `new Response('…')` 需要手动设置（平台惰性序列化 content-length）。分块/流式响应（SSE、`s200/streaming`）被跳过，不被缓冲：

```ts
use(app, etag());                    // W/"…" by default
use(app, etag({ strong: true }));    // "…"
```

**Secure headers** —— 安全默认基线，在 unwind 时盖上（回退响应 included）；处理器自己的头总是胜出，`false` 删除一个：

```ts
use(app, secureHeaders());  // nosniff, DENY framing, strict-origin-when-cross-origin
use(app, secureHeaders({ strictTransportSecurity: 'max-age=31536000' }));  // HSTS is opt-in
```

**Auth** —— `basicAuth`/`bearerAuth` 门：注入的 `verify` 函数决定，失败就地应答 `401` + `WWW-Authenticate`，其下的链永不运行：

```ts
use(app, basicAuth(async (user, pass) => user === 'admin' && (await check(pass))));
use(app, bearerAuth(async (token) => token === API_TOKEN));
```

**CSRF** —— 无会话同步器令牌：HMAC 签名（`nonce` + 过期时间），因此只有你的秘密能铸造一个，经 cookie 传递，在不安全请求上针对头/表单字段**与**请求 `Origin` 验证（堵住两个经典 double-submit 漏洞）。令牌住在 `ctx.state.csrfToken`；`csrf.token(ctx)` 把它回显到服务端渲染的表单中，不安全请求的缺失就地应答 `403`：

```ts
const csrf = createCsrf({ secret: CSRF_SECRET });   // keep the secret out of version control
use(app, csrf.middleware);
get(app, '/form', (ctx) => html(ctx, `<input type="hidden" name="_csrf" value="${await csrf.token(ctx)}">`));
```

**JWT** —— HS256/384/512、RS256/384/512、PS256/384/512 与 ES256/384/512，基于 WebCrypto，零依赖。`signJwt`/`verifyJwt` 接收密钥字符串、`CryptoKey` 或 JWK；验证无条件拒绝 `alg:none`，强制 `exp`/`nbf`，按请求检查 `aud`/`iss`，且密钥家族必须匹配头算法（HS 需要秘密，RS/PS 需要 RSA 密钥，ES 需要 EC 密钥 —— 混淆攻击被结构性封闭）。`jwtAuth` 是门，把 payload 存到 `ctx.state.jwt` 并在其下的链运行之前应答 `401`：

```ts
const token = await signJwt({ sub: userId }, JWT_SECRET, { expiresIn: 3600 });
use(app, jwtAuth({ secret: JWT_SECRET }));              // Authorization: Bearer …
get(app, '/me', (ctx) => json(ctx, ctx.state.jwt));

// Key rotation: a JWKS endpoint resolves keys by kid (cached, module-wide).
use(app, jwtAuth({ jwks: 'https://idp.example/.well-known/jwks.json' }));
// …or a custom resolver: jwtAuth({ keyResolver: (header) => … })
```

**Cache** —— 响应缓存，TTL + 类 LRU 淘汰与有界的请求体大小。默认安全：仅 GET/200，`Set-Cookie` 响应从不存储，`Authorization` 请求从不服务，`Cache-Control: no-cache` 强制放行：

```ts
use(app, cache({ ttl: 60, max: 1000 }));
use(app, cache({ store: redisCacheStore }));   // shared store across instances
```

默认 store 在进程内；自定义 `store`（在 `{ exp, status, headers, body }` 条目上的 `get`/`set`/`delete`）跨实例共享缓存 —— 过期仍由中间件每次读取时检查。

**Trust proxy** —— 从 `X-Forwarded-Proto`/`X-Forwarded-Host` 纠正 `ctx.url` 的协议/主机，并把客户端地址记录到 `ctx.state.proxy`，为 `X-Forwarded-For` 做跳数计数。在 `s200/csrf`、`s200/secure-headers` 以及任何构造绝对 URL 的东西之前注册：

```ts
use(app, trustProxy({ hops: 1 }));   // behind one trusted reverse proxy
```

**Accepts** —— RFC 9110 内容协商，覆盖 `Accept` / `Accept-Encoding` / `Accept-Language`：q 值、通配符、前缀范围，以及特定 q=0 压倒通配的优先级：

```ts
const want = accepts(ctx);
const type = want.type(['application/json', 'text/html']) ?? 'application/json';
```

**Rate limit** —— 每客户端键的真正滑动窗口门：每次命中在落地 `windowMs` 后过期（无固定边界，因此窗口边缘不能突发），超限请求就地以 `429` + `Retry-After` 应答，其下的链永不运行：

```ts
use(app, rateLimit({ windowMs: 60_000, limit: 100 }));
```

默认键读取 `x-forwarded-for` —— 只有在会覆写它的代理之后才有意义；其他身份传 `key: (ctx) => …`（测试可传 `now` 时钟）。计数器默认在进程内 —— 每实例限额。跨实例共享限额请注入 `store`（原子的 `hit(key, now, limit, windowMs) → { count, retryAt }` —— Redis INCR 形状）。

**Serialize** —— schema 驱动的 JSON 序列化：`serialize(schema)` 为 JSON-Schema 形状子集（对象、数组、原始类型、`nullable`）编译序列化器，`jsonRaw` 把结果作为带精确 `content-length` 的响应写入。回报是声明的形状而非裸速度 —— 输出恰好携带声明的键（未声明的被丢弃，因此内部字段永不泄漏），schema 在编译期驱动输入类型。现代引擎的 `JSON.stringify` 在典型负载上保持竞争力，因此当形状契约重要时用它，而不是当加速黑客：

```ts
const toUser = serialize({
  type: 'object',
  properties: { id: { type: 'integer' }, name: { type: 'string' } },
  required: ['id', 'name'] as const,   // as const: the array literal drives optionality
});
get(app, '/users/:id', (ctx) => jsonRaw(ctx, toUser({ id: 1, name: 'ada' })));
```

它是序列化形状，不是验证器：类型不匹配不检查，`NaN`/`Infinity` 序列化为 `null`（JSON 语义）。

**Compress** —— 通过 Web Standard `CompressionStream` 的 gzip/deflate 响应压缩（无 `node:zlib` —— 适用于 Node 18+、Bun、Deno），外加通过注入编码器的可选 brotli（`CompressionStream` 没有 brotli；`s200/node` 经 `node:zlib` 提供 `brotliCompress`）。协商 `Accept-Encoding` q 值，跳过无请求体/已编码/`no-transform` 响应与小请求体（当 content-length 已知时），并维护 `Vary: Accept-Encoding`：

```ts
use(app, compress({ minBytes: 1024 }));
import { brotliCompress } from 's200/node';
use(app, compress({ minBytes: 1024, brotli: { compress: brotliCompress } }));
```

Brotli 是缓冲路径 —— 只应用于字节背书的响应（声明的 content-length）；流式响应回退到 gzip/deflate。

**Streaming** —— `stream` 服务推送驱动的块；`streamSSE` 以感知背压的写入帧化 Server-Sent Events：

```ts
get(app, '/events', (ctx) => streamSSE(ctx, async (writer) => {
  await writer.writeSSE({ event: 'tick', data: { n } });
  await writer.heartbeat();
}));
```

**Request ID** —— 每请求的规范关联 id（`ctx.state.requestId`），尊重传入 id 并盖上响应 —— 错误响应 included：

```ts
use(app, requestId());          // x-request-id
use(app, requestId({ header: 'x-trace', generator: () => nanoid() }));
```

**Timeout** —— 让链与截止时间竞态；迟到的处理器得到 `503 {"error":"Request timeout"}`，且截止时间也会中止 `ctx.signal`，因此协作的工作（请求体读取、下游 fetch）停下来，而不是在后台跑完：

```ts
use(app, timeout(30_000));
```

**OTel** —— `s200/otel` 的 `trace()` 是兼容 OpenTelemetry 的 span 中间件，走鸭子类型 `Tracer`/`Span` 接口（零依赖 —— 用一个 lambda 桥接 `@opentelemetry/api`）。span 观察每个请求的真实状态 —— 处理器、404/405 回退、映射后的 500 一概不落 —— 因为响应在链内物化；拒绝被记录为异常并重新抛出：

```ts
import { trace } from 's200/otel';
use(app, trace({ tracer: myOtelTracerBridge, extract: (headers) => … }));
```

`metrics()` 是指标孪生 —— 鸭子类型 `Meter`（真的 `@opentelemetry/api` meter 用一个 lambda 桥接），报告 `http.server.requests`（计数器）、`http.server.active_requests`（`next()` 前 +1、`finally` 中 −1 —— 即使链抛出，仪表也平衡）以及 `http.server.request.duration`（直方图，毫秒）。记录携带 `http.request.method` 与 `http.response.status_code` —— 永远是物化后的状态，404/405/500 included，多亏链内错误边界。按 `status_code >= 500` 切片看错误；`attributes`（记录或 `(ctx)` 回调）展开在默认值之上，无选项的 `metrics()` 是裸透传：

```ts
use(app, metrics({ meter: myMeterBridge, attributes: (ctx) => ({ 'url.route': ctx.url.pathname }) }));
```

**Events** ——  [`@for-fun/event-emitter`](https://www.npmjs.com/package/@for-fun/event-emitter) 之上的类型化事件总线（唯一带依赖的电池；其余全部零依赖）。emitter 是普通数据 —— 一个 `Map` —— 每个能力都是其上的函数，因此总线是薄薄的类型化外观：声明一次事件映射，键、监听器参数与 emit 参数都被它收窄：

```ts
import { createBus } from 's200/events';

const bus = createBus<{ userCreated: [id: string]; orderPaid: [id: string, cents: number] }>();

const off = bus.on('userCreated', (id) => notify(id));   // id: string
bus.emit('userCreated', 'u_1');                          // sync: all listeners run now
await bus.emitAsync('orderPaid', 'o_9', 4200);           // awaits promise-returning listeners
off();                                                   // unsubscribe
```

**Schedule** —— cron 与 interval 任务，零依赖（`@nestjs/schedule` 等价物）：`nextRun(expr, from)` 是纯 5 字段 cron 匹配器（分 时 日 月 周 —— `*`、`*/n`、`a-b`、列表、`a-b/n`；无 `L`/`W`/昵称），`createScheduler()` 用绝对时间重武装来布置任务，因此漂移永不累积（超过 `setTimeout` 约 24.8 天上限的延时分段重武装）：

```ts
import { createScheduler } from 's200/schedule';

const scheduler = createScheduler({ onError: (err, expr) => log('error', { err, expr }) });
scheduler.interval(30_000, heartbeat);
scheduler.cron('*/5 * * * *', syncJobs);      // invalid expressions throw at registration
scheduler.start();
// stop(): cancels every timer and awaits in-flight runs — wire it into onShutdown
```

任务以并发 1 运行 —— 下一 tick 时仍在运行的任务被跳过，不排队。失败的任务走 `onError`（默认 `console.error`），绝不破坏循环。时钟可注入（`now`），`start()` 之前的注册一次性布置，第二次 `start()` 抛出。与 `s200/lifecycle` 配对：在 `onShutdown` 里 `stop()`，当 `s200/dev` 换表时重建调度器（任务也是数据）。

**Lifecycle** —— 信号驱动的优雅关闭（`enableShutdownHooks` + `onApplicationShutdown`，去掉 DI）：`lifecycle(server, options)` 把适配器的 `serve()` 结果变成编排的排空。顺序是滚动部署需要的那一个：先翻转就绪（负载均衡停止路由），然后停止监听，然后等待在途请求 —— 预算用尽时硬杀剩余 —— 只在那之后运行清理钩子：

```ts
import { serve } from 's200/node';
import { lifecycle } from 's200/lifecycle';
import { createGate } from 's200/health';

const gate = createGate();
get(app, '/health/ready', readiness({ db: pingDb, gate: gate.check }));

const server = await serve(app, { port: 3000 });
const done = lifecycle(server, {
  signals: ['SIGTERM', 'SIGINT'],   // default
  timeout: 10_000,                  // drain budget, default 10s
  readiness: gate,                  // closed ('draining') before anything else
  onShutdown: async () => { await db.close(); },
});
await done.stopped;                 // or call done.stop() yourself — same path, idempotent
```

运行时分派是鸭子类型的（模块保持运行时无关）：带 `closeIdleConnections` 的裸服务器走 node 路径 —— `close()` 停止接受，keep-alive 空闲 socket 被持续收割（活着的 `fetch` 客户端持有 socket；一次性收割会拖住排空直到截止时间），预算耗尽后才 `closeAllConnections()`。Bun 服务器经 `stop(false)`（优雅）/ `stop()`（强制）路由。排空期间的第二个信号立即硬杀。`onShutdown` 失败拒绝 `stop()` 但绝不拒绝 `stopped` —— 信号路径记录并解决。

**Health** —— 基于可注入检查的存活/就绪探针（Terminus，零依赖）。`HealthCheck` 是 `() => void | Promise<void>` —— 任何抛出或拒绝的都是不健康，消息即原因：

```ts
import { health, readiness, createGate } from 's200/health';

get(app, '/health/live', health());                        // 200 {"status":"ok"} — the process answers
get(app, '/health/ready', readiness({
  db: () => db.ping(),                                     // runs concurrently, each with its own budget
  cache: () => redis.ping(),
}));                                                       // 200 {"status":"ok","checks":{"db":"ok","cache":"ok"}}
```

任何失败的检查把响应变成 `503`，点名每个检查的结果（`{"status":"fail","checks":{"db":"connection refused"}}`）—— 健康的同伴仍报告 `"ok"`。每个检查与每检查预算（默认 1000ms；`timeout` 选项）**以及**请求的 `ctx.signal` 竞态，因此断开的探针客户端取消检查。`createGate()` 是生命周期接线的可组合开关：`gate.check` 在关闭时抛出（`gate.close('draining')` / `gate.open()`），因此就绪在关闭开始的瞬间翻为 false。

**Versioning** —— `apiVersion(options)` 是版本化门（NestJS 的头 / 媒体类型策略；URI 版本化就是 `mount(app, '/v1', …)`）。请求解析出一个版本 —— 来自头（默认 `x-api-version`）或来自 `application/vnd.<name>+json;version=1` 的 Accept 条目 —— 并在 `next()` 之前盖上 `ctx.state.version`：

```ts
import { apiVersion } from 's200/version';

use(app, apiVersion({ versions: ['1', '2'], default: '1' }));   // header strategy
use(app, apiVersion({ strategy: 'mediaType', mediaType: 'vnd.api', versions: ['1', '2'] }));
```

携带的版本在列表之外时，就地应答 `404 API version not supported: v9`（处理器永不运行）；缺失的版本回退到 `default`，没有 `default` 时应答 `404 API version required`。unwind 盖上 `Vary`（`x-api-version`，或媒体类型策略的 `Accept`），让缓存以版本为键。

**Testing** —— `s200/test` 无网络驱动应用：`request(app, '/users/1')` 是带完整回退语义的 `handle()`（hono 的 `app.request()` 形状）；`testClient(app)` 是 fetch 进程内路由的 `createClient`，保留类型化路径/参数/请求体；`probeApp(app)` 用合成参数分发每条已注册路由，报告 `{ method, pattern, status, ok }` —— 一个机械的"没有路由 500"契约测试：

```ts
import { request, testClient, probeApp } from 's200/test';
const res = await request(app, '/users/1');
const rows = await probeApp(app);        // [{ method: 'GET', pattern: '/users/:id', status: 200, ok: true }, …]
```

**Codegen** —— `s200/codegen` 的 `generateClient(app)` 从运行时路由表发出独立的 TypeScript 客户端模块（数据 + 函数中的数据）：每条路由一个类型化方法，带 `ParamsOf<'…'>` 参数、自包含的路径填充/查询助手、内建方法 —— 轻依赖（只有一个类型-only 的 `ParamsOf` 导入）。响应体保持 `Response`（运行时数据不带请求体类型 —— 有编译期类型时用 `s200/client`）；用于不给任何栈的消费者一个类型化调用者而不必随附 s200：

```ts
import { generateClient } from 's200/codegen';
const source = generateClient(app, { baseUrl: 'https://api.example' });  // → .ts file content
```

**Dev / 热重载** —— `s200/dev`（node）把快照不可变路由表变成零停机重载：`createHotApp(app)` 用稳定身份包装你的应用，`reload(nextApp)` 原子地换掉整张表（路由、中间件、错误策略、匹配器）—— 在途请求在旧链上完成，新请求命中新表，分发缓存按数组身份失效，绝不过期。`importFresh(specifier)` 绕过 ESM 缓存重新导入模块（带查询后缀的文件 URL），`watchAndReload({ dirs, load, hot })` 把 `fs.watch` + 防抖接上它；失败的 `load` 保留旧表并通过 `onError` 报告：

```ts
import { createHotApp, importFresh, watchAndReload } from 's200/dev';
import { serve } from 's200/node';

const hot = createHotApp(await buildApp());            // your (async) app builder
await serve(hot.app, { port: 3000 });                  // holds the stable identity
watchAndReload({
  dirs: ['src'],
  load: async () => (await importFresh('./src/app.ts') as { app: App }).app,
  hot,
});
```

**Client** —— 从应用自身路由表派生的类型安全 fetch 客户端：路径限制为已注册的模式字面量，参数由它们类型化（`:id` 必填、`:id?` 可选、`*path` 保持斜杠连接），`query` 选项构造搜索串。`ALL` 路由在每个方法下提供；畸形调用（未知模式、缺失参数）同步抛出：

```ts
const app = createApp();
const a = use(app, logger);
const b = get(a, '/users/:id', (ctx) => json(ctx, { id: ctx.params.id }));
const api = post(b, '/users/:id?', () => new Response('ok'));

const client = createClient(api, { baseUrl: 'http://localhost:3000' });
const res = await client.get('/users/:id', { id: '42' }, { query: { expand: 'posts' } });
const body = await res.json();                 // typed: { id: string }
await client.post('/users/:id?', {});          // id optional — absent is allowed
```

客户端说纯 `fetch` —— 任何说同种模式的服务器都应答，不只是 s200 应用。类型化源自注册器的返回类型，因此**串联返回值**（如上）以保留路由日志；`usePlugin` 注册的路由与 `removeRoute` 擦除是文档化的例外。处理器返回 `json(ctx, data)` 时响应体是类型化的 —— 品牌返回把请求体形状带进路由日志，`client.get(...).json()` 解析它（纯 `Response` 处理器为 `unknown`）。

输入类型流自门中间件：`jsonBody(parse)` 用解析函数的返回类型给路由加品牌，`queryParams((q: Q) => …)` 用回调的注解参数加品牌 —— 客户端随后要求它们：

```ts
post(app, '/articles', jsonBody(parseArticle), (ctx) => json(ctx, ctx.state.validated));
get(app, '/list', queryParams((q: { page?: string }) => …), handler);

await client.post('/articles', {}, { body: { title: 'hi' } });  // body typed: parseArticle's return
client.get('/list', {}, { query: { page: '2' } });              // query typed: { page?: string }
```

纯对象 `body` 被 JSON 序列化并盖上 `content-type: application/json`（除非已设置）；字符串/流/类型化数组请求体原样通过。无门品牌的路由保留宽松的 `ClientInit`。Schema 风味的门携带 schema 的**输入**类型（`types.input`），因此转换型 schema —— 解析日期字符串、默认字段、收窄联合 —— 类型化的是调用方发送的，而非处理器接收的：input ≠ output 推断端到端成立。

错误分支来自两个通道。主通道是推断：从处理器**返回** `httpError(...)`，其状态与请求体形状落入路由日志 —— 无需声明（返回 `HttpError` 是抛它的糖：它流经同一个链内错误边界，`onError` included，中间件在 unwind 时看到盖好的响应）。第二通道是 `throws` 门，用于调用栈深处的辅助函数可能产生的分支 —— 类型层声明，运行时纯透传：

```ts
import { httpError, throws } from 's200';

get(app, '/users/:id', throws(401), (ctx) => {
  const user = findUser(ctx.params.id);
  return user ?? httpError(404, 'no such user');   // 404 branch inferred from the return
});

const res = await client.get('/users/:id', { id: '7' });
// res.status: 200 | 401 | 404
if (res.status === 404) {
  const body = await res.json();   // { error: string } — narrowed by the status
}
```

`httpError(404, 'msg')`（无请求体）推断默认 `{ error: string }` 信封；`httpError(422, 'msg', { issues: [...] })` 推断负载形状。`throws(401, 404)` 声明信封分支；`throws({ 422: { issues: string[] } })` 声明结构化分支。门与返回合并，同一状态的两处声明并集其请求体。响应是**状态判别联合**：收窄 `res.status` 即收窄 `res.json()`。尚未做到：处理器体内 `throw httpError(...)` 调用点对类型层不可见（TypeScript 无法检视函数体）—— 返回它们，或用 `throws` 声明；且检查器不验证 `throws` 门与处理器实际产生的内容是否一致。

响应器为其携带的状态字面量加品牌：`json(ctx, user)` 加 `200`，`json(ctx, err, { status: 404 })` 加 `404`，`redirect(ctx, '/new')` 加 `302`。客户端暴露两个通道 —— `res.status` 收窄到路由的状态字面量，`res.json()` 保持类型化请求体，跨处理器分支并集；纯 `Response` 处理器保持诚实（`status: number`，请求体 `unknown`），品牌穿过 `mount`：

```ts
get(app, '/users/:id', (ctx) => {
  const id = Number(ctx.params.id);
  return Number.isNaN(id)
    ? json(ctx, { code: 'no_user' }, { status: 404 })
    : json(ctx, { id, name: 'ada' });
});

const res = await client.get('/users/:id', { id: '7' });
// res.status: 200 | 404 — res.json() discriminates: 400-branch bodies narrow with the status
if (res.status === 404) { /* res.json() here: { code: string } */ }
```

抛出或返回的错误可以携带结构化负载：`httpError(404, 'no such user', { code: 'USER_NOT_FOUND' })` 带上错误的状态逐字渲染请求体；无请求体时响应保持 `{ error: message }` 信封。要在客户端上浮现抛出的分支，用 `throws` 门声明（见上文 Client 节）—— 或直接**返回**错误值，分支即被推断。无论哪种方式，状态与请求体形状都随路由日志进入 `res.status` 与 `res.json()`。
