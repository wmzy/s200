# 从 Hono 迁移到 s200

s200 与 Hono 处于同一空间——Web 标准 `Request`/`Response`、多运行时、可选的 battery。
差别在形态：Hono 是带链式方法的类实例；s200 是配顶层函数的普通数据。

## 机械对照表

| Hono | s200 |
|---|---|
| `new Hono()` | `createApp()` |
| `app.use(mw)` | `use(app, mw)` |
| `app.use('/api/*', mw)` | 路由作用域中间件，或 `mount` |
| `app.get('/users/:id', h)` | `get(app, '/users/:id', h)` |
| `app.route('/v1', sub)` | `mount(app, '/v1', subApp)` |
| `app.onError(handler)` | `createApp({ onError })` |
| `app.notFound(handler)` | `createApp({ onNotFound })` |
| `c.json(data)` | `json(ctx, data)` |
| `c.json(data, 201)` | `json(ctx, data, { status: 201 })` |
| `c.text('hi')` / `c.html(...)` | `text(ctx, …)` / `html(ctx, …)` |
| `c.redirect('/login')` | `redirect(ctx, '/login')` |
| `c.req.param('id')` | `ctx.params.id`（类型由模式字面量推导） |
| `c.req.query('page')` | `ctx.query.get('page')` / `parseQuery(ctx)` |
| `c.req.json()` | `await readJson(ctx)` |
| `hono/body-limit` | `readJson(ctx, { limit })` —— 在缓冲前计数 |
| `hono/cors` | `cors()` |
| `hono/logger` | `logger()` |
| `hono/compress` | `compress()`（CompressionStream——不支持 brotli） |
| `hono/etag` | `etag()` |
| `hono/secure-headers` | `secureHeaders()` |
| `hono/timeout` | `timeout(ms)` |
| `app.request('/x')`（测试） | `handle(app, new Request('http://localhost/x'))` |
| `new Hono()` + 各适配器的 `serve` | 核心包 + `s200/node` / `s200/bun` 的 `serve(app)` |

## s200 的架构差异

1. **错误契约。** Hono 的 `onError` 在中间件链之外运行——中间件看不到 `onError`
   写下的 500。s200 在链内物化错误响应（一个内层错误边界），logger/CORS/request-id
   因此能在回卷时盖章。404/405 回退同理——Hono 用单独的 `notFound` 接线处理。

2. **方法未命中是 405 + `Allow`。** Hono 默认把“路径命中但方法错误”答成 404；s200 给出 RFC 9110 的 405，并带上允许的方法。

3. **类型化 state。** Hono 的 `Context<Env>` 变量映射到 s200 的 `ctx.state`：可
   以全局扩展（`declare module 's200' { interface State … }`），也可按应用扩展
   （`createApp<MyState>()` —— 不做全局合并，两个应用可携带不同形态）。

4. **注册是作用于数据的函数。** 用 `get(app, …)` 取代 `app.get(…)`。回报是：应用
   成为可序列化的数据（`createRouteTable`），打包器摇掉每个未导入的能力（CI 的
   `verify:tree-shaking` + size 限制强制执行）。

5. **没有 `new Hono().basePath()`** —— 前缀挂载是 `mount(app, '/v1', subApp)`，
   一次纯数据变换。

6. **路由器。** 对纯动态表，Hono 的 RegExpRouter 更快；s200 的索引化 trie 以每个
   静态段为键（`/:tenant/resourceN` 仍会被索引）。实践中两者都低于 1µs —— 见 `pnpm bench`。

## 常见模式

**类型化参数——两个框架都从模式字面量推导：**

```ts
get(app, '/users/:id', (ctx) => json(ctx, { id: ctx.params.id }));
// ctx.params.id: string —— 推导得出
```

**校验（hono/zod-validator 风格）：**

```ts
post(app, '/articles', jsonBody(ArticleSchema.parse), (ctx) => {
  json(ctx, { saved: ctx.state.validated });
});
```

**流式 SSE：**

```ts
get(app, '/events', (ctx) => streamSSE(ctx, async (writer) => {
  await writer.writeSSE({ event: 'tick', data: { n } });
}));
```

## 注意事项

- **`c.env`/`c.var` 不是独立通道** —— 把运行时绑定放进 `ctx.state`，或用闭包捕获。

- **`c.req.header('x')` → `ctx.req.headers.get('x')`** —— 真正的 `Headers`、
  真正的 `Request`；没有包裹它们的辅助层。

- **没有 JSX/TSX 中间件，也没有 `hc` RPC 客户端** —— 那些仍是 Hono 的特性。
  对 RPC 形态的人体工学，s200 的答案是 `route-table` + 你自己的生成器。

- **content-length 由响应辅助函数显式设置**（平台惰性序列化）—— HEAD 响应保留本应具有的大小，`etag`/`compress` 依赖它。
