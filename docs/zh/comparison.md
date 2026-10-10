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
| 运行时 | Node、Bun、经核心直达 Deno/edge | 一切运行时 + 适配器矩阵 | 仅 Node | 仅 Node | 仅 Node | Bun 优先；Node/web-standard/Cloudflare 经适配器 |
| 中间件模型 | koa 洋葱模型，链内错误边界 | hono 洋葱模型 | connect 风格 | 钩子系统 | koa 洋葱模型 | 生命周期钩子（derive/resolve）+ 插件 |
| 路由器 | 静态前缀 trie，每个静态段都有索引 | RegExpRouter / TrieRouter | path-to-regexp | find-my-way radix | koa-router（path-to-regexp） | 静态映射 + memoirist radix，JIT 编译的处理器 |
| 可选参数 `:id?` | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| 从路径模式字面量定型参数 | ✅ `ParamsOf` | ✅（推断） | ❌ | ✅（typebox schema） | ❌ | ✅（推断） |
| 从应用出发的类型化 HTTP 客户端 | ✅ 路径 + 参数 + query + JSON 体 + 状态/错误分支，`res.json()` 由 `res.status` 判别 | ✅ `hc`（完整 RPC） | ❌ | ❌ | ❌ | ✅ Eden treaty（完整 RPC） |
| 路由移除 | ✅ `removeRoute` | ❌ | 部分 | ❌ | ❌ | ❌ |
| 路由表作为数据 | ✅ 可导出 JSON + OpenAPI | ❌ | ❌ | ✅ | ❌ | ❌ |
| 适配器内的 HTTPS / HTTP/2 | ✅ | ✅ | ✅ | ✅ | 第三方 | 经运行时（Bun.serve） |
| WebSocket | ✅ 零依赖 RFC 6455 node + bun（子协议、permessage-deflate、心跳） | ✅ | 第三方 | 第三方 | 第三方 | ✅ 内建 `.ws()`（Bun API；node 上为 crossws） |
| battery | 45 个 opt-in（cors、cookies、csrf、jwt、cache、etag、compress、rate-limit、session、upload、…） | ~20 个（含 csrf/jwt/cache） | 生态 | 插件生态 | 生态 | ~15 个官方插件（openapi、jwt、cors、rate-limit、…） |
| 吞吐量类别（见基准测试） | Web 标准对象类别；opt-in light 模式 ~1.3–1.4× | 同类（patched：1.5×） | ~0.6× | patched 类别 | 更低 | patched 类别；在 Bun 上居其榜首 |
| 核心体积（min+gz） | 由 size-limit 门控：~4 kB 最小核心 / ~8 kB 完整 barrel | ~10 kB+ | — | — | 极小，无 battery | 解包 1.1 MB；141 kB min 的 hello-world（v2 beta） |
| 校验集成 | 覆盖任意解析器的通用门 | 内建 zod/valibot/typebox | 生态 | 原生 JSON Schema | 生态 | 内建 TypeBox（`t`）+ standard schema |
| OpenAPI | ✅ 从路由表原生 3.1 | zod-openapi（依赖） | ❌ | swagger 插件 | ❌ | ✅ 插件（Scalar/Swagger UI） |
| JSX / SSG / 开发服务器 | ❌（经 `s200/dev` 的路由表热重载） | ✅ | ❌ | ❌ | ❌ | ❌（html 插件） |
| 生态规模 | 年轻 | 庞大 | 非常庞大 | 庞大 | 庞大 | 快速增长（使用量第 9，SoJS 2025） |

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
更高。交换条件则是镜像：应用是一条不透明的类链，而非数据加函数——
离开框架它既不能导出为 JSON 也不能被检视——而且没有成文的路由移除
API。核心解包后 ~1.1 MB，带 [4 个运行时
依赖](https://www.npmjs.com/package/elysia)（TypeBox 以 peer 形式发布），
Bun 之外的一切（node、web-standard、Cloudflare Workers）都要走适配器
而非 Hono 那套久经考验的矩阵——Deno/edge 方面无可奉告，中间件是
[生命周期钩子](https://elysiajs.com/essential/life-cycle)（derive/
resolve），不是 s200 与 Koa 共享的洋葱模型。如果你的目标是 Bun，并且
想要带服务端 schema 的 tRPC 级推断，Elysia 是理性之选；s200 押注的
则是运行时无关的数据 + 函数。

## s200 赢在哪里

- **零依赖**，连 WebSocket 服务器也算在内——没有 undici/
  hono-node-server 桥接，没有 ws，没有 path-to-regexp。
- **链内错误边界**：抛错的路由处理器在中间件 unwind *之前*就被映射为
  响应，因此 logger/cors/request-id 盖章的是真实的 404/405/500。
  Express 需要一个最后注册的错误中间件；Hono 的 `onError` 位于链外。
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

## 迁移指南

- [从 Express 迁移](./migration-from-express.md)
- [从 Koa 迁移](./migration-from-koa.md)
- [从 Hono 迁移](./migration-from-hono.md)

## 原始数字

见[基准测试](./benchmarks.md)——同一台机器、同一客户端、每个框架一个
进程，附方法论注意事项。
