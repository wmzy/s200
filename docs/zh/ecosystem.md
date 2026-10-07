# 生态

battery 是 s200 的中间件复用单元：一个藏在自己专属包入口后面的 opt-in
模块，输入选项、输出 `Middleware`（完整契约见
[编写 Battery](https://github.com/wmzy/s200/blob/main/docs/zh/guides/battery-authoring.md)）。
本页就是注册表——盒子里装了什么，以及一个第三方 battery 如何加入这份
名单。

## 官方

下面的一切都随 `s200` 包本身发布：每个入口一个源文件，以
`import { … } from 's200/<entry>'` 导入——拉取一个入口绝不拉取另一个。
除 `s200/events` 外，所有入口都是零运行时依赖；`s200/events` 构建在
[`@for-fun/event-emitter`](https://www.npmjs.com/package/@for-fun/event-emitter)
之上（这是它唯一的依赖——核心保持零依赖）。
[Batteries](/guides/batteries) 一节按每个 release
追踪各入口体积。

### 中间件

| 入口                 | 提供什么                                                       |
| --------------------- | -------------------------------------------------------------- |
| `s200/cors`           | `cors` —— 预检就地应答，头在 unwind 时盖章（含回退）          |
| `s200/logger`         | `logger` —— 每请求一行，每个请求都有（含 500）                 |
| `s200/request-id`     | `requestId` —— 播下一个 id，在 unwind 时盖章 `x-request-id`   |
| `s200/timeout`        | `timeout` —— 收窄 `ctx.signal`，让链与截止时间赛跑             |
| `s200/etag`           | `etag` —— 对字节背书的响应体做 If-None-Match 再验证            |
| `s200/compress`       | `compress` —— 经 `CompressionStream` 的 gzip/deflate/br        |
| `s200/secure-headers` | `secureHeaders` —— OWASP 头集合                                |
| `s200/cache`          | `cache` —— 带新鲜度校验器的响应缓存                            |
| `s200/rate-limit`     | `rateLimit` —— 滑动窗口限流器，存储可注入                      |
| `s200/trust-proxy`    | `trustProxy` —— 代理之后如实还原客户端 IP                      |
| `s200/version`        | `apiVersion` —— header/Accept API 版本门，`ctx.state.version`  |

### 认证与会话

| 入口           | 提供什么                                                         |
| --------------- | ---------------------------------------------------------------- |
| `s200/auth`     | `basicAuth`、`bearerAuth` —— 带质询的门                          |
| `s200/jwt`      | `signJwt`、`verifyJwt`、`jwtAuth` —— 基于 WebCrypto 的 JWS       |
| `s200/csrf`     | `createCsrf` —— 双提交令牌                                       |
| `s200/session`  | `createSession` —— cookie 会话，存储可注入                       |
| `s200/cookies`  | `getCookie`、`setCookie`、`getSignedCookie`、`setSignedCookie`   |

### 请求体与流式

| 入口            | 提供什么                                                          |
| ---------------- | ------------------------------------------------------------------ |
| `s200/accepts`   | `accepts` —— RFC 9110 内容协商                                    |
| `s200/query`     | `parseQuery`、`queryParams` —— 类型化 query 字符串                |
| `s200/validate`  | `validate`、`jsonBody` —— schema 或手写解析函数                   |
| `s200/serialize` | `serialize`、`jsonRaw` —— 声明式响应形状                          |
| `s200/multipart` | `streamForm` —— 流式 multipart 部件，逐部件回调                   |
| `s200/upload`    | `uploadForm` —— 门控上传，写入注入的 sink                         |
| `s200/streaming` | `stream`、`streamSSE` —— 流式与 SSE 响应                          |

### 实时

| 入口                   | 提供什么                                                |
| ----------------------- | -------------------------------------------------------- |
| `s200/websocket`        | `upgradeWebSocket` —— 运行时中立的 WS upgrade           |
| `s200/websocket/node`   | `createUpgradeHandler` —— node http 服务器一侧           |
| `s200/websocket/bun`    | `createBunWebSocketBridge` —— Bun 一侧                   |

### 内省与工具

| 入口             | 提供什么                                                       |
| ----------------- | --------------------------------------------------------------- |
| `s200/route-table`| `createRouteTable` —— 应用导出为 JSON，无需执行                 |
| `s200/meta`       | `describeRoute`、`describeApp` —— 路由注解                      |
| `s200/openapi`    | `openapiSpec`、`openapiJson` —— OpenAPI 3.1 文档                |
| `s200/swagger`    | `swaggerUi` —— 提供文档 UI                                      |
| `s200/codegen`    | `generateClient` —— 从路由表生成类型化客户端                    |
| `s200/client`     | `createClient` —— 类型化 fetch 客户端                           |
| `s200/test`       | `request`、`testClient`、`probeApp` —— 进程内驱动应用           |
| `s200/otel`       | `trace` —— 每请求的 OTel span                                   |
| `s200/dev`        | `createHotApp`、`importFresh`、`watchAndReload` —— 热路由表     |

### 运维

应用生命周期层——NestJS 的 `enableShutdownHooks`、`Terminus`、
`@nestjs/config`、`@nestjs/schedule` 与 `EventEmitter` 支持，以
数据 + 函数的形式：

| 入口             | 提供什么                                                           |
| ----------------- | ------------------------------------------------------------------ |
| `s200/lifecycle`  | `lifecycle` —— 信号驱动的优雅关停：翻转就绪态、停止监听、排空在途请求、执行清理 |
| `s200/health`     | `health`、`readiness`、`createGate` —— 基于可注入检查的存活/就绪探针 |
| `s200/config`     | `parseEnv`、`createConfig` —— Standard Schema 定型、快速失败的配置 |
| `s200/schedule`   | `createScheduler`、`nextRun` —— cron（5 字段）与间隔任务，时钟可注入 |
| `s200/events`     | `createBus` —— 基于 `@for-fun/event-emitter` 的类型化事件总线（同步 emit、`emitAsync`） |

### 运行时适配器

不是中间件——每条一行，把同一个应用跑在另一个运行时上：

| 入口             | 提供什么                                                           |
| ----------------- | ------------------------------------------------------------------ |
| `s200/node`       | `serve`（light 模式、TLS/HTTP2、WSS upgrade）+ 文件读取器          |
| `s200/bun`        | `serve` + Bun 文件读取器                                            |
| `s200/deno`       | `serve` 构建于 `Deno.serve` 之上                                    |
| `s200/cloudflare` | `createHandler` —— module worker 的默认导出                         |

### 配方

仓库级 TypeScript，刻意**不**作为包导出——把文件 vendor 进来，自带
客户端，注入：

| 配方                   | 用途                                                             |
| ---------------------- | ---------------------------------------------------------------- |
| [`recipes/redis-stores.ts`](https://github.com/wmzy/s200/blob/main/recipes/redis-stores.ts) | 经 Redis 共享的 `rateLimit`/`createSession` 存储——完整指南：[分布式存储](./guides/distributed-stores.md) |

## 提交你的 battery

下面的注册表面向第三方 battery——任何遵循 battery 契约、可被导入的
东西。提交之前，先看看上面某个官方入口是否已经覆盖了它；更小的核心
配上一圈健康的生态，这才是本意。

### 收录标准

- **数据 + 函数范式。** 工厂接收选项并返回一个 `Middleware`（或
  数据）——没有类、没有 `this`、没有模块级注册副作用。
  [编写 Battery](https://github.com/wmzy/s200/blob/main/docs/zh/guides/battery-authoring.md)
  用内建 battery 的例子讲解两种运行时形态（门与 unwind 盖章器）。
- **可 tree-shaking。** 每个能力一个入口，ESM，无副作用的模块作用域——
  导入你的 battery 不得拉取导入方没有点名的东西。
- **首选零运行时依赖。** 其余一切都是 Web 标准或由调用方注入（存储、
  schema、时钟、校验器、sink）——内建 battery 正是因此保持零依赖。
  带依赖的 battery 仍可收录；依赖列的存在就是为了让导入方看到成本。
- **诚实的体积。** 你那一行的数字是该入口被导入方实际拉取时的 gzip
  字节成本（如 `size-limit`，或
  `gzip -9 < dist/entry.mjs | wc -c`），是测出来的，不是估出来的。

### 提交模板

向本页开一个 PR，按此模板向注册表添加一行：

```md
| Name | Entry | Depends on | Size (gz) | Notes |
| ---- | ----- | ---------- | --------- | ----- |
| your-battery | `your-battery` | — | 0.4 kB | one line: what it does, and which seam it plugs (gate / unwind stamper / data) |
```

- **Name** —— npm 包名，如果你希望该命名空间被读作一种生态惯例，可加
  `s200-battery-` 前缀（非必需）。
- **Entry** —— 导入方书写的子路径，如 `s200-battery-og/image`（每入口
  一行；多入口包每个入口各一行）。
- **Depends on** —— 运行时依赖，无则 `—`。peer 依赖也计入，并附版本
  范围。
- **Size (gz)** —— 实测的入口 gzip 体积（见上面的标准）。
- **Notes** —— 一行，现在时：它做什么。在 Name 单元格里链接仓库文档。

### 流程

1. 按[编写 Battery](https://github.com/wmzy/s200/blob/main/docs/zh/guides/battery-authoring.md)
   指南编写；随附测试和带实测体积的 README。
2. 开一个 PR 把你的行加进下面的注册表——表格就是评审面，PR 落地
   即上架。
3. 包不再可解析、或体积漂移且未沟通的行，会先收到一个提醒 PR，随后
   被移除。

## 注册表——第三方 battery

| Name | Entry | Depends on | Size (gz) | Notes |
| ---- | ----- | ---------- | --------- | ----- |

该表刻意从空开始——没有占位行。每个单元格遵循上面的提交模板；第一个
真实条目将确立先例。
