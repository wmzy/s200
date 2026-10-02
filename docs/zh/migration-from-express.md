# 从 Express 迁移到 s200

s200 保留了你熟悉的心智模型——路由、中间件、`req`/`res` 式处理——但每个
能力都是作用于普通数据的函数，而不是实例上的方法。

## 机械对照表

| Express 5 | s200 |
|---|---|
| `const app = express()` | `const app = createApp()` |
| `app.use(mw)` | `use(app, mw)` |
| `app.use('/api', router)` | `mount(app, '/api', subApp)` |
| `app.get('/users/:id', h)` | `get(app, '/users/:id', h)` |
| `app.get('/x', mw1, mw2, h)` | `get(app, '/x', mw1, mw2, h)` —— 形状相同 |
| `app.delete(...)` | `del(app, ...)` |
| `app.all(...)` | `all(app, ...)` |
| `res.json(data)` | `json(ctx, data)` |
| `res.send(text)` | `send(ctx, text)` |
| `res.status(201).json(d)` | `json(ctx, d, { status: 201 })` |
| `res.redirect(url)` | `redirect(ctx, url)` |
| `res.sendFile(p)` | `serveStatic({ read, stat, readRange })` 中间件 |
| `req.params.id` | `ctx.params.id`（类型由模式推导） |
| `req.query.page` | `ctx.query.get('page')` / `parseQuery(ctx)` |
| `req.body`（json） | `await readJson(ctx)` |
| `express.json({ limit })` | `readJson(ctx, { limit })` —— 在缓冲前计数 |
| `express.static('public')` | `serveStatic({ read: createFileReader('public'), ... })` |
| `app.use((err, req, res, next) => …)` | `createApp({ onError: (ctx, error) => … })` |
| `express-async-errors` | 不需要 —— 抛出的错误在链内被映射 |
| `res.set('x', 'y')` | `ctx.res?.headers.set('x', 'y')`，在回卷时执行 |

## 关键差异

1. **处理器收到的是一个 `ctx`，不是 `(req, res)`。** `ctx.req` 是真正的 Web 标准
   `Request`，`ctx.res` 是写入的 `Response`。Node 的流模型不复存在——你不能在
   处理器中途 `res.write()`；增量输出请用 `s200/streaming`（`stream`、`streamSSE`）。

2. **错误是值，不是回调链。** 在链中的任何位置——处理器、中间件、回退——
   `throw httpError(422, 'Invalid article')` 都会以该状态码渲染为
   `{ error: message }`。Express 5 也能捕获异步抛出，但其默认错误处理器
   输出 HTML，且中间件的错误签名是四参数的 `(err, req, res, next)`。

3. **404/405/500 回退在链内物化。** 回卷阶段运行的中间件（logger、cors）
   看得到并为真实响应盖章——不再需要 `res.on('finish')` 记账。

4. **方法未命中是 405 + `Allow`，不是 404**（RFC 9110）。`HEAD` 自动回退到
   `GET` 路由。

5. **尾斜杠默认严格。** `createApp({ strict: false })` 恢复 Express 式的
   容忍。

6. **body 解析按需启用且有预算。** 没有全局的 `express.json()` 注册；每个
   `readJson`/`readText`/`readForm` 接受自己的 `limit`，在字节到达时执行（超限
   的负载永远不会滞留在内存里）。重复读取从每请求缓存重放。

7. **没有 `res.locals`。** 交接通道是 `ctx.state` —— 每个请求全新的类型化容器。
   按应用扩展它：

   ```ts
   interface MyState extends State {
     user?: User;
   }
   const app = createApp<MyState>();
   use(app, (ctx, next) => {
     ctx.state.user = await loadUser(ctx);
     return next();
   });
   get(app, '/me', (ctx) => json(ctx, { name: ctx.state.user?.name }));
   ```

## 常见模式

**请求日志（morgan 风格）：**

```ts
use(app, logger());
// ISO 时间 METHOD path 状态码 时长
```

**CORS：**

```ts
use(app, cors({ origin: 'https://app.example', credentials: true }));
```

**body 校验（类似 zod-express）：**

```ts
post(app, '/articles', jsonBody(ArticleSchema.parse), (ctx) => {
  json(ctx, { saved: ctx.state.validated });
});
```

**带共享中间件的路由组（类似 `Router.use`）：**

```ts
const api = createApp();
use(api, bearerAuth(async (token) => token === API_TOKEN));
get(api, '/users', listUsers);
const app = createApp();
mount(app, '/api', api);   // api 的中间件在挂载后的路由上变为路由作用域
```

**带缓存的静态文件：**

```ts
use(app, serveStatic({
  read: createFileReader('public'),
  stat: createFileStat('public'),          // ETag/Last-Modified + 304
  readRange: createFileRangeReader('public'), // 流式 range 响应
  root: 'public',
  cacheControl: 'public, max-age=3600',
}));
```

## 注意事项

- **没有 `app.listen`。** 服务是适配器的职责：用 `s200/node`（或
  `s200/bun`）的 `serve(app, { port: 3000 })`。

- **中间件绝不调用 `res.end()`。** 写入 `ctx.res` 就是让响应存在的方式；
  从处理器返回一个 `Response` 同样可行。什么都不写的链得到 500
  `"No response written"`（未匹配且未写入的请求得到 404）。

- **`ctx.req.headers` 是 `Headers` 对象**，不是普通对象——用 `.get('x')`，
  不是 `['x']`。

- **Cookie 随响应走** —— 在回卷阶段设置：`await next()` 之后调用
  `setCookie(ctx, …)`。
