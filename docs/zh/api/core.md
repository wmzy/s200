# 核心 API（`s200`）

核心 barrel：应用数据、路由、洋葱组合、错误值与调度入口。全部是 `s200` 的具名导出 —— 没有类、没有 `new App()`。

barrel 还再导出[响应助手、请求体读取与 `serveStatic`](/zh/api/respond) —— `json`、`text`、`html`、`send`、`redirect`、`setHeader` / `setHeaders`（含低层 `drainPendingHeaders`）、`newResponse`、`escapeHtml`、`utf8Length`、`readText` / `readJson` / `readForm` / `readStream` 与 `serveStatic`（以及 `StatusedResponse`、`JsonResponse`、`BodyOptions`、`StaticFileInfo`、`ServeStaticOptions` 类型） —— 单一导入面覆盖整个请求/响应周期。

## 类型

| 类型 | 形状 |
| --- | --- |
| `Params` | `Record<string, string>` —— 从 `:name` / `*name` 捕获的路径参数 |
| `QueryOf<QS>` | `QueryOf<'page&limit'>` → `Partial<Record<'page' \| 'limit', string \| string[]>>` —— 编译期查询串形状 |
| `State` | `interface { [key: string]: unknown }` —— 每请求状态包；用 `declare module 's200'` 扩展 |
| `Next` | `() => Promise<void>` —— 洋葱的内层 |
| `Middleware<S>` | `(ctx: Ctx<Params, S>, next: Next) => Promise<void> \| void` |
| `StateMiddleware<X, S>` | `Middleware<S> & { readonly _state?: X }` —— state 注入器的编译期身份：`S` 是它读取的，`_state` 幻影声明它写入 `ctx.state` 的键；由 `withState` 产出、`use` 收集 |
| `StateOf<Ms>` | 中间件列表注入的 state —— 各成员 `_state` 品牌的交集（无品牌时为 `unknown`，即交集的单位元） |
| `Handler<P, S, O>` | `(ctx: Ctx<P, S>) => O \| Promise<O>` —— 可返回 `Response`（收养为 `ctx.res`）、`JsonResponse`（带品牌）或空 |
| `Ctx<P, S>` | `{ req, url, params, query, state, signal, route, res? }` —— 每请求的可变单元；`route` 是匹配到的路由本体（404/405 回退时为 `undefined`） |
| `Segment` | `{ _tag: 'static'; value } \| { _tag: 'param'; name; optional } \| { _tag: 'wildcard'; name }` |
| `RouteDef` | `{ method, pattern, … }` —— 一次注册的编译期签名 |
| `Registrar<M>` | 每个方法注册器（`get`、`post`、…）共享的签名：字面量模式与动态模式两个重载，追加一个 `RouteDef` |
| `AddRoute` | 动态方法注册器的签名 —— `addRoute(app, method, pattern, chain)`，def 的方法标记为 `Uppercase<M>` |
| `RoutesBuilder<S, R>` | `routes(app)` 返回的可链式 builder —— 每个注册器一个方法外加 `use`/`mount`，各自返回追加了幻影日志的 builder，`.app` 暴露类型化的 `App` |
| `Route` | `createRoute` 产出的不可变注册项 |
| `MatchResult` | `{ route, params } \| { allowedMethods }` —— 后者供给 405 的 `Allow` 列表 |
| `MatchFn` | `(routes, method, pathname) => MatchResult \| undefined` —— 可替换路由器 |
| `ErrorHandler<S>` | `(ctx, error) => Promise<void> \| void` —— 把抛出的值映射为响应 |
| `NotFoundHandler<S>` | `(ctx) => Promise<void> \| void` —— 未匹配请求的最后机会；默认 404 |
| `Plugin<S>` | `(app: App<S>) => void` —— 在可变应用数据上的扩展钩子 |
| `HandleInit` | `{ signal?: AbortSignal }` —— `handle` 的可选 init；信号与适配器自身的取消组合 |

### 幻影类型通道

handler/闸门的返回类型携带编译期品牌（绝非运行时数据）：

- `ResolveOut<O>` / `ResolveStatus<O>` —— handler 返回声明体/状态（来自 `JsonResponse` 的 `_out` / `_status`）
- `ChainIn<Ms>` —— 路由闸门合并声明的输入形状（`_in` 幻影 —— `jsonBody` 的解析类型、`queryParams` 的读取、`requiresHeaders` 的键、`bodyShape` 的结构化类型）
- `StateOf<Ms>` —— `use` 实参列表注入的 state（`_state` 幻影 —— `withState` 的品牌），交集进应用的 `S`，使 handler 类型化地读到注入键
- `ChainErrors<Ms>` / `OutErrors<O>` / `RouteErrors<Ms, O>` —— 路由可能返回的错误分支（`throws` 闸门 + 返回的 `httpError` 值）
- `BranchesOf<O>` —— handler 返回联合声明的状态 → 体对；供 `s200/client` 消费
- `UnionToIntersection<T>` —— 把函数类型联合转为重载集

