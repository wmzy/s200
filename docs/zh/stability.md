# 稳定性与版本化

s200 正在迈向 1.0。本页面就是那份契约：1.0 时会冻结什么、版本如何发布，
以及同样重要的——哪些东西**尚未**冻结（如实列出）。如果你基于 s200 构建，
升级前先看这一页。

## 冻结面（1.0 契约）

以下内容自 1.0 起全部是契约性的：只会在 major 版本中变更（1.0 之前则在带
标记的 minor 版本中变更——参见 [semver 策略](#semver-policy)）。这份清单
刻意只覆盖真实应用会接触到的表面；内部实现（私有辅助函数、chunk 布局、
未写入文档的对象）仍可自由变动。

### 应用创建

```ts
const app = createApp(options?);
```

| 选项 | 契约 |
|---|---|
| `match` | 替换整个匹配策略（一个作用于路由表的 `MatchFn`）。内置匹配器仍为默认。 |
| `strict` | 默认匹配器的尾斜杠策略。默认 `true`（严格：`/a/` 不匹配 `/a`）；`false` 容忍一个尾斜杠。 |
| `onError` | 负责错误 → 响应的映射。未设置时，未处理的 `HttpError` 渲染为 `{ status, body: { "error": message } }`，其余错误则记录日志（`logError`，默认 `console.error`）并渲染成绝不泄露内部细节的通用 500。 |
| `onNotFound` | 负责未匹配路径的响应。默认：`404 {"error":"Not Found"}`。 |
| `logError` | 在保留默认映射的同时，替换错误日志的输出端。 |

`createApp` 还接受按应用定制的 `State` 接口（`createApp<AdminState>()`）
——这个泛型形态是契约的一部分。

### 注册器

`use`、`get`、`post`、`put`、`patch`、`del`、`head`、`options`、`all`、
`addRoute`、`removeRoute`、`mount`（外加面向函数形态插件的 `usePlugin`）。
它们承载的行为契约：

- `use(app, mw)` 追加一个应用级中间件；`use(app, '/admin', mw)` 把一组
  路由限定在一个感知段边界的前缀下（参数化前缀走路由器自身的匹配）。嵌套
  遵循注册顺序。
- 路由注册器接受在模式与末端处理器之间插入任意数量的作用域中间件；它们在
  应用级链之后运行，并在其内部回卷。
- `all` 匹配所有方法；`addRoute(app, 'PURGE', …)` 可注册任意方法字符串。
- `removeRoute(app, 'GET', '/users/:id')` 按“方法 + 模式”擦除；路由表是快照
  不可变的（注册操作替换冻结的数组，直接 `push` 会抛错），因此分发缓存永远
  不会过期。
- `mount(app, '/v1', sub)` 是一次纯数据变换：`sub` 被复制、从不被改动，其
  应用级中间件在挂载后的路由上变为路由作用域。

### `Ctx` 契约

```ts
type Ctx = { req, url, params, query, state, signal, res };
```

- **`params` 已预先解码** —— 捕获的值以 percent 解码后的形态到达处理器
  （`/users/foo%20bar` → `'foo bar'`），而匹配运行在原始路径上，因此编码
  出的 `/` 永远无法伪造段边界。
- **`url` 每个请求只解析一次**并缓存——直接复用，不要再解析。
- **`signal` 是协作式取消**：客户端断开连接时它中止（node 适配器默认；
  `abortOnDisconnect: false` 恢复为一个共享的、永不中止的 signal），
  `timeout` battery 会在截止时间中止它，长时间运行的工作应当与它竞速
  （body 读取器就是这么做的）。中间件可以在进入时替换它、在回卷时恢复它。
- **`state` 是每个请求全新的可变容器** —— 类型化的交接通道，可通过声明合并
  或按应用接口扩展。
- **`res` 在 `await next()` 落定后必定已物化** —— 处理器的响应、404/405/500
  回退，**或映射后的错误响应**：链内的错误边界会在回卷之前映射抛出的错误，
  因此即使是 500，中间件也能观察（并可以覆盖）真实的响应。在任何内容写入
  之前，`res` 为 `undefined`。

### 响应

`json`、`text`、`html`、`send`、`redirect` 和 `newResponse` 会就地写入
`ctx.res`（init 传入的响应头始终压过默认值）并返回写入的 `Response`。周边
的契约：

- 处理器可以简单地**返回**一个 `Response` —— 在尚无任何写入时它会被写入。
  也可以**返回一个 `HttpError`** —— 这是抛出它的语法糖：该值流经同一个链内
  错误边界（含 `onError` 映射），且返回类型会把状态码和 body 形状带进
  `s200/client` 的 `res.status` / `res.json()` 联合。
- 匹配到的链跑完却未写入任何内容时，应答 `500 {"error":"No response written"}`；
  未匹配且未写入的请求交给 `onNotFound`。
- **`content-length` 契约**：只要大小已知，这些辅助函数就会显式设置
  `content-length`（平台惰性序列化，裸的 `new Response('…')` 不带该头）。
  HEAD 响应保留本应具有的大小，而感知大小的中间件（`compress` 的
  `minBytes`、`s200/etag` 的字节背书检测）依赖它。
- `html` **不做**转义——转义请用 `escapeHtml`，“不转义”的语义是契约的一
  部分。

### 错误

```ts
httpError(422, 'Invalid article');          // → HttpError（带标签的数据）
isHttpError(e);                              // 结构检查，不用 instanceof
toErrorResponse(e);                          // → 默认映射后的 Response
throws(401, 404);                            // 面向客户端的错误分支门
throws({ 422: { issues: string[] } });       // 附带结构化 body 形状
```

错误是按结构检查的带标签数据，因此能跨越 bundle 边界存活。
`httpError(status, message, body?)` 携带一个可选负载并按原样渲染；没有负载
时响应保持 `{ error: message }` 信封。处理器可以抛出它们，也可以**返回**它们
——返回的 `HttpError` 走的正是抛出者所走的同一条错误边界路径，其类型还会
推断出客户端的错误分支（无需声明）。`throws` 门是为类型层看不见的分支（从
辅助函数里抛出的那些）准备的声明通道：它把一条路由可能应答的状态码（及
body 形状）合并进 `s200/client` 按状态码判别的 `res.status` /
`res.json()` —— 运行时是纯透传。

### 路由语义

- 模式：`:name` 参数、`:name?` 可选段、末端的 `*name` 通配符。重复的捕获名
  会在注册时被拒绝。
- 多个模式都匹配时，**先注册者胜出**。
- **`HEAD` 回退到 `GET` 路由。**
- 路径匹配但方法不匹配时，应答**带 `Allow` 头的 `405`**，其中列出本可匹配
  的方法（RFC 9110）——中间件仍可抢先应答此类请求（CORS 预检就会短路）。
- **默认严格对待尾斜杠**；`strict: false` 让应用按需选择容忍。可选参数是带
  回溯的贪婪匹配（`/x/:a?/y` 匹配 `/x/y` 和 `/x/1/y`），链式可选参数从左到
  右解析。

### battery 入口

下面这些包入口是冻结的模块地图——每一个都可独立导入、可 tree-shaking、零
运行时依赖。可以**新增** battery（一次 minor），但既有入口的名字及其导出的
标识符保持不变。

```
s200/node  s200/bun  s200/deno  s200/cloudflare          （适配器）
s200/cors  s200/logger  s200/route-table  s200/cookies  s200/validate
s200/rate-limit  s200/compress  s200/streaming  s200/request-id  s200/timeout
s200/query  s200/websocket  s200/websocket/node  s200/websocket/bun
s200/etag  s200/secure-headers  s200/auth  s200/accepts  s200/serialize
s200/client  s200/csrf  s200/jwt  s200/cache  s200/meta  s200/openapi
s200/trust-proxy  s200/otel  s200/codegen  s200/test  s200/multipart
s200/session  s200/swagger  s200/upload  s200/dev
s200/lifecycle  s200/health  s200/config  s200/schedule  s200/version
s200/events
```

## semver 策略

发布是自动化的。[`.releaserc.json`](../.releaserc.json) 把
[semantic-release](https://semantic-release.gitbook.io) 接在 `main` 分支的
conventional commits 之上：`fix:` → patch、`feat:` → minor、
`BREAKING CHANGE`（footer 或 `!`）→ major，发布说明与 npm/GitHub 发布
一应俱全。`package.json` 里的 `0.0.0-development` 版本号只是
semantic-release 会覆写的占位符——版本号从不手工编辑。

- **1.0 之前（0.x）：** 有意用满了 semver 的 0.x 宽限。**任何 minor——实践
  中任何发布——都可能改变行为**，破坏用户代码的变更会随发布说明附上一份
  迁移提示。如果你在 1.0 之前就需要稳定，请锁定精确版本。
- **1.0 及之后：** 严格 semver。[冻结面](#frozen-surface-the-10-contract)
  只在 major 中变更；新能力以 minor 落地，修复以 patch 落地。
- **弃用节奏（1.0 后）：** 弃用以标记 API（`@deprecated` JSDoc + README）
  并附迁移指南的方式宣布，保持可用**两个 minor 发布**，随后移除——移除落
  在 major 中。

## 尚未冻结

一份如实的清单。这些区域在 minor 内仍可能变化，包括 1.0 切换之前：

- **轻量模式细节** —— `s200/node` 中的 `serve(app, { light: true })` 是一条
  可选快速路径，使用鸭子类型的请求/响应对象。*默认的* Web 标准契约已冻结；
  轻量路径的覆盖面与内部实现仍可能增长和变动。
- **JSR 发布流程** —— `jsr.json` 与 `pnpm publish:jsr` 已经存在，但发布的
  模块图和节奏尚未钉死。
- **代码生成输出格式** —— `generateClient(app)` 目前产出一个独立的
  TypeScript 模块；产出的形态可能变化（它是生成的代码——请重新生成，而非
  手改）。

## 迁移指南与扩展

- [从 Express 迁移](./migration-from-express.md)
- [从 Koa 迁移](./migration-from-koa.md)
- [从 Hono 迁移](./migration-from-hono.md)
- [编写 battery](https://github.com/wmzy/s200/blob/main/docs/zh/guides/battery-authoring.md)
  ——新模块遵循的约定，包括流入 `s200/client` 的类型品牌。
