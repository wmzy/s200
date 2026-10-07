# 中间件（onion）

中间件是 `async (ctx, next)`，具有 koa 语义 —— `await next()` 之后的代码在 unwind 时运行，异常向外传播，第一次调用未 settle 前的第二次 `next()` 调用会拒绝。

```ts
use(app, async (ctx, next) => {
  const start = performance.now();
  await next();
  ctx.state.duration = performance.now() - start;
  ctx.res?.headers.set('x-duration', String(ctx.state.duration));
});
```

`ctx.state` 是每个请求全新的可变袋子 —— 中间件与处理器之间的类型化传递通道。通过声明合并（koa 的 `DefaultState` 技巧）按应用扩展其类型：

```ts
declare module 's200' {
  interface State { user: User }
}
```

不能共享一个全局形状的应用改为向 `createApp` 传入每应用接口 —— 此时 `ctx.state` 在该应用的中间件、处理器和错误策略中都是该接口，无需模块合并（定义为 `interface`）：

```ts
interface AdminState extends State {
  user: User;
}
const app = createApp<AdminState>({
  onError: (ctx, error) => { /* ctx.state.user: User */ },
});
use(app, (ctx, next) => { ctx.state.user; return next(); });
get(app, '/me', (ctx) => json(ctx, ctx.state.user));
```

`ctx.url` 是已解析的请求 URL（复用它 —— 无需重复解析）。`ctx.signal` 是请求的协作取消 `AbortSignal`。在 node 适配器中，客户端请求中途断开时它会中止（Deno/Cloudflare 自动传递平台的断开信号），`timeout` 在截止时间中止它，长时间运行的工作应与之竞态（请求体读取器就是这样做的）。想要极限吞吐的应用可以传 `abortOnDisconnect: false` —— 共享一个永不中止的信号，没有每请求的 `AbortController`，在最小 hello-path 应用上值得大约 8%。中间件可以在进入时交换信号（`AbortSignal.any([...])`），并在 unwind 时恢复。`await next()` settle 之后，`ctx.res` 总是已物化 —— 处理器的响应、404/405/500 回退、**或错误响应**：链内的错误边界在 unwind 之前映射抛出的错误，因此中间件能观察（并可覆盖）真实响应，即使 500 也一样。这正是 logger/CORS/request-id 能盖上错误响应的原因。

路由也接受作用域中间件：模式与终结处理器之间可以放任意多个。它们在应用级链之后运行（并在其内部 unwind），只为自己的路由服务：

```ts
const requireAuth = (ctx: Ctx, next: Next) => {
  if (ctx.state.user === undefined) throw httpError(401, 'Login required');
  return next();
};

get(app, '/admin', requireAuth, (ctx) => json(ctx, { ok: true }));
```

不调用 `next()` 会跳过其下的一切 —— 包括处理器 —— 因此就地应答或提前抛出的门永远到不了处理器（koa 短路语义）。

中间件也按前缀作用域 —— 该组只在其下的请求中运行（段边界感知：`/admin` 匹配 `/admin` 和 `/admin/…`，不匹配 `/administrator`），像普通中间件一样按注册顺序嵌套：

```ts
use(app, '/admin', requireAuth, async (ctx, next) => {
  ctx.state.zone = 'admin';
  await next();
});
use(app, '/users/:id', loadUser);   // param prefixes use the router's own matching
```
