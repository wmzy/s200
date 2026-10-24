# 中间件（onion）

## 形态

中间件是 `async (ctx, next)`，具有 koa 语义 —— `await next()` 之后的代码在 unwind 时运行，异常向外传播，第一次调用未 settle 前的第二次 `next()` 调用会拒绝。

```ts
use(app, async (ctx, next) => {
  const start = performance.now();
  await next();
  ctx.state.duration = performance.now() - start;
  setHeader(ctx, 'x-duration', String(ctx.state.duration));
});
```

## 每请求状态

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

### 推断式注入：`withState`

第三条路：*写入* state 的中间件可以用 `withState` 声明自己写入了什么，`use` 会把该品牌收集进应用类型 —— 下游中间件与处理器读到的是类型化后的键，既不需要全局合并、也不需要手写接口。这是 Hono `c.var`/`Env` 与 Elysia `derive` 的对应物：

```ts
import { withState } from 's200';

const withUser = withState<{ user: User }>(async (ctx, next) => {
  ctx.state.user = await loadUser(ctx); // 注入器内可写 X 的键
  await next();
});

const app2 = use(app, withUser);        // App<State & { user: User }>
get(app2, '/me', (ctx) => json(ctx, ctx.state.user)); // User，已类型化
```

注入沿 `use` 调用与实参按交集累积；注入器也可以消费更早的注入 —— 第二个类型参数声明它读取什么，`use` 在编译期强制这个顺序：

```ts
const withProfile = withState<{ profile: Profile }, { user: User }>(async (ctx, next) => {
  ctx.state.profile = await loadProfile(ctx.state.user); // 读取 { user }
  await next();
});
use(use(app, withUser), withProfile); // ok
use(app, withProfile);                // 类型错误 —— { user } 尚未注入
```

三条边界，均为刻意设计：

- **应用级，非路由级。** 前缀限定形式（`use(app, '/api', withUser)`）同样传递类型，但无法把类型收窄到前缀下的路由 —— 前缀之外的处理器仍会看到类型化后的键、运行时却是 `undefined`。前缀限定注入是程序员的断言，与手写 `createApp<MyState>` 完全一样。
- **路由链不传递。** 在路由自己的中间件链里（`get(app, '/x', withUser, handler)`），中间件照常运行并在运行时写入 state，但处理器保持宽松的 `State` 视图 —— 用 `use` 来圈定注入。
- **长链。** 每次注入都加宽 `S`，之后每个 `use`/注册器调用都会实例化累积后的交集。实测 60 个链式注入 × 60 条路由在本仓库的检查器上约一秒仍能通过 —— 真正的成本在于人体工学（悬停展示与报错信息会列出全部键），超过大约几十个注入点后建议收拢为一个显式 `interface MyState extends State` 加一次 `createApp<MyState>()`。

`withState` 是恒等函数 —— 零运行时开销；品牌（`_state`）只存在于类型上，与 `throws` 的 `_errors`、gate 的 `_in` 完全一致。发布文档化 state 槽位的电池（如 `requestId`）可以用同样的方式打品牌，`defineMiddleware` 会保留完整的品牌类型。

## 上下文字段

`ctx.url` 是已解析的请求 URL（复用它 —— 无需重复解析）。`ctx.signal` 是请求的协作取消 `AbortSignal`。在 node 适配器中，客户端请求中途断开时它会中止（Cloudflare 自动传递平台的断开信号），`timeout` 在截止时间中止它，长时间运行的工作应与之竞态（请求体读取器就是这样做的）。想要极限吞吐的应用可以传 `abortOnDisconnect: false` —— 共享一个永不中止的信号，没有每请求的 `AbortController`，在最小 hello-path 应用上值得大约 8%。中间件可以在进入时交换信号（`AbortSignal.any([...])`），并在 unwind 时恢复。`await next()` settle 之后，`ctx.res` 总是已物化 —— 处理器的响应、404/405/500 回退、**或错误响应**：链内的错误边界在 unwind 之前映射抛出的错误，因此中间件能观察（并可覆盖）真实响应，即使 500 也一样。这正是 logger/CORS/request-id 能盖上错误响应的原因。`ctx.route` 是匹配到的路由对象本体（404/405 回退时为 `undefined`）—— 只读，是回卷期按路由查找的锚点（`s200/response-check` 的 schema 查找就以它为键）。

## 路由级中间件

路由也接受作用域中间件：模式与终结处理器之间可以放任意多个。它们在应用级链之后运行（并在其内部 unwind），只为自己的路由服务：

```ts
const requireAuth = (ctx: Ctx, next: Next) => {
  if (ctx.state.user === undefined) throw httpError(401, 'Login required');
  return next();
};

get(app, '/admin', requireAuth, (ctx) => json(ctx, { ok: true }));
```

不调用 `next()` 会跳过其下的一切 —— 包括处理器 —— 因此就地应答或提前抛出的门永远到不了处理器（koa 短路语义）。

## 前缀作用域

中间件也按前缀作用域 —— 该组只在其下的请求中运行（段边界感知：`/admin` 匹配 `/admin` 和 `/admin/…`，不匹配 `/administrator`），像普通中间件一样按注册顺序嵌套：

```ts
use(app, '/admin', requireAuth, async (ctx, next) => {
  ctx.state.zone = 'admin';
  await next();
});
use(app, '/users/:id', loadUser);   // param prefixes use the router's own matching
```
