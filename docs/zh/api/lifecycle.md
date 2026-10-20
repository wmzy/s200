# 生命周期、健康、超时与热重载（`s200/lifecycle`、`s200/health`、`s200/timeout`、`s200/dev`）

优雅停机、存活/就绪探针、请求超时、路由表在线替换，以及开发期 404 提示。

## 生命周期（`s200/lifecycle`）

NestJS 的 `enableShutdownHooks` + `onApplicationShutdown` 等价物：`stop()` 与 OS 信号共享同一条优雅排空路径。顺序是负载均衡器安全的：先翻就绪闸门（探针转 503、流量停止到达），然后停止接受新连接、在预算内等待在途请求、强杀拖尾者，最后才运行应用自己的 `onShutdown`。

```ts
import { lifecycle } from 's200/lifecycle';
import { createGate } from 's200/health';

const gate = createGate();
const handle = lifecycle(server, { readiness: gate, onShutdown: () => pool.end() });
await handle.stop();        // 或：SIGTERM / SIGINT
```

`lifecycle(server, options?)` → `LifecycleHandle`：

| 成员 | 含义 |
| --- | --- |
| `stop()` | 开始（或加入）排空 —— 与信号同一条路径，幂等 |
| `stopped` | 排空落定后 resolve —— 绝不拒绝：信号路径的 `onShutdown` 失败改为 `console.error` |

`LifecycleServer`：`{ close(): Promise<void>; server?: unknown }` —— 每个适配器的 `serve()` 结果都结构性地满足它；原始 `server`（适配器暴露时）解锁优雅路径。运行时无关的鸭子类型：带 `closeIdleConnections` 的原始服务器（node http/https/http2）获得 `close()` 加持续空闲回收 —— 一次性回收会漏掉排空中途转空闲的 keep-alive socket —— 然后在截止时 `closeAllConnections()`；带 `stop` 的原始服务器（Bun）获得 `stop(false)` 优雅 / `stop()` 强制；其他一切回退到适配器自己的 `close()`。

`LifecycleOptions`：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `signals` | `['SIGTERM', 'SIGINT']` | 触发与 `stop()` 同一排空的信号；`[]` 把信号处理留给自己。排空**期间**的第二个信号立即强杀 |
| `timeout` | `10_000` | 排空预算（毫秒） —— 在途请求获得此时长，之后其连接被强制关闭 |
| `readiness` | — | 作为第一步翻为关闭 —— 传 `s200/health` 的 `createGate()`（结构性的：任何带 `close(reason?)` 的都行） |
| `onShutdown` | — | 连接排空后（或预算到期后）运行 —— `onApplicationShutdown` 钩子 |

信号监听器在排空落定后移除 —— 无泄漏、无第二个生命周期争抢同一进程。

## 健康（`s200/health`）

NestJS Terminus 等价物：`health` 是存活探针（能应答的进程就是活的），`readiness` 在一个每检查预算下并发运行命名检查集，`createGate` 是 `s200/lifecycle` 在优雅排空中首先翻转的可复位开关 —— 排空一开始探针即 503，在任何 socket 关闭之前。

```ts
import { health, readiness, createGate } from 's200/health';
get(app, '/healthz', health);
get(app, '/ready', readiness({ db: () => pool.query('select 1') }));
```

| 函数 | 含义 |
| --- | --- |
| `health()` | 存活 handler：`200 {"status":"ok"}`，零依赖 |
| `readiness(checks, options?)` | 在一个每检查预算下并发运行每个命名检查；`200 {"status":"ok","checks":{…}}` 或 `503 {"status":"fail",…}` |
| `createGate()` | 可复位排空开关：把 `gate.check` 接进就绪探针、把 `gate` 本身接进 `lifecycle` |

`HealthCheck`：`() => void | Promise<void>` —— 健康时返回/resolve，不健康时以原因抛错/拒绝。`ReadinessOptions`：`{ timeout?: number }` —— 每检查预算（毫秒，默认 1000）；每个检查还与请求的 abort 信号竞速，因此挂死的依赖无法钉住 handler。失败原因截断到 200 字符。

响应体：`HealthBody` = `{ status: 'ok' }`（存活）；`ReadinessBody` = `{ status: 'ok' | 'fail'; checks: Record<string, string> }` —— 每个检查的结论是 `'ok'`，或其失败原因（超时、中止或抛出的消息，截断到 200 字符）。

`Gate`：`{ check(): void; close(reason?): void; open(): void }` —— 触发时 `check` 抛出关闭原因（探针报告它）；`close` 触发闸门；`open` 复位。

## 超时（`s200/timeout`）

把其余链与截止时间竞速。截止时间胜出时，其下链以 `503` `HttpError` 拒绝 —— 应用的错误路径渲染它，unwind 中间件（logger、cors）观察到真实状态。

