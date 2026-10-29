# 错误

## 带标记的数据

错误是带标记的数据，结构化检查 —— 跨包边界没有 `instanceof` 链：

```ts
import { httpError, isHttpError } from 's200';

throw httpError(422, 'Invalid article');

const app = createApp({
  onError: (ctx, error) => {
    const status = isHttpError(error) ? error.status : 500;
    json(ctx, { error: String((error as { message?: string }).message) }, { status });
  },
});
```

第四个参数把响应头标记到错误上 —— 闸门的 `WWW-Authenticate` 质询、`Retry-After`、IETF `RateLimit-*` 字段。默认映射会把它合并进错误响应，因此拒绝可以流入错误边界（含 `onError`），而不必就地应答：

```ts
throw httpError(401, 'Unauthorized', { error: 'Unauthorized' }, {
  'www-authenticate': 'Basic realm="api"',
});
```

`Retry-After` 的取值遵循同一约定：`retryAfterSeconds(ms)` —— 剩余毫秒数向上取整，下限为 `1`（刚触发的闸门绝不应答 `0`）。`s200/rate-limit` 的 429 与 `s200/circuit-breaker` 的 503 的响应头都用它计算；给你自己的闸门也用它，让每个应答读的是同一座时钟：

```ts
throw httpError(503, 'Cooling down', { error: 'Cooling down' }, {
  'retry-after': String(retryAfterSeconds(cooldownLeftMs)),
});
```

第五个参数附带 `cause` —— 被包装的根源（502 之下的数据库错误、网关超时之下的上游故障）。它是诊断信息，绝不是 payload：`toErrorResponse` 不序列化它，客户端 body 与没有 cause 时完全一致。它原封不动地流入错误边界，你的 `onError` 在那里读到它（`error.cause`），日志 sink 呈现它：

```ts
const app = createApp({
  onError: (ctx, error) => {
    if (isHttpError(error)) {
      json(ctx, { error: error.message }, { status: error.status });
      report(error.cause); // the wrapped origin — off the client body
    }
  },
});
```

随之而来的一条规则翻转：不带 cause 的 `HttpError` 是刻意的客户端错误，保持不记录；携带 `cause` 的那个则是主动要求 —— 边界把它路由给 `logError`（默认 sink 在 `console.error` 行末追加 cause），同时仍以错误自身的状态码与 body 应答客户端。

错误模型就是四个函数加一条规则：`httpError(status, message?, body?, headers?, cause?)` 构建带标记的值（`status` 为 `[400, 599]` 内的整数，`body` 原样搭载、替代默认的 `{ "error": message }` 信封，`cause` 则搭载到日志 sink 一侧），`isHttpError(error)` 结构化检查标记，`toErrorResponse(error)` 把任何被抛出的值映射为 `Response` —— 与边界应用的映射相同，在链外就地应答错误时有用 —— 而 `retryAfterSeconds(ms)` 把剩余毫秒预算格式化为共享的 `Retry-After` 秒值。那条规则：**throw，不要手工返回** —— 被抛出的 `HttpError` 能到达 `onError` 并参与 unwind 盖章；你自己写的响应只是一个响应。

## 默认映射

未处理的 `HttpError` 渲染为 `{ status, body: { "error": message } }`；其他一切通过 `console.error` 记录并渲染为通用 500（绝不泄漏内部细节）。改为提供 `onError` 来拥有映射（和日志记录）—— 或只替换 sink，保留默认映射：

```ts
const app = createApp({ logError: (error) => log('error', { err: error }) });
```

## 边界在链内运行

路由链与 404/405 回退被包在内层错误边界里：被抛出的错误在 unwind 开始*之前*就被映射为响应 —— `HttpError` 的状态码与消息，否则是一个匿名的 500。这份契约换来的东西：

```ts
use(app, async (ctx, next) => {
  await next();
  // 这里 ctx.res 已存在，恒成立 —— 包括下方 handler 的 500。
  logger.info(`${ctx.req.method} ${ctx.url.pathname} → ${ctx.res?.status}`);
});
```

