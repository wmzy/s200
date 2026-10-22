# 对比

s200 对阵人们实际部署的那些框架。对差距保持诚实——左列是卖点，
其余是 s200 为换取它而付出的交换。

## 定位

s200 = **Hono 的运行时可移植性 + Koa 的中间件模型，落在一个数据加
函数的核心上**。应用就是一个普通值（路由、中间件、配置）；每个能力
都是一个顶层函数。没有类、没有方法调用、零依赖，每个模块都可
tree-shaking、可替换。

## 对比表

| 维度 | s200 | Hono | Express 5 | Fastify 5 | Koa | Elysia |
|---|---|---|---|---|---|---|
| 范式 | 数据 + 函数，零依赖 | 基于类，零依赖 | OOP，~30 个依赖 | 工厂模式，~20 个依赖 | 极简核心，零依赖 | 类链，TS 优先，4 个依赖 |
| 运行时 | Node ≥ 20.3、Bun；Deno/Cloudflare/AWS Lambda/Vercel 适配器 | 一切运行时 + 适配器矩阵（v5：8 个 `@hono/*` 包） | 仅 Node | 仅 Node（v6 计划 ≥ 24） | 仅 Node | Bun 优先；Node 经 srvx+crossws（h3 同款地基），web-standard/Cloudflare 经适配器 |
| 中间件模型 | koa 洋葱模型，链内错误边界 | hono 洋葱模型 | connect 风格 | 钩子系统 | koa 洋葱模型 | 生命周期钩子（derive/resolve）+ 插件 |
| 路由器 | 静态前缀 trie，每个静态段都有索引 | RegExpRouter / TrieRouter | path-to-regexp | find-my-way radix | koa-router（path-to-regexp） | 静态映射 + memoirist radix，JIT 编译的处理器 |
| 可选参数 `:id?` | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| 从路径模式字面量定型参数 | ✅ `ParamsOf` | ✅（推断） | ❌ | ✅（typebox schema） | ❌ | ✅（推断） |
| 从应用出发的类型化 HTTP 客户端 | ✅ 路径 + 参数 + query + JSON 体 + 状态/错误分支，`res.json()` 由 `res.status` 判别 | ✅ `hc`（完整 RPC） | ❌ | ❌ | ❌ | ✅ Eden treaty（完整 RPC） |
| 路由移除 | ✅ `removeRoute` | ❌ | 部分 | ❌ | ❌ | ❌ |
| 路由表作为数据 | ✅ 可导出 JSON + OpenAPI | ❌ | ❌ | ✅ | ❌ | ❌ |
| 适配器内的 HTTPS / HTTP/2 | ✅ | ✅ | ✅ | ✅ | 第三方 | 经运行时（Bun.serve） |
| WebSocket | ✅ 零依赖 RFC 6455 node + bun（子协议、permessage-deflate、心跳） | ✅ | 第三方 | 第三方 | 第三方 | ✅ 内建 `.ws()`（Bun API；node 上为 crossws） |
| battery | 37 个 opt-in（cors、cookies、csrf、jwt、cache、etag、compress、rate-limit、session、upload、response-check、mcp、…） | ~20 个（含 csrf/jwt/cache） | 生态 | 插件生态 | 生态 | ~15 个官方插件（openapi、jwt、cors、rate-limit、…） |
| 吞吐量类别（见基准测试） | Web 标准对象类别；opt-in light 模式 ~1.3–1.4× | 同类（patched：1.5×） | ~0.6× | patched 类别 | 更低 | patched 类别；在 Bun 上居其榜首 |
| 核心体积（min+gz） | 由 size-limit 门控：~4 kB 最小核心 / ~8 kB 完整 barrel | ~10 kB+ | — | — | 极小，无 battery | 解包 1.1 MB；141 kB min 的 hello-world（v2 rc） |
| 校验集成 | 覆盖任意解析器的通用门 + 响应契约检查（`s200/response-check`） | 内建 zod/valibot/typebox（v5 路线图：响应校验） | 生态 | 原生 JSON Schema（v6 里程碑：Ajv 响应校验） | 生态 | 内建 TypeBox（`t`）+ standard schema |
| OpenAPI | ✅ 从路由表原生 3.1 | zod-openapi（依赖） | ❌ | swagger 插件 | ❌ | ✅ 插件（Scalar/Swagger UI） |
| JSX / SSG / 开发服务器 | ❌（经 `s200/dev` 的路由表热重载） | ✅ | ❌ | ❌ | ❌ | ❌（html 插件） |
| 生态规模 | 年轻 | 庞大 | 非常庞大 | 庞大 | 庞大 | 快速增长（使用量第 9，SoJS 2025） |

