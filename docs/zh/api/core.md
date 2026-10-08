# 核心 API（`s200`）

核心 barrel：应用数据、路由、洋葱组合、错误值与调度入口。全部是 `s200` 的具名导出 —— 没有类、没有 `new App()`。

## 类型

| 类型 | 形状 |
| --- | --- |
| `Params` | `Record<string, string>` —— 从 `:name` / `*name` 捕获的路径参数 |
| `QueryOf<QS>` | `QueryOf<'page&limit'>` → `Partial<Record<'page' \| 'limit', string \| string[]>>` —— 编译期查询串形状 |
| `State` | `interface { [key: string]: unknown }` —— 每请求状态包；用 `declare module 's200'` 扩展 |
| `Next` | `() => Promise<void>` —— 洋葱的内层 |
| `Middleware<S>` | `(ctx: Ctx<Params, S>, next: Next) => Promise<void> \| void` |
| `Handler<P, S, O>` | `(ctx: Ctx<P, S>) => O \| Promise<O>` —— 可返回 `Response`（收养为 `ctx.res`）、`JsonResponse`（带品牌）或空 |
| `Ctx<P, S>` | `{ req, url, params, query, state, signal, res? }` —— 每请求的可变单元 |
| `Segment` | `{ _tag: 'static'; value } \| { _tag: 'param'; name; optional } \| { _tag: 'wildcard'; name }` |
| `RouteDef` | `{ method, pattern, … }` —— 一次注册的编译期签名 |
| `Route` | `createRoute` 产出的不可变注册项 |
| `MatchResult` | `{ route, params } \| { allowedMethods }` —— 后者供给 405 的 `Allow` 列表 |
| `MatchFn` | `(routes, method, pathname) => MatchResult \| undefined` —— 可替换路由器 |
| `ErrorHandler<S>` | `(ctx, error) => Promise<void> \| void` —— 把抛出的值映射为响应 |
| `NotFoundHandler<S>` | `(ctx) => Promise<void> \| void` —— 未匹配请求的最后机会；默认 404 |
| `Plugin<S>` | `(app: App<S>) => void` —— 在可变应用数据上的扩展钩子 |

### 幻影类型通道

handler/闸门的返回类型携带编译期品牌（绝非运行时数据）：

- `ResolveOut<O>` / `ResolveStatus<O>` —— handler 返回声明体/状态（来自 `JsonResponse` 的 `_out` / `_status`）
- `ChainIn<Ms>` —— 路由闸门合并声明的输入形状（`_in` 幻影，如 `jsonBody` 的解析类型）
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
| `logError` | `console.error` | 未设自定义 `onError` 时，意外（非 `HttpError`）错误的汇聚点；客户端始终看到匿名 500 |

`R` 是幻影参数 —— 已注册 `method` + `pattern` 字面量的编译期日志，供 `s200/client` 消费，绝不出现于运行时形状。

## 注册

```ts
use(app, mw);                                   // 全局中间件
use(app, '/admin', adminMw, auditMw);         // 前缀作用域中间件
usePlugin(app, plugin);                       // `(app) => void` 扩展钩子
mount(app, '/v1', v1App');                    // 把子应用路由挂到前缀下
addRoute(app, route);                         // 原始 Route 注册
get / post / put / patch / del / head / options / all (app, pattern, handler, middlewares?)
removeRoute(app, method, pattern);            // 运行时过滤（类型层对应：RouteFilter）
```

- `use(app, prefix, …mws)` 按路径名前缀作用域（允许参数，如 `/users/:id`）；前缀不带中间件会抛错。
- `mount` 拼接模式（`'/v1'` + `'/users/:id'` → `'/v1/users/:id'`），把子应用的中间件作用域到每个挂载路由，从不修改子应用。父应用的 `match`/`onError`/`onNotFound` 生效；空子应用的中间件会丢失。
- 方法注册器（`get`、`post` …）按 handler 参数类型重载：`get(app, '/users/:id', (ctx) => …)` 通过 `ParamsOf<'/users/:id'>` 类型化 `ctx.params`。
- `all` 对所有方法注册；此类路由会被 OpenAPI 生成跳过。

## `handle(app, request, init?)` → `Promise<Response>`

整个调度契约。匹配路由、构建 `Ctx`、运行链、物化响应 —— handler 响应、404/405/500 回退与错误响应都存在于**链内**，因此 unwind 中间件（logger、cors、request-id）总能观察到真实状态。`init.signal` 与适配器的取消组合；URL 优先复用适配器缓存的。

## `compose(middlewares)` → `(ctx, next?) => Promise<void>`

koa-compose 语义：下游按注册序、上游逆序。抛错使整链拒绝；结算前二次 `next()` 以 `Error('next() called multiple times')` 拒绝。可选的尾参 `next` 续到外层链，因此组合链本身可再组合。

## 路由原语（`s200/router`）

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
export type HttpError = { status: number; message: string; body?: unknown };

httpError<S extends number, B>(status, message?, body?): HttpError & { status: S; body?: B };
isHttpError(e): e is HttpError;          // 鸭子类型 —— 绝不用 instanceof
toErrorResponse(error): Response;        // 任意抛出的值 → Response
throws(401, 404);                        // 声明错误分支（类型层）
throws<{ 401: { error: string } }>({ … });
```

- `httpError` 要求 `[400, 599]` 的整数状态；`body` 原样穿过 `toErrorResponse`，替代默认的 `{ error: message }` 信封。
- `throws(...)` 是类型层声明（空操作中间件）：给路由错误通道打品牌，使 `s200/client` 的响应联合点名这些状态与体。