```ts
use(app, timeout(5_000));
```

截止时间还会中止一个组合进 `ctx.signal` 的每请求 `AbortController`，供其下一切使用，因此协作式工作 —— 体读取（`readJson` 等取消流并以 `AbortError` 拒绝）、与 `ctx.signal` 竞速的 fetch —— 停止而非缓冲尸体。从不观察 `ctx.signal` 的工作 detached 继续跑（同 hono 的 timeout）；这只约束响应时间并宣告损失。`timeout(ms)` 对非正/非有限 `ms` 抛错。

## 热重载（`s200/dev`）

不重启服务器在线替换应用的路由表。这之所以可行，是因为 `App` 是可变数据对象 —— `serve` 永远持有同一个对象身份，而 `handle` 每请求重读其字段、组合链缓存按数组身份（冻结快照）版本化。原子替换字段把所有**新**请求切到新表；在途请求继续跑完捕获的旧链。仅 Node 入口（`node:fs` / `node:url`）。

```ts
import { createHotApp, importFresh, watchAndReload } from 's200/dev';

const hot = createHotApp(app);
const server = await serve(hot.app, { port: 3000 });
const handle = watchAndReload({
  dirs: ['./src/routes'],
  load: async () => (await importFresh('./src/routes/app.ts')).app,
  hot,
});
await handle.close();
```

| 函数 | 含义 |
| --- | --- |
| `createHotApp(initial)` | `{ app, reload(next) }` —— 稳定身份，`reload` 原子替换其表（路由、中间件、匹配器、error/404/logError 策略）；传相同引用的 reload 是 no-op |
| `importFresh(specifier)` | 绕过 ESM 缓存导入模块（在文件 URL 上盖 `?t=` 查询） —— 热重载的加载半边 |
| `watchAndReload(options)` | 监视 `dirs` 并在防抖窗口后通过 `load` 重载热应用；只有 `node_modules` 与点目录之外的源码文件（`.ts`/`.mts`/`.cts`/`.js`/`.mjs`/`.cjs`/`.json`）会触发重载，应用往被监视目录里写日志或数据文件不会自反馈触发重载；`load` 失败保留旧表并经 `onError` 报告；加载串行化 |

`WatchAndReloadOptions`：`{ dirs: readonly string[]; load: () => Promise<App<S>>; hot: HotApp<S>; debounceMs?（默认 50）; onError?（默认 `console.error`） }`。`WatchAndReloadHandle`：`{ close(): Promise<void> }`。

### 开发期 404 路由提示

`routeHints(app, options?)` 返回一个中间件，用路由表已知的信息装饰框架默认的 404 响应体 —— 一次未命中即告诉开发者表里有什么。它把应用当作数据传入（中间件只拿到 `(ctx, next)`；消费应用的电池以 `createRouteTable` 与 `createClient` 为先例），闭包持有存活的 app 对象，并在每个请求里重读 `app.routes` —— 热重载换表后无需重新注册。选项类型为 `{ limit?: number }`：全方法 `routes` 列表的最大条数，默认 3。

```ts
import { routeHints } from 's200/dev';

use(app, routeHints(app));
```

**永不覆盖规则**：只有响应体恰好解析为 `{"error":"Not Found"}`（`createApp` 回退的默认体）的 404 才会被装饰。自定义 `onNotFound`、抛出或返回的 `httpError(404)`（其信封为 `{"error":"HTTP 404 Not Found"}`）、或已被其他中间件改写的响应体都原样放行。装饰保持 404 状态与响应既有的响应头，并在默认形状 `{ error: 'Not Found', hint?: string, routes?: string[] }` 上至多新增一个字段（`hint` 或 `routes`，从不同时出现）。

排序无聊且确定：按与请求路径的位置静态段重合度排名（字面量段只在相同下标计分；参数与通配符从不计分），平局按注册顺序。方法兼容性沿用路由器的规则 —— 精确匹配、`'ALL'` 路由、以及 `HEAD` 请求视 `GET` 路由为同方法。

| 结果 | 响应体 |
| --- | --- |
| 某个同方法路由的重合度至少达到请求段数的一半 | `{ "error": "Not Found", "hint": "did you mean GET /users/:id?" }` |
| 没有任何同方法路由重合，但存在重合路由 | `{ "error": "Not Found", "routes": ["POST /users/:id", "POST /users/:uid"] }` —— 跨全部方法取前 `limit` 条，同一排序 |
| 两者皆否（仅有弱同方法候选，或毫无重合） | 原样不动 |

开发电池而非热路径：每个默认 404 体都会被克隆解析，每次未命中都扫描路由表 —— 开发期很便宜，生产环境纯属无谓开销。
