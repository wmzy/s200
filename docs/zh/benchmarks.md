# 基准测试

两个基准测试，都可以在本地运行，也都如实说明各自测量的是什么：

- `pnpm bench` —— 单独测量路由器分发（`scripts/bench-router.mjs`）：把
  一个 pathname 与路由表相匹配的成本，脱离上下文测量。
- `pnpm bench:http` —— 整请求吞吐量（`scripts/bench-http.mjs`）：
  用 keep-alive HTTP 客户端压每个框架的真实服务器，测量从
  socket accept 到响应排空的一切。

## 整请求吞吐量

```
node v22.23.2 | concurrency=32 requests=30000/scenario

s200          hello     9254 req/s   param     9095 req/s
s200-light    hello    11844 req/s   param    11744 req/s
hono          hello    10067 req/s   param     9956 req/s
hono-patched  hello    14130 req/s   param    13762 req/s
express       hello     6476 req/s   param     6355 req/s
fastify       hello    14115 req/s   param    14064 req/s
elysia        hello    14420 req/s   param    14135 req/s
s200-deno  not measured on the reference machine (auto-skipped: deno not installed)
```

机器：AMD Ryzen 7 8745HS，Fedora 42，Node 22.23.2，2026-09-21。
`pnpm bench:http` 在干净的子进程里重新运行每一行。

场景：

- `hello` — `GET /` → `{ "message": "hello" }`
- `param` — `GET /users/:id` → `{ "id": "42", "name": "ada" }`

### `s200-deno` 场景

`pnpm bench:http` 还认识第八个场景 `s200-deno`：**同一份构建出的核心**
（`dist/index.mjs`）通过 `Deno.serve` 提供服务。s200 的核心是纯 Web 标准
代码，因此同一个 bundle 无需适配器就能跑在 Deno 上。脚本会向操作系统
临时目录写入一个小入口文件（通过 `file://` URL 导入构建出的核心），
把它作为独立进程 spawn `deno run`，再用与其他每一行相同的 node
keep-alive 客户端去测量它——唯一的结构性差异是客户端与服务器分处
两个进程而非同一个。