## `createApp(options?)` → `App<S, R>`

```ts
const app = createApp<MyState>({ strict: false });
```

`App` 是普通数据：`{ routes, middlewares, match, onError, onNotFound, logError }`。数组是**快照不可变**的 —— 每次注册都用冻结副本替换，因此调度缓存按数组身份版本化。只通过注册函数修改；直接 `push` 会抛错。

`AppOptions`：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `match` | trie 匹配器 | 可插拔 `MatchFn` —— 不动 `App` 换成基数树等 |
| `strict` | `true` | 默认匹配器的尾斜杠容忍（`false` = `/users/` 匹配 `/users`） |
| `onError` | — | 自定义错误映射；在链内运行 |
| `onNotFound` | 404 | 自定义未匹配应答 |
| `logError` | 上下文行 + 错误 | 未设自定义 `onError` 时，意外（非 `HttpError`）错误的汇聚点；接收 `(error, ctx)`（增量式 —— `(error) => void` 输出端继续可用）。默认先输出 `[s500] <method> <pathname>[ <request id>]` 再输出错误本身，走 `console.error` —— id 取 request-id 电池写入的 `state.requestId`（无论配置了什么 header 名），否则回退到字面 `x-request-id` 头；客户端始终看到匿名 500 |

`R` 是幻影参数 —— 已注册 `method` + `pattern` 字面量的编译期日志，供 `s200/client` 消费，绝不出现于运行时形状。

## 注册

```ts
use(app, mw);                                   // 全局中间件
use(app, withState<{ user: User }>(injectUser)); // 全局注入器 —— 加宽 S
use(app, '/admin', adminMw, auditMw);         // 前缀作用域中间件
usePlugin(app, plugin);                       // `(app) => void` 扩展钩子
mount(app, '/v1', v1App);                    // 把子应用路由挂到前缀下
addRoute(app, 'GET', '/raw', handler);        // 动态方法注册器（方法在前）
get / post / put / patch / del / head / options / all (app, pattern, handler, middlewares?)
removeRoute(app, method, pattern);            // 运行时过滤（类型层对应：RouteFilter）

routes(app)                                    // 同一批注册器的可链式语法糖
  .use(withState<{ user: User }>(injectUser))
  .get('/users/:id', (ctx) => json(ctx, { id: ctx.params.id }))
  .post('/users', createUser);
```

- `use(app, prefix, …mws)` 按路径名前缀作用域（允许参数，如 `/users/:id`）；前缀不带中间件会抛错。
- `use` 同时贯穿 state 通道：每个经 `withState` 打品牌的实参贡献其 `_state` 幻影，返回应用的 `S` 变为 `S & X` —— 下游中间件与 handler 类型化地读到注入键。普通中间件不贡献任何东西、类型不变；品牌收集是应用级的（前缀形式无法把它收窄到前缀下的路由），路由链也不传递它 —— 见下方 `withState(mw)` 一节。
- `mount` 拼接模式（`'/v1'` + `'/users/:id'` → `'/v1/users/:id'`），把子应用的中间件作用域到每个挂载路由，从不修改子应用。子应用的 `onError` 会被携带：每个挂载路由包在一个路由级错误边界里应用它（子 `onError` 写了响应则以它为准；放弃处理则重新抛出，由父应用的策略映射 —— 子 handler 自身崩溃同样如此）。`onNotFound` 与自定义 `match` 无法随行（父应用调度挂载路由），当子应用确实定义了它们时，每次 `mount` 调用发出一次 `console.warn` 后丢弃；空子应用的中间件会丢失。类型层，`MountedDefs<R, Base>` 记录挂载的定义 —— 模式以前缀为基（根为 `/` 的子应用坍缩为裸前缀），`out`/`status`/`in`/`errors`/`branches` 幻影通道随行 —— 因此挂载的应用保留其类型化客户端面；`MountBase` 规范化前缀，`MergeRecords` 并集重叠的幻影键。
- 方法注册器（`get`、`post` …）按 handler 参数类型重载：`get(app, '/users/:id', (ctx) => …)` 通过 `ParamsOf<'/users/:id'>` 类型化 `ctx.params`。
- `routes(app)` 是纯语法糖：builder 的每个方法（`get`/`post`/`put`/`patch`/`del`/`head`/`options`/`all`/`use`/`mount`）1:1 委托给普通注册器并立即在 `app` 上注册，然后返回 builder。幻影 `App` 类型像普通注册器一样贯穿链，因此 `s200/client` 推断经由 builder 的 `.app`（即传入的那个对象）完全一致地工作：`createClient(routes(app).get('/x', h).app)`。
- `all` 对所有方法注册；此类路由会被 OpenAPI 生成跳过。

## `handle(app, request, init?)` → `Promise<Response>`

