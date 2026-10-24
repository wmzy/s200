# 从 Fastify 迁移到 s200

Fastify 与 s200 在要紧的事情上观点一致：路由表、作用域中间件、入口处校验、处处 JSON。差别在基座——Fastify 是带生命周期 hook 与 plugin 封装作用的实例；s200 是配顶层函数的普通数据，而每个 hook 都映射为两种中间件形态之一。

## 机械对照表

| Fastify | s200 |
|---|---|
| `fastify()` | `createApp()` |
| `app.get('/users/:id', handler)` | `get(app, '/users/:id', handler)` |
| `app.post` / `put` / `patch` / `delete` / `head` / `options` | `post` / `put` / `patch` / `del` / `head` / `options` 注册器 |
| `app.addHook('onRequest', fn)` | `use(app, fn)` —— 在 `await next()` 之前做事 |
| `app.addHook('preValidation', fn)` | 一个中间件 —— 参数已解码；校验是你自己的 gate 的职责 |
| `app.addHook('preHandler', fn)` | 路由作用域中间件：`get(app, path, mw, handler)` |
| `app.addHook('onSend', fn)` | unwind 上的盖章器 —— `await next()` 之后改写头部 |
| `app.addHook('onError', fn)` / `app.setErrorHandler(fn)` | `createApp({ onError })` |
| `app.setNotFoundHandler(fn)` | `createApp({ onNotFound })` |
| `app.register(plugin, { prefix: '/v1' })` | `mount(app, '/v1', subApp)` —— 快照语义（见下） |
| `app.decorate('db', db)` | `createApp<{ db: Db }>()` + `ctx.state.db`，或 `withState` |
| 路由 `schema: { body, response }` | 进向 `jsonBody(schema)` gate，出向 `serialize(schema)` |
| `reply.code(201).headers(h).send(body)` | `json(ctx, body, { status: 201, headers: h })` |
| `reply.status(204).send()` | `send(ctx, null, { status: 204 })` —— 不背书 content-length |
| `request.body` / `request.query` | `await readJson(ctx)` / `ctx.query` |
| `request.params` | `ctx.params.id`（由模式字面量类型化） |
| `app.inject({ method, url })`（测试） | `s200/test` 的 `request(app, url, { method })` |
| `app.listen({ port: 3000 })` | `s200/node` 的 `serve(app, { port: 3000 })` |
| `app.addHook('onClose', fn)` | `s200/lifecycle` 的 `lifecycle(server, { onShutdown: fn })` |
| `app.ready()` / 启动顺序 | 不需要 —— 注册就是同步的数据 |

### `@fastify/*` 插件 → s200 电池

| Fastify 插件 | s200 |
|---|---|
| `@fastify/cors` | `s200/cors` 的 `cors()` |
| `@fastify/helmet` | `s200/secure-headers` 的 `secureHeaders()` |
| `@fastify/jwt` | `s200/jwt` —— `signJwt` / `jwtAuth`（路由作用域 gate） |
| `@fastify/cookie` | `s200/cookies` —— `getCookie` / `setCookie` |
| `@fastify/session` | `s200/session` —— `createSession` |
| `@fastify/rate-limit` | `s200/rate-limit` —— `rateLimit`（滑动窗口） |
| `@fastify/formbody` | `readForm(ctx)` —— urlencoded **与** multipart，一次调用 |
| `@fastify/multipart` | `s200/multipart` 的 `streamForm`，或 `s200/upload` 的 `uploadForm` |
| `@fastify/static` | （核心 barrel 的）`serveStatic`，架在适配器注入的读取器上 |
| `@fastify/swagger` | `s200/openapi`（由活路由表出 spec）+ `s200/swagger`（Scalar UI） |
| `@fastify/under-pressure` | `s200/health` —— `readiness({ db: ping })` + `createGate()` |

## s200 的架构差异

1. **plugin 是数据变换，不是作用域。** Fastify 的 `register` 构建一个封装的子上下文：内部添加的 hook 与 decorator 不外泄，且子上下文保持存活——`registerPlugin` resolve 之后再注册的路由照样服务。`mount(app, '/v1', sub)` 是一份**快照**：调用时复制子应用的路由与中间件、绝不改动子应用，mount 之后在 `sub` 上的注册对挂载点不可见。子应用的 `onError` 会按挂载路由逐条携带；它的 `onNotFound` 与自定义 `match` 无法迁移（父应用分发挂载路由），并在每次 `mount` 时用一条 `console.warn` 明示丢弃。如果你需要"晚注册"模式，就在子应用全部注册完后再 mount，或每个版本挂一个新子应用。

2. **hook 塌缩成一种形态。** Fastify 把请求生命周期摊在具名 hook 上；s200 恰有两种中间件形态——`await next()` 之前做事（onRequest/preValidation/preHandler 领地）与之后做事（onSend/onResponse 领地）。没有 preParsing hook，因为没有急切读体：体在 handler 里读（`readJson`、`readForm`），先对照限额计数、*之后*才缓冲。而 unwind 恒能看到真实响应——见下一条。

