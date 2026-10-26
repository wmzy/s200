# 负载脱落（`s200/load-shed`）

压力闸门式的准入控制 —— 扮演 `@fastify/under-pressure` 的角色，零依赖、无后台定时器。`loadShed()` 在入口检查可选阈值 —— 事件循环利用率、常驻内存、进行中请求数 —— 任一已配置维度严格越限时，向应用的错误边界抛出 `503` `HttpError`（`{"error":"Service Unavailable"}`，附带 `Retry-After` 建议头）：handler 不再执行，过载的单元把剩余预算花在已接纳的请求上，而不是排队更多。

```ts
import { loadShed } from 's200/load-shed';

use(app, loadShed({
  maxEventLoopUtilization: 0.95,
  maxRssBytes: 512 * 1024 * 1024,
  maxInFlight: 200,
  retryAfterSeconds: 2,
  bypass: (ctx) => ctx.url.pathname === '/healthz',
}));
```

## 判定方式

- 检查发生在入口、`next()` 之前。**第一个**严格越限的已配置维度触发脱落；恰好等于阈值的读数放行。
- 未配置阈值的维度不检查 —— 连它的传感器都不会被读取。
- 进行中计数是**台账而非采样**：入口加一，请求结算（handler 正常返回、handler 抛错、或被脱落成 503）时在 `finally` 里减一。到来的请求自身也计数 —— `maxInFlight: 200` 放进第 200 个并发请求、脱落第 201 个 —— 且链排空的那一刻计数即恢复。
- `bypass` 跳过整道闸：该请求既不计数也不检查。脱落掉存活探针等于在单元最需要喘息的时刻告诉平台它已经死了。
- 与所有 s200 闸门一样，503 在链内物化，因此注册在它外层的中间件（logger、cors、request-id）在回卷时看到的是真实状态码；配置了 `onError` 时由策略接管线上应答。

`Retry-After` 是建议而非承诺：没有传感器就无法预知压力何时解除，所以该头携带 `retryAfterSeconds`（默认 `1`），尊重它的客户端退避一个间隔再重试。

## `LoadShedOptions`

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `maxEventLoopUtilization` | — | 事件循环繁忙比严格高于此值（0..1）时脱落 |
| `maxRssBytes` | — | 常驻内存字节数严格高于此值时脱落 |
| `maxInFlight` | — | 进行中计数严格高于此值时脱落（到来的请求自身计数） |
| `retryAfterSeconds` | `1` | 503 上的 `Retry-After` 头，秒数（正整数） |
| `bypass` | — | `(ctx) => boolean` —— 为 `true` 时该请求既不计数也不检查 |
| `sensors` | 内置 | 按维度覆盖读数来源 —— 见 `LoadShedSensors` |

非法边界值在创建时抛普通 `Error`（坏阈值是程序员错误，不是要上报的运行时故障）：`maxEventLoopUtilization` 必须落在 `(0, 1]`，`maxRssBytes`/`maxInFlight` 必须为正，`retryAfterSeconds` 必须为正整数。

## 传感器

每个维度的读取函数都可注入 —— 测试用假读数驱动闸门而不制造真实负载，多实例部署可以让所有分片指向同一个共享计数器。`LoadShedSensors`：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `eventLoopUtilization` | 增量式 `performance.eventLoopUtilization()` 差分 | `() => number` —— 自上次检查以来的繁忙比 0..1；读数恰好覆盖请求之间的间隙（或其间后台工作所占的部分），没有定时器唤醒事件循环，零流逝的差分读作 `0` 而非 `NaN` |
| `rssBytes` | `process.memoryUsage().rss` | `() => number` —— 常驻内存字节数 |
| `inFlight` | 中间件自己的台账 | `() => number` —— 当前进行中的请求数；注入它以执行上游计量的、或跨实例共享的并发上限（内部台账无论如何都在运行） |

一维度一传感器让接线保持局部 —— `s200/unit-metrics` 的度量包本来就测这三样，它的 `snapshot()` 用三个 lambda 即可桥接进来：

```ts
import { createUnitMetrics } from 's200/unit-metrics';
import { loadShed } from 's200/load-shed';

const m = createUnitMetrics();
use(app, m.middleware);
use(app, loadShed({
  maxEventLoopUtilization: 0.95,
  maxRssBytes: 512 * 1024 * 1024,
  sensors: {
    eventLoopUtilization: () => m.snapshot().eventLoopUtilization,
    rssBytes: () => m.snapshot().rss,
    inFlight: () => m.snapshot().inFlight,
  },
}));
```

## 保住探针

把 `bypass` 与 health 电池的 `createGate` 组合起来，探针在压力下与优雅排空期间都保持可应答 —— 脱落流量与排空连接是两种不同的紧急情况，而探针必须同时熬过两者：

```ts
import { createGate, health, readiness } from 's200/health';
import { loadShed } from 's200/load-shed';

const gate = createGate();
use(app, loadShed({
  maxEventLoopUtilization: 0.95,
  bypass: (ctx) =>
    ctx.url.pathname === '/healthz' || ctx.url.pathname === '/ready',
}));
get(app, '/healthz', health);
get(app, '/ready', readiness({ gate: gate.check }));
```

## 已知限制

- 默认 ELU 读数是相邻两次检查之间的差分 —— 新鲜度与流量一致。完全无请求的单元不会重读它，因此纯后台饱和要等第一个请求真的到来才触发（差分恰好覆盖那段繁忙间隙），不会更早。
- 默认传感器是进程内的。需要跨实例成立的上限必须注入由共享事实源支撑的传感器。