要彻底去掉 `?.`，`resOf(ctx)`（核心 barrel 导出）返回该响应，若在 `next()` 之前调用则抛出一个点名误用的普通 `Error` —— 而 `SettledCtx` 为只在 next() 之后运行的辅助函数提供类型（见 [`s200` 响应助手](/zh/api/respond#响应助手)）。

排在崩溃 handler 前面的中间件在 unwind 上观察到真实的错误响应：`logger` 记录它、`cors` 盖章它、`request-id` 命名它。这也是为什么 `onError` 是应用选项而不是事后 hook —— 它作为同一次物化的一部分在链内运行。路由链外崩溃的中间件（应用级 `use`）由外层边界捕获并经同一条路径映射。

`onError` 以不写作拒绝：若它返回时未物化响应，默认映射接管。用 respond 助手写（`json(ctx, …, { status })`），`content-length` 一并搭载；最外层中间件返回时 `ctx.res` 里的内容就是适配器发送的内容。

## gate 走 throw —— 因此 `onError` 握有它们的策略

每一个内置拒绝都走错误边界路径而非就地应答：`basicAuth`/`bearerAuth` throw 一个携带 `WWW-Authenticate` 质询的 401 `HttpError`，`jwtAuth` 一个 401，`rateLimit` 一个带 `Retry-After` 加 IETF `RateLimit-*` 字段的 429，`csrf` 一个 403，校验 gate 一个 400（坏 JSON）或 422（schema 问题），`timeout` 一个 503。实际后果：你的 `onError` 能看到 gate 拒绝，可以统一改写它们每一个 —— 换信封、翻译消息、产出一种一致的错误形状 —— 而无需逐个配置电池。默认映射已经合并每个 gate 的头部，因此什么都不做也依然应答协议正确的 401/429/503。

反向形态是刻意存在的：写响应后不调 `next()` 直接返回的中间件会短路（CORS 预检 204、缓存再验证）。它按设计绕过 `onError` —— 留给不是错误的应答。

## 用 `throws` 声明错误分支

`throws(401, 404)` 是零成本的直通中间件，为路由的错误通道打品牌：这些状态码成为路由声明的错误分支，于是 `s200/client` 的响应联合命名它们、`s200/openapi` 文档化它们、`s200/codegen` 把它们发射进生成的客户端。为生成的客户端与 spec 附示例 body —— 记录形式（值原样暂存，兼作形状示例）：

```ts
get(app, '/users/:id', throws({ 404: { error: 'no such user' } }), (ctx) => …);
```

声明一个分支是带牙齿的文档 —— 与产出它的 throw 配对（handler 里的 `httpError(404, …)`，或链上的一个 gate）。

## 校验的 422 形状

校验 gate（`jsonBody`、`queryParams`，以及 `s200/openapi` 的 `withRouteValidation`）经 `validationError(scope, issues)` 拒绝 —— 一份一致的 body：

```json
{
  "error": "body.items.2.name: expected string, got number",
  "issues": [{ "path": "body.items.2.name", "message": "expected string, got number" }]
}
```

`error` 保留首个 issue 的摘要（gate 命名请求位置时带位置限定），`issues` 携带带格式化路径的完整列表。成功 body 里任何地方都没有 `issues` 键。在测试校验配置时两个键都断言 —— 完整列表才是意义所在。

## 客户端收窄

在消费者一侧，联合类型就是契约：`res.status` 收窄 `res.json()` 的类型。有了声明的分支 ——

```ts
const client = createClient(app);
const res = await client.get('/users/:id', { id: '7' });
if (res.status === 404) {
  const body = res.json(); // 类型化为声明的 404 body
}
```

—— 与你的测试对 `request()` 响应做的 `res.status` 判别是同一回事。未声明的路由应答 `unknown` body；`throws` 是让客户端的错误处理与快乐路径同等类型化的手段。