3. **错误契约在链内运行。** Fastify 的 `setErrorHandler`（及其 hook）在路由链 unwind 之后跑——中间件观察不到自己产出的 500。s200 把路由链与回退包进内层错误边界：错误响应在 unwind 开始*之前*就已物化，所以 `await next()` resolve 即意味着 `ctx.res` 存在，500 也包括——logger/CORS/request-id 盖章的是真实的错误响应。gate 拒绝（`jwtAuth` 401、带 `Retry-After` + IETF `RateLimit-*` 的 `rateLimit` 429）走同一条路，因此 `onError` 对它们同样握有策略权。

4. **校验与序列化是分离的、显式的 gate。** Fastify 每路由编译一份 JSON Schema——`schema.body` 守入口，`schema.response` 塑出口。s200 把两个方向拆开：入口经 gate（`s200/validate` 的 `jsonBody` —— 手写 parse 函数、任意 Standard Schema 库、或 `s200/openapi` 的 JSON-Schema DSL；解析值落在 `ctx.state.validated`），出口经 `s200/serialize` 的 `serialize` —— schema 化的序列化器，只发射声明的键并带精确 `content-length`。朴素的 `json(ctx, …)` 仍是诚实的默认；没有任何隐式机制改写你的负载。方法未命中应答 RFC 9110 的 `405` + `Allow`（Fastify 答 404）。

5. **`decorate` 变成 state，三种粒度。** 实例级装饰映射为 `createApp<{ db: Db }>()`（每应用形状）或朴素的模块级导入——连接池只是一个值。每请求装饰映射为经 `withState(async (ctx, next) => { ctx.state.user = …; await next(); })` 的 `ctx.state`，它为下游一切*类型化*该槽位，无全局合并。Reply 装饰不再必要——respond 助手直接收 `{ status, headers }`。

## 常见模式

**带 schema 的路由 —— Fastify：**

```ts
app.post('/users', {
  schema: {
    body: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    response: { 201: { type: 'object', properties: { id: { type: 'integer' } } } },
  },
}, async (request, reply) => {
  const user = await db.create(request.body);
  reply.code(201).send({ id: user.id });
});
```

**同一路由在 s200 —— 两个方向是两个显式 gate：**

```ts
import { createApp, get, httpError, json, post, send } from 's200';
import { jsonBody } from 's200/validate';
import { jsonRaw, serialize } from 's200/serialize';

const userOut = serialize({
  type: 'object',
  properties: { id: { type: 'integer' }, name: { type: 'string' } },
  required: ['id', 'name'],
});

post(
  app,
  '/users',
  jsonBody((data) => {
    if (typeof data !== 'object' || typeof (data as { name?: unknown }).name !== 'string') {
      throw httpError(422, 'name must be a string');
    }
    return data as { name: string };
  }),
  async (ctx) => {
    const user = await db.create(ctx.state.validated as { name: string });
    return jsonRaw(ctx, userOut(user), { status: 201 });
  },
);
```

**auth plugin → 路由作用域 gate：**

```ts
import { jwtAuth } from 's200/jwt';

// fastify: app.register(jwt, { secret }) + app.addHook('onRequest', app.jwtAuth)
get(app, '/me', jwtAuth({ secret }), (ctx) => json(ctx, ctx.state.jwt));
```

**`onSend` 改写头部 → unwind 盖章器：**

```ts
use(app, async (ctx, next) => {
  await next();                 // 这里 ctx.res 保证已存在 —— 500 也包括
  ctx.res.headers.set('x-request-id', ctx.state.requestId ?? '');
});
```

**`setErrorHandler`/`setNotFoundHandler`：**

```ts
const app = createApp({
  onError: (ctx, error) => {
    const status = isHttpError(error) ? error.status : 500;
    json(ctx, { error: String((error as { message?: string }).message) }, { status });
  },
  onNotFound: (ctx) => json(ctx, { error: 'no such route' }, { status: 404 }),
});
```

## 注意事项

- **没有 `reply.raw` / `reply.hijack()`** —— 响应是 Web 标准 `Response`。要完全掌控就直接返回一个，流式 body 用 `s200/streaming` 的 `stream()` / `streamSSE()`。
- **`onResponse`（socket 刷盘之后）不是核心 hook** —— unwind 盖章器在 `next()` settle 时看到的是已物化的响应，足以覆盖日志需求；严格意义上的发送后动作属于适配器层。
- **`request.body` 没有急切等价物** —— handler 里 `await readJson(ctx)`/`readForm(ctx)`；解析按请求上下文缓存，多次读取从同一缓冲回放。
- **`app.log`（Pino）不是内置的** —— 自带 logger 注入进来，或用 `logger()` 电池的 `sink`/`format` 接缝。
- **`content-length` 由 respond 助手显式设置**（平台惰性序列化）—— HEAD 保留本应有的尺寸，`etag`/`compress` 以该信号为键。裸 `new Response('…')` 不带长度；`send()`/`json()` 带。
- **类型提供器（fastify 的 `TypeBox` 泛型）** 映射为 s200 的字面量模式推断——`ctx.params` 直接由 `'/users/:id'` 类型化，`throws(404)` 为 `s200/client` 的响应联合类型化错误分支。