整个调度契约。匹配路由、构建 `Ctx`、运行链、物化响应 —— handler 响应、404/405/500 回退与错误响应都存在于**链内**，因此 unwind 中间件（logger、cors、request-id）总能观察到真实状态。`init.signal` 与适配器的取消组合；URL 优先复用适配器缓存的。

## `compose(middlewares)` → `(ctx, next?) => Promise<void>`

koa-compose 语义：下游按注册序、上游逆序。抛错使整链拒绝；结算前二次 `next()` 以 `Error('next() called multiple times')` 拒绝。可选的尾参 `next` 续到外层链，因此组合链本身可再组合。

## `defineMiddleware(mw)` → `M`

第三方电池作者的发布标识：把一个 `(ctx, next)` 函数包装为可复用的 s200 电池。零运行时成本 —— 恒等函数。它服务于可发现性（一个可导入的创作符号）与电池工具的挂点，并完整保留中间件类型 —— 包括路由注册器与 `s200/client` 消费的幻影 `_in` 闸品牌（`jsonBody` 的解析类型、`queryParams` 的读取类型）。见[编写电池模块](/zh/guides/battery-authoring)。

## `withState(mw)` → `StateMiddleware<X, S>`

```ts
const withUser = withState<{ user: User }>(async (ctx, next) => {
  ctx.state.user = await loadUser(ctx); // 注入器内可写 X 的键
  await next();
});
const app2 = use(app, withUser); // App<State & { user: User }, R>
get(app2, '/me', (ctx) => json(ctx, ctx.state.user)); // User，已类型化
```

把中间件打品牌为 state 注入器：`X` 声明它在 `next()` 前写入 `ctx.state` 的键，`use` 把 `_state` 幻影收集进应用的 `S`（`S & X`）—— 下游中间件与 handler 类型化地读到注入键，既不需要手写应用 state 接口、也不需要全局 `declare module` 合并。（`onError`/`onNotFound` 策略回调在 `createApp` 时定型、先于任何注入 —— 它们运行时能观察到注入值，类型以其自身声明为准。）第二个类型参数（默认：全局 `State`）是中间件可**读取**的 —— 注入器消费更早注入时显式传入，`use` 随即在编译期强制注入顺序。注入沿 `use` 调用与实参按交集累积；普通中间件是恒等情形（贡献坍缩、应用类型不变）。

恒等函数 —— 零运行时成本，品牌像 `throws` 的 `_errors` 一样只存在于类型上。边界：收集到的类型是应用级的（前缀限定的 `use` 形式无法收窄到前缀下的路由 —— 前缀限定注入是程序员的断言，与手写 `createApp<MyState>` 一样）；路由自身链里被打品牌的中间件照常运行，但不把品牌传递进 handler 的 `ctx.state`。长链（几十个注入）依然很快；再多建议收拢为显式 `interface MyState` —— 见[中间件指南：推断式注入](/zh/guides/middleware)。

## 路由原语（核心 barrel）

这些由核心 barrel 导出 —— `import { matchRoutes } from 's200'` —— 而非独立的包入口：

| 函数 | 含义 |
| --- | --- |
| `createSegments(pattern)` | 把 `:param` / `:param?` / 末端 `*wildcard` 解析为 `Segment[]` |
| `createRoute(method, pattern, handler, middlewares?)` | 构建一个不可变 `Route`（方法规范化大写） |
| `matchSegments(segments, pattern, pathname)` | 已解析模式对路径名的匹配 |
| `matchRoutes(routes, method, pathname, strict?)` | trie 匹配器：静态前缀节点、常规列表、索引二级映射 |
| `createMatcher({ strict? })` | 基于 `matchRoutes` 的 `MatchFn` —— `createApp` 默认安装 |
| `ParamsOf<P>` | `ParamsOf<'/users/:id'>` → `{ id: string }` —— 编译期参数形状 |

## 错误（`s200` errors）

```ts
export type HttpError = { status: number; message: string; body?: unknown; headers?: Record<string, string> };

httpError<S extends number, B>(status, message?, body?, headers?): HttpError & { status: S; body?: B };
isHttpError(e): e is HttpError;          // 鸭子类型 —— 绝不用 instanceof
toErrorResponse(error): Response;        // 任意抛出的值 → Response
throws(401, 404);                        // 声明错误分支（类型层）
throws<{ 401: { error: string } }>({ … });
```

- `httpError` 要求 `[400, 599]` 的整数状态；`body` 原样穿过 `toErrorResponse`，替代默认的 `{ error: message }` 信封；`headers`（一个 `Record<string, string>`，如闸门的 `www-authenticate` 质询或 `retry-after` + IETF `RateLimit-*`）合并进错误响应，拒绝因此可以走错误边界路径（含 `onError`），而不必就地应答。
- `throws(...)` 对请求处理是纯透传中间件：给路由错误通道打品牌，使 `s200/client` 的响应联合点名这些状态与体 —— 且同一声明现在运行时可读（门上的 `_errors`），`s200/openapi` 据此文档化错误分支，`s200/codegen` 据此生成进类型化客户端。
