# 从 Koa 迁移到 s200

s200 就是你熟悉的那套 koa 模型——洋葱模型中间件、`ctx.state`、可变的
`ctx.res`——并自带了 koa 留给生态去做的路由、body 解析与回退。

## 机械对照表

| Koa | s200 |
|---|---|
| `new Koa()` | `createApp()` |
| `app.use(async (ctx, next) => …)` | `use(app, async (ctx, next) => …)` |
| `koa-router`：`router.get('/users/:id', h)` | `get(app, '/users/:id', h)` |
| `router.use('/api', sub.routes())` | `mount(app, '/api', subApp)` |
| `app.use(router.routes())` | 路由直接注册在应用上 |
| `ctx.body = data` | `json(ctx, data)` / `text(ctx, …)` / `return new Response(...)` |
| `ctx.status = 201` | `json(ctx, data, { status: 201 })` |
| `ctx.redirect('/login')` | `redirect(ctx, '/login')` |
| `ctx.throw(400, 'bad')` | `throw httpError(400, 'bad')` |
| `ctx.request.body`（koa-body） | `await readJson(ctx)` / `readForm(ctx)` |
| `ctx.params.id` | `ctx.params.id`（类型由模式字面量推导） |
| `ctx.query` | `ctx.query`（`URLSearchParams`）或 `parseQuery(ctx)` |
| `ctx.state` | `ctx.state` —— 同一个容器，同样的声明合并技巧 |
| `app.on('error', fn)` | `createApp({ onError: (ctx, error) => … })` |
| `koa-static` | `serveStatic({ read, stat, readRange })` |
| `@koa/cors` | `cors()` |
| `koa-logger` | `logger()` |

## 原样保留的部分

- **洋葱模型语义** —— `compose` 是 koa-compose 的忠实移植：下行按注册顺序、回卷按相反顺序，二次 `next()` 会被拒绝。
- **`ctx.state`** —— 每个请求全新，可通过 `declare module 's200' { interface State … }`
  扩展。s200 另有按应用的替代方案：`createApp<MyState>()` 只为该应用把
  `ctx.state` 定型为 `MyState`（无需全局合并）。
- **不调用 `next()` 即短路** —— 提前应答或提前抛出的门不会到达处理器。

## 差异所在

1. **koa 的 404 是状态码，s200 的 404 是响应。** koa 把 `ctx.status` 初始化为 404，
   让无 body 的响应顺流落入 `respond()`。s200 在链内物化真实的 404 响应，回卷的
   中间件能观察并盖章——含 CORS 头与 logger 状态码。405（带 `Allow` 头）与 500 同理。

2. **错误永不逃逸到 `app.on('error')`。** 错误边界位于链内：抛错的处理器渲染出一个
   中间件在回卷时能看到的响应。`onError` 取代 koa 的 `ctx.onerror` + error 事件组合。

3. **`ctx.body` 赋值不复存在。** 响应是值：用辅助函数（`json`/`text`/`html`/`send`）
   写入 `ctx.res`，或从处理器返回一个 `Response`。什么都不写也什么都不返回的
   处理器得到 500 —— koa 的隐式空 body 404 不会复现。

4. **处理器可以返回一个 `Response`** —— 没有其他写入先行时，它被采纳为
   `ctx.res`。这就是 s200 版的 `return ctx.body = …`。

5. **尾斜杠严格性。** Koa + koa-router 两种形式都容忍；s200 默认严格，并提供 `createApp({ strict: false })`。

6. **`ctx.throw` 式错误把状态码装进同一个值。** `httpError(422, 'msg')` 是带标签
   的数据（`isHttpError` 按结构检查——跨 bundle 边界不需要 `instanceof`）。

## 常见模式

**计时中间件（koa-logger 风格）：**

```ts
use(app, async (ctx, next) => {
  const start = performance.now();
  await next();
  ctx.res?.headers.set('x-duration', String(performance.now() - start));
});
```

**类型化 state：**

```ts
interface MyState extends State {
  user?: User;
}
const app = createApp<MyState>();
use(app, async (ctx, next) => {
  ctx.state.user = await loadUser(ctx);
  return next();
});
```

**带日志的错误映射：**

```ts
const app = createApp({
  onError: (ctx, error) => {
    const status = isHttpError(error) ? error.status : 500;
    json(ctx, { error: String((error as { message?: string }).message) }, { status });
  },
});
```

## 注意事项

- **没有 `app.listen`。** 服务是适配器的职责：用 `s200/node` 或 `s200/bun` 的
  `serve(app, { port: 3000 })`。对任何 fetch 形态的运行时，
  `handle(app, request)` 就是全部运行时契约。

- **`ctx.req` 是 Web 标准 `Request`** —— 请求头是 `Headers`，URL 是 `ctx.url`
  （只解析一次，直接复用）。

- **子应用的中间件在挂载时被复制。** 挂载是纯数据变换——子应用保持可复用、不被
  改动，但之后再往它上面加的中间件不会传播。改用父级中间件兜住晚加的内容。