当 `PATH` 上没有 `deno` 二进制时，该场景**自动跳过**：运行会打印一行
跳过信息（上面那一行就是来自参考机器的这条）然后继续；它绝不会让基准
测试失败。想启用它，请安装 [Deno](https://deno.com) ≥ 2.x 并重新运行
`pnpm bench:http`。

读数：

- **在真实 Web 标准路径上 s200 ≈ hono。** 这里的 `hono` 以
  `overrideGlobalObjects: false` 运行 `@hono/node-server`——即真实的
  `Request`/`Response` 对象，也正是 s200 默认使用的东西。同一类别之内，
  s200 赢 `param`，hono 赢 `hello`。
- **`s200-light` 是 opt-in 的快速路径**（`serve(app, { light: true })`）：
  node 适配器构造轻量的 `Request`/`Response` 对象（不 patch 任何全局
  东西），并把字节背书的响应体直接写进 socket。它比默认类别高出约
  1.3×，在真实 Web 标准对象上比 hono 快约 18%——与 patched 类别之间
  剩下的差距来自 `Headers` 构造和适配器下限。
- **`hono-patched` 是 hono 默认的快速路径**：适配器用它自己的极简类替换
  全局 `Request`/`Response`。在真实 Web 标准对象上它比两个框架都快约
  1.5×——这笔成本按请求计在 undici 功能齐全的 `Request`/`Response`
  构造器里，而不是在路由或分发里。s200 不 patch 全局：默认契约就是平台
  的 `Request`/`Response`，opt-in 的 light 模式用更窄的适用范围为速度
  买单（见 README）。
- **`fastify` 和 `elysia` 落在与 `hono-patched` 相同的 ~14k 类别**：
  fastify 直接搬运原始 `IncomingMessage`（完全没有 Web 标准对象），
  elysia 的 srvx 适配器自带轻量 request 类。两者都以 hono 的 patch 和
  s200 的 light 模式同款的方式避开了 undici 的构造器成本——在本次基准
  测试里，这笔成本就是两个类别之间的全部差距。
- **express 落后于两者**——它的路由（path-to-regexp）与每请求的流式
  管道成本在饱和时大约翻倍。

## 路由器分发

```
routes=200 iterations=100000 (min of 3 rounds)
first hit        0.44 µs/req   x1.0
last hit         0.49 µs/req   x1.1
miss             0.19 µs/req   x0.4
param-first      0.45 µs/req   x1.0

routes=2000 iterations=100000 (min of 3 rounds)
first hit        0.46 µs/req   x1.0
last hit         0.48 µs/req   x1.0
miss             0.19 µs/req   x0.4
param-first      0.46 µs/req   x1.0
```

从 200 条到 2000 条路由，分发成本是平坦的：遍历只访问请求自身各段
拼写出来的那些 trie 节点，因此表的大小从不进入热路径。（更早的快照
曾显示 2000 条路由时 2.2 µs——那是 2 万次迭代 GC 噪声造成的伪影；
上面的运行用 10 万次迭代，各轮之间稳定。）

`param-first` 是其他 trie 路由器会退化的形状（`/:tenant/resourceN`
风格）；s200 的索引以每个静态段为键，因此匹配成本随 URL 深度走，
而不是随路由条数。残留的线性场景是一张完全没有静态段的表
（`/:a/:b/:c`）。

## 方法论注意事项

- 同一台机器、同一客户端（`node:http` keep-alive agent）、相同载荷，每个
  框架一台服务器，先预热。数字是快照而非保证——请在你自己的硬件上重跑。
- 所有服务器都运行在独立的子进程里，任何框架的全局 patch 都不会污染
  对别家框架的测量。
- `hello`/`param` 两行是零中间件的双路由应用：它们测量的是分发 + 适配器
  下限，不是中间件密集的负载。后面的 `mw` 场景（见最后一节）覆盖中间件
  一侧；那两行保持 `hello`/`param` 无中间件。往脚本里加你自己的路由，
  来建模你自己的流量。
- 这不是 TechEmpower 式的测试装置（没有多核争用建模，没有内核调优）。
  用它做相对比较，别用来做容量规划。

## 2026-09-29 更新（LightHeaders + 默认 disconnect-abort）

后来的两项变更在另一台机器上（Node 26，同一会话内先后对比，因此相对
增量依然成立，尽管绝对数字与上面的参考表不可比）改变了 s200 各行的
位置：

- **`LightHeaders`** —— light 路径的请求/响应头现在是一个鸭子类型的
  `Headers`（大小写不敏感、按插入排序、线上输出一致），用一次按 pair
  建索引的构建替换了每请求两次 undici `Headers` 构造。`s200-light`
  拿到 **+5.8%（hello）/ +4.0%（param）**；light 对正常的比值从
  ~1.23–1.26× 升到 **~1.35×**。
- **默认 disconnect-abort** —— `ctx.signal` 现在开箱即在客户端断连时
  中止（`abortOnDisconnect: false` 可恢复旧的共享永不中止 signal）。
  每请求的 `AbortController` + socket 监听器在双路由下限上花费
  **~7.7%**；每个框架行都为其自己的断连策略付费，因此把此变更之前
  测得的跨框架增量看作少付了一个策略。

## 2026-09-29 补充（light 模式覆盖扩展）

light 路径的表面覆盖被扩展并由测试钉住——普通 `stream` 响应、对流式
light 响应体施加的 `compress`、全部 `serveStatic` 形态（字节体、
`stream: true` 文件、`readRange` 206、HEAD/304/416/301），以及对 light
请求施展的请求体读取器（`readJson`/`readText`/`readForm`/
`readStream`，见 `test/light-batteries.test.ts`）。这些都不触碰
`hello`/`param` 热路径（`json()` 的字节快速路径），因此吞吐量如预期
持平——同一会话快照，Node v26，针对 s200 各行：

```
s200          hello    10768 req/s   param    10639 req/s
s200-light    hello    15016 req/s   param    14638 req/s
```

light 对正常的比值保持在 **~1.39×（hello）/ ~1.38×（param）**，与
`LightHeaders` 之后的 ~1.35× 相符（机器噪声）。覆盖工作浮出并修复了
一个真实 bug：针对流式静态文件的 HEAD 请求会宣告 `content-length: 0`
（两种模式皆是）——`serveStream` 现在让由 stat 得出的大小得以存活
（`handle` 的 HEAD 改写随后剥掉响应体）。

## 2026-09-30 更新（light 路径上的惰性请求头）

light 路径不再为没人读的头付费：`LightHeaders` 现在**惰性**构建它的
索引——node 适配器按引用把 `req.rawHeaders` 递给它（中间的 pairs 数组
没了），slot/index 机制在首次结构性访问（`get`/`set`/迭代/…）时才
物化。一个处理器从不碰 `req.headers` 的请求——`hello`/`param` 正是
这个形状——什么也不构建。响应侧拿到了 `fillRecord`，一个面向
`writeHead` 的直接 slots→record 填充（替换掉对同一数据的 `forEach`
闭包）；http2 伪头过滤和每一个线上可见的语义（大小写不敏感、插入
顺序、`", "` 合并、不合并且 `set-cookie`）都由
`test/light-batteries.test.ts` 钉住。

如实测量，因为墙钟看不见它：官方基准客户端在这台机器上于 ~14.5k
req/s 附近饱和（一个独立的 keep-alive 客户端把同一台 `s200-light`
服务器打到 25–26k），因此 `hello`/`param` 的墙钟时间受**客户端制约**
且保持平坦。服务端信号是每请求 CPU，用交错的同条件 A/B 运行来测量
（10 对，未变更的 `s200` 行作为漂移对照）：

- **服务端 CPU/请求 −6.3%（中位数）**，10 对里 9 对 lazy 更快；
- **`mw` 墙钟 +3–4%**（`fillRecord` 随响应头数量扩展，且链会读一个
  请求头——惰性构建在那里也回本了）；
- light 对正常的比值在 `hello` 和 `mw` 上都保持在 **~1.43×**。

## 中间件密集场景（2026-09-30）

`scripts/bench-http.mjs` 长出了第三个场景 `mw`（`--only mw` 单独运行
它）：与 `hello` 相同的 `{"message":"hello"}` JSON 路由，但要经由一条
五环中间件链才能抵达，链上每一环都

- 读取 `x-test` 请求头，
- 在 unwind 时设置自己的响应头，
- 并且——在第三环——把一个 `performance.now()` 增量存进每请求上下文。

在每个框架里该链都限定在 `/mw`，因此 `hello`/`param` 两行继续测量
无中间件的下限，而 `mw` 行相对 `hello` 的增量就把链本身隔离了出来。

与参考表同一台机器（AMD Ryzen 7 8745HS，Fedora 42），如今跑在
**Node v26.10.0** 上——绝对数字与上面 Node 22 的参考不可比。本表是
针对 **2026-09-30 最终 dist** 的权威运行（含惰性 light 头；更早一次
pre-lazy 运行的排序一致，`mw` 各格在 ~±4% 之内，`s200-light mw`
低约 4%）：

| 框架          | hello（同次运行） | mw      | mw 对 hello |
| ------------- | ---------------- | ------- | ----------- |
| s200          | 10308 req/s      | 9590    | −7%         |
| s200-light    | 14760 req/s      | 13718   | −7%         |
| hono          | 12278 req/s      | 10250   | −17%        |
| hono-patched  | 17904 req/s      | 9313    | −48%        |
| express       | 11840 req/s      | 10841   | −8%         |
| fastify       | 17590 req/s      | 16681   | −5%         |
| elysia        | 16846 req/s      | 15428   | −8%         |

`s200-deno` 自动跳过（这台机器上没有 `deno` 二进制，与参考运行相同）。
单个 `hello` 格逐次运行会有高达 ~±10% 的摆动，因此请把单格增量读作
近似值，把排序读作信号。

### 它测量什么——以及它不测量什么

该场景测量的是 **unwind 一条五环链的每请求成本**：链分发、每环一次
请求头读取和一次响应头写入、一次计时存储。它不重复测量适配器下限
——`hello` 已经测过了——这就是为什么快速类框架（`fastify`、`elysia`、
`hono-patched`）在绝对数字上稳居前列，尽管它们的中间件成本天差地别。

各框架的形态是每个框架惯用的中间件写法，保持工作量等价（相同的读取、
写入和计时存储）但并非机械相同，这份诚实在读表时很重要：

- **express**（`app.use('/mw', …)`）和 **fastify**（封装的 `register`
  作用域里的 async `onRequest` 钩子）把头写进一个存储，在响应序列化时
  应用。**elysia** 以同样的方式写 `set.headers`，只是放在
  `guard({ beforeHandle })` 里——它的 `onRequest` 钩子无法限定作用域
  （它们对整个实例触发，已验证），所以路由后钩子就是限定作用域的
  等价物。
- **hono**（`app.use('/mw/*', …)` 配 `await next(); c.header(…)`）和
  **s200**（`use(app, '/mw', …)` 配 `next()` 之后的
  `ctx.res.headers.set`）做的是真正的 unwind：它们在处理器跑完之后
  修改已经物化的响应。

这种不对称正是 `mw vs hello` 一列的故事。**fastify** 几乎不损失（各次
运行 ~0–5%）：它的钩子链就是向头存储追加的普通函数调用。**elysia**
（−8%）和 **express**（−8%）付出适度的链成本。**hono** 掉了 −17–18%：
`await next()` 之后的 `c.header()` 会重新物化响应——每写一个头就
一次——而在 patched 快速路径上这个重建成本压过其他一切：`hono-patched`
崩落 −46%，在中间件负载下落到*低于*未 patch 的 `hono`。**s200**（各次
运行 −7–9%）同样在处理器之后写头，但是原地修改既有 `Response` 的头
——不重建——尽管每请求上下文更丰富，仍落在 express 的邻域。

**s200-light** 自己的下限几乎未动（−7%，在 hello 格噪声之内），并在
中间件负载下把 light 对正常的比值保持在 **~1.43×**：light 路径廉价的
`LightHeaders` 写入，让链叠加在一个本已廉价的响应之上几乎免费。

与整请求一节相同的方法论注意事项同样适用——快照而非保证；每个子进程
一台服务器；请在你自己的硬件上重跑
（`node scripts/bench-http.mjs --only mw`）。