battery 行的计数口径：包共暴露 55 个入口——根 barrel 加 54 个子路径。
其中 6 个子路径是运行时适配器（`node`、`bun`、`deno`、`cloudflare`、
`aws-lambda`、`vercel`），9 个是工具/元信息入口（`client`、`codegen`、
`dev`、`meta`、`openapi`、`route-table`、`swagger`、`test`、`version`）；
其余 39 个功能子路径在把 `websocket/node` 与 `websocket/bun` 归并进
`websocket` 这一个 battery 之后，是 37 个各自独立的 opt-in battery。

### 一段话讲 Elysia

Elysia 是 TypeScript 端到端量级里最强的选手，对比表并不掩饰这一点：
[Eden Treaty](https://elysiajs.com/eden/treaty/overview) 无需代码生成，
就能从服务器类型推断路径、参数、体、查询和错误分支；校验是
[内建于路由 DSL 的 TypeBox](https://elysiajs.com/patterns/typebox)（`t`
外加面向 zod/valibot 的 standard-schema）；[OpenAPI
文档](https://elysiajs.com/plugins/openapi)从同一批定义中自然掉落；
WebSocket 是遵循 [Bun API](https://elysiajs.com/patterns/websocket) 的
一等公民 `.ws()` 路由（node 适配器上为 crossws）；路由则是静态映射加
JIT 编译的每路由处理器背后的 [memoirist radix
树](https://github.com/saltyaom/memoirist)——在我们的基准测试中，它在
node 适配器上落在 patched 的 ~14k req/s 类别
（[docs/benchmarks.md](./benchmarks.md)），在它的一等运行时 Bun 上还要
更高。v2 RC 给这套推断的静态成本标了价：[无 validator 时每路由
10.7 kB 内存](https://next.elysiajs.com/blog/elysia-20-rc/)（Hono 16、
Fastify 26.7），TypeBox schema 下 16 kB（Fastify 的 JSON Schema 序列化
为 93.3 kB）；且它现在静态推断一条路由可能产生的*全部*错误响应，自动
流入 Eden 与 OpenAPI。交换条件则是镜像：应用是一条不透明的类链，而非
数据加函数——离开框架它既不能导出为 JSON 也不能被检视——而且没有成文
的路由移除 API。核心解包后 ~1.1 MB，带 [4 个运行时
依赖](https://www.npmjs.com/package/elysia)（TypeBox 以 peer 形式发布），
Bun 之外走的是适配器而非 Hono 那套矩阵——v2 的 Node 适配器重建于
srvx + crossws 之上（h3 脚下的同一块地基），Node 谈不上二等公民，但
web-standard 与 Cloudflare 仍要过适配器，Deno/edge 方面无可奉告；
中间件是
[生命周期钩子](https://elysiajs.com/essential/life-cycle)（derive/
resolve），不是 s200 与 Koa 共享的洋葱模型。如果你的目标是 Bun，并且
想要带服务端 schema 的 tRPC 级推断，Elysia 是理性之选；s200 押注的
则是运行时无关的数据 + 函数。

## s200 赢在哪里

- **零依赖**，连 WebSocket 服务器也算在内——没有 undici/
  hono-node-server 桥接，没有 ws，没有 path-to-regexp。
- **刻意保持宽的运行时包络**：Hono v5 砍掉 CommonJS 构建并要求
  Node ≥ 22.12，Fastify v6 计划 Node ≥ 24——s200 以 ESM+CJS 双格式
  发布、跑在 Node ≥ 20.3 上，同一个产物无需转译即可嵌入 CommonJS 宿主
  与仍在机群里的最老 LTS。
- **链内错误边界**：抛错的路由处理器在中间件 unwind *之前*就被映射为
  响应，因此 logger/cors/request-id 盖章的是真实的 404/405/500。
  Express 需要一个最后注册的错误中间件；Hono 的 `onError` 位于链外
  （Hono v5，2026-10 时处于 rc，把 `onError`/`notFound` 变成了可路由、
  可组合的链内中间件——上游正在向 s200 的模型收敛）。
- **每个静态段都有索引**：`/:tenant/resourceN` 表不会退化为线性扫描
  （见 `docs/benchmarks.md` 的路由器数字）。
- **应用即数据**：把路由表导出为 JSON、从中生成 OpenAPI 3.1 文档、
  据此为 fetch 客户端定型、或把它翻译成另一种语言——无需执行。无需
  schema 库：路由注解复用了那套已经编译序列化器并推断类型的
  `SerializeSchema` DSL。
- **一切皆可替换**：自定义匹配器、自定义错误/404 策略、注入的静态
  文件 I/O——各 battery 证明了这一模式。
- **同一数据模型之上的路由热重载** —— `s200/dev` 的
  `createHotApp`/`reload` 在一个稳定的应用身份上原子换表（在途请求在
  旧链上跑完）；使其安全的快照语义，正是支撑 `removeRoute` 的那一套。

## s200 交换掉了什么（诚实的差距）

- **没有 JSX/SSG/开发服务器的故事** —— Hono 那些贴近前端的特性不在
  范围内；s200 是一个服务器框架。
- **没有完整的 RPC 推断** —— `s200/client` 为路径、参数、query 构建、
  JSON 响应体和状态字面量定型——处理器的
  `json(ctx, err, { status: 404 })` 分支会显示为
  `res.status: 200 | 404` 及合并后的响应体。错误分支来自两条通道：
  **返回**一个 `httpError(status, message, body?)` 会被端到端推断
  （返回它就是抛出它的语法糖——同一套链内错误边界，`onError` 也包含
  在内），而 `throws(401, 404)`（或 `throws({ 422: shape })`）门声明
  调用栈深处某个辅助函数可能产生的分支。客户端响应是**按状态判别的
  联合**：收窄 `res.status` 即收窄 `res.json()`。门的输入可来自任何
  [Standard Schema](https://standardschema.dev) 值（zod / valibot /
  typebox）或一个 `jsonBody`/`queryParams` 解析函数，schema 的**输入**
  类型落在调用方一侧（`init.body`/`init.query`），解析后的输出落在
  处理器一侧——input ≠ output 的变换也会端到端推断。相比 Hono `hc`/
  Elysia Eden 仍缺的是：处理器体内 `throw httpError(...)` 的调用点对
  类型层不可见（TypeScript 无法检视函数体——请返回该错误或声明它），
  且 `throws` 是一个检查器不做校验的透传声明。
- **没有路径中段通配符** —— `*name` 必须是最后一段（`/files/*path` 可以；
  `/a/*rest/b` 在注册时抛错）。仅限末段让捕获语义无歧义、静态段索引
  完好无损；它是匹配契约的一部分，只在 major 中才会重新考虑
  （见[路由](./guides/routing.md)）。
- **吞吐量落后于 patched 类别** —— s200 始终使用平台真实的
  `Request`/`Response`；fastify/elysia/hono-patched 用更轻的对象避开
  undici 的构造器成本。差距在每请求构造成本，不在分发
  （`docs/benchmarks.md` 中有测量）。
- **HTTP/2 上没有 WebSocket upgrade** —— HTTPS 之上的 WSS 在
  `s200/node` 里可用（`https` + `upgrade` 同时开）；HTTP/2 没有
  upgrade 事件，因此 `http2: true` 会排除 `upgrade` 选项。
- **年轻的生态** —— 第三方 battery 注册表刚刚开放
  （[docs/ecosystem.md](./ecosystem.md)）；官方 battery 覆盖常见面，
  `use` 模式覆盖其余。

## 2026-10 上游动态

五个对比对象里，三个正处在迈向新 major 的过渡期，两个是安静的
在位者；以下事实均来自它们自己的发布文档与追踪议题。

- **Hono v5——截至 2026-10-21 仍是 RC**（[迁移
  指南](https://hono.dev/docs/guides/migrating-to-v5)、[v5 特性
  清单](https://github.com/honojs/hono/issues/5106)）：rc.0 于
  2026-10-08 发布，两天后是 rc.1；stable 尚未落地。`hono` 转为
  ESM-only——CommonJS 构建被移除——并要求 Node ≥ 22.12；运行时适配器
  拆成八个 `@hono/*` 包（`@hono/bun`、`@hono/deno`、
  `@hono/cloudflare-workers`、`@hono/vercel`、…）；非 `Error` 的抛出
  不再逃出 `app.fetch()`——会被包进 `Error` 送进 `onError`（原值在
  `c.error.cause` 上）；通配符匹配增加路径中段的段后缀形式
  （`/x*/y`），且在各路由器间行为一致；而**响应校验**进入了 v5 清单
  （已在清单中勾掉；`@hono/zod-validator` 0.8 已把 400 分支的类型
  传进 RPC 客户端）——这正是 s200 的 `response-check` battery 今天
  已覆盖的轴。s200 在同几个维度上的对照：双格式 ESM+CJS 发布（CI 中
  以 attw 档案校验）、Node ≥ 20.3、适配器作为第一方子路径入口
  （`s200/node`、`s200/bun`），无需一次 major 就已经存在。
- **Elysia v2 RC**（[RC
  公告](https://next.elysiajs.com/blog/elysia-20-rc/)、
  [releases](https://github.com/elysiajs/elysia/releases)）：1.4.x 线
  只修安全问题；2.0.0-rc.0（2026-10-19）主打内存——无 validator 时
  每路由 10.7 kB（Hono 16、Fastify 26.7），TypeBox 下 16 kB
  （Fastify 93.3）——外加更快启动、可 tree-shaking 的模块、AOT 编译，
  以及静态推断的全部错误响应自动流入 Eden/OpenAPI。有两处方向修正值得
  注意：Node 适配器重建于 srvx + crossws 之上（与 h3 同一块地基），
  生命周期 API 则保留了 1.x 的 `on` 前缀，存量插件无需重写即可进入
  v2。重写成本由维护者而非用户支付；s200 给出的选项则是根本不付这
  笔钱——`sideEffects: false`、54 个可 tree-shaking 的包入口、以及
  为每次发布把关的 size-limit 预算，从第一天起就是这个包的形状。
- **Fastify v6——跳票**（[v6
  规划](https://github.com/fastify/fastify/issues/6834)、
  [里程碑](https://github.com/fastify/fastify/milestone/6)）：计划是
  7 月出 alpha、9 月发 stable；截至 2026-10-21 这条线仍停在
  6.0.0-alpha.5。v6 里确实有的：Node 最低版本提到 v24，以及
  [“序列化前用 Ajv 校验响应”](https://github.com/fastify/fastify/issues/4653)
  终于进了 v6 里程碑（#6507 以移除 fast-json-stringify 为代价换取它）
  ——响应契约检查，正是 s200 的 `response-check`
  battery 今天针对 `SerializeSchema` 契约提供的东西。稳定线按
  [LTS 政策](https://fastify.dev/docs/latest/Reference/LTS/)停留在
  v5.12.x，而各 alpha 主打每请求成本削减——优化的 header 处理、字符串
  body 只解码一次、已解析 content-type 的缓存。每请求成本正是 s200
  的 opt-in light 模式挣得 ~1.4× 的那条轴（fastify 直接接管裸
  `IncomingMessage`，本来就不付 undici 的构造税）。
- **安静的在位者**（[Express
  releases](https://github.com/expressjs/express/releases)、[Koa
  releases](https://github.com/koajs/koa/releases)）：Express 5.3.0
  （2026-10-09）让这台 ~87M 周下载的机器继续缓慢而稳定地维护着——
  它仍是许多人的默认选择，也是其余一切框架的迁移来源。Koa 3.2.1
  （2026-05-21）
  节奏更慢但活着——3.2 加入了 V8 startup snapshot 支持。两者已不再
  移动任何对比轴；它们是迁移指南存在的原因。

## 更广阔的 2026 战场

读这张表的参照系：TypeScript 服务端生态在 2026 年围绕少数几个共享层
完成收敛，s200 对它们全部即插即用，而非正面竞争。

- **[Standard Schema](https://standardschema.dev) 赢下了校验层。**
  zod、valibot、arktype、effect、TypeBox 全部实现该接口；tRPC v11、
  TanStack Form、React Hook Form 都在消费它。s200 的 `validate` 门与
  `response-check` 契约接受任意 Standard Schema 值——不绑定任何
  schema 供应商。
- **[TypeScript 7
  发布](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)**——
  原生 Go 移植，全量构建快 8–12×。深度的类型层推断不再是编译期奢侈品；
  Elysia 2 的整路由错误推断正建立在这份余量之上。
- **[Effect 4.0](https://effect.website/blog/releases/effect/40)** 重建于
  零依赖的 ~7.1 kB 核心之上，`@effect/platform` 的 HttpRouter 在 Node
  上约 90k req/s——“一切皆类型”的技术栈如今在性能上有竞争力，而不
  是一笔税。
- **[TanStack Start 1.0](https://tanstack.com/blog/tanstack-start-1-0)**
  （2026-10-13）把类型化 server function 变成主流原语，类型安全 RPC
  （[tRPC v11](https://trpc.io)、oRPC）持续上升——它们在底层要的是同
  一样东西：一个类型化的、可移植的 HTTP 后端。
- **[MCP](https://modelcontextprotocol.io)** 成为 LLM 集成的事实标准
  （[TypeScript SDK v2
  stable](https://github.com/modelcontextprotocol/typescript-sdk)）；
  框架横评已把 MCP 支持列为对比维度。
- **OpenAPI 3.1 工具链成熟**：
  [openapi-typescript](https://github.com/openapi-ts/openapi-typescript)、
  [Scalar](https://github.com/scalar/scalar) 与
  [Stainless](https://stainlessapi.dev) 能把一份 spec 变成类型、文档
  和 SDK。

s200 在这片战场里的位置是刻意收窄的：一个**纯 API/数据服务器**——
不是 RPC 层，也不是 meta-framework。上面这些层是互补关系：它们需要
类型化的 HTTP 后端，而 s200 的路由表原生产出
[OpenAPI 3.1](./api/openapi.md)，同一条工具链直接接入（经
`s200/swagger` 上 Scalar，经 `s200/codegen` 生成类型化客户端）——
不必为了得到它而采纳一个全栈框架。

## 迁移指南

- [从 Express 迁移](./migration-from-express.md)
- [从 Koa 迁移](./migration-from-koa.md)
- [从 Hono 迁移](./migration-from-hono.md)

## 原始数字

见[基准测试](./benchmarks.md)——同一台机器、同一客户端、每个框架一个
进程，附方法论注意事项。
