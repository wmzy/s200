# 熔断器（`s200/circuit-breaker`）

以纯数据 + 函数实现的熔断器：滑动窗口内被准入调用的失败达到阈值后，熔断器跳闸为 `open`，在冷却期内拒绝调用，随后放行有限数量的探测（`half-open`）—— 任一被计数的失败立即重新跳闸，连续成功若干次则重新闭合电路。为包裹反向代理发起的上游调用而生（见 `s200/proxy` 的[熔断一节](./proxy.md#circuit-breaking)），但它可以守护任何异步操作 —— 数据库调用、子服务 fetch、任何可能连续失败的东西。

状态是由 `createCircuitBreaker` 创建的一个可变数据对象；所有函数围绕它操作。全程无锁：JavaScript 每个事件循环一次只执行一个调用，且每次相位转移都同步发生在某个 `canPass`/`record*` 调用内部 —— 并发调用者只在他们自己的 `await` 点（被包裹的 `fn`）交错，而那时准入早已判定完毕。

## `createCircuitBreaker` —— 作为数据的机器 {#createcircuitbreaker}

```ts
import { createCircuitBreaker } from 's200/circuit-breaker';

const upstream = createCircuitBreaker({
  failureThreshold: 5,
  windowMs: 10_000,
  cooldownMs: 30_000,
});
```

构建一个处于 `closed` 相位的熔断器。选项在此校验 —— 非正数抛出普通 `Error` —— 并冻结到状态的 `options` 上；之后不再二次校验。所有时间戳都在注入时钟的坐标系里（默认为 epoch 毫秒）。

| `CircuitBreakerOptions` | 含义 | 默认 |
| --- | --- | --- |
| `failureThreshold` | `windowMs` 内被准入的失败数，达到即跳闸为 `open` | `5` |
| `windowMs` | 滑动失败计数窗口（毫秒）—— 一次失败在落地恰好此时长后过期，计数不会在窗口边缘被突发击穿 | `10_000` |
| `cooldownMs` | `open` 拒绝多久后才放行探测 | `30_000` |
| `successesNeeded` | 连续多少次探测成功可闭合 `half-open` 熔断器 | `2` |
| `probeConcurrency` | `half-open` 期间并发准入的探测数 | `1` |
| `errorFilter` | 失败过滤器 —— 返回 `false` 则透传、不累计 | 每个抛出值都计数 |
| `now` | 时钟注入（测试、确定性回放） | `Date.now` |

## `breakerCall` —— 一行式调用面 {#breakercall}

```ts
import { breakerCall } from 's200/circuit-breaker';

const body = await breakerCall(upstream, () => fetch(upstreamUrl).then((r) => r.text()));
```

把一个异步调用包进熔断器的策略。准入：被拒绝的调用根本不会执行 `fn` —— 拒绝是一个 503 `HttpError`（`{"error":"Service Unavailable"}`），携带 `Retry-After` 为剩余冷却秒数（`half-open` 的槽位拒绝回答 `1` —— 是探测在外，不是冷却未到）。在应用内它会像 `s200/rate-limit` 的 429 一样流入错误边界：`onError` 可以接管，被包裹的工作从未运行。

结果：成功时值原样透传；失败时底层错误原样透传 —— 熔断器（经 `errorFilter`）记录它，但绝不翻译、包裹或吞掉它。

## `canPass` + `recordSuccess`/`recordFailure` —— 无抛出的调用面 {#canpass}

```ts
import { canPass, recordFailure, recordSuccess } from 's200/circuit-breaker';

if (canPass(upstream)) {
  try {
    const value = await load();
    recordSuccess(upstream);
    return value;
  } catch (error) {
    recordFailure(upstream, error);
    throw error;
  }
}
return fallback(); // your answer, no 503 involved
```

给想要策略但不要 503 的调用者 —— 自己的兜底响应、排队或丢弃。`canPass` 是同步探测：`true` 表示现在可以调用；在 `half-open` 中返回 `true` 会预留 `probeConcurrency` 个槽位之一 —— 每个被准入的调用必须恰好用一次 `record*` 结算，否则槽位会一直漏到下次跳闸。`recordFailure` 返回该错误是否被计数（过滤器的裁决）；被过滤掉的错误仍会释放其探测槽位，只是不累计。

## `skipClientErrors` —— 容忍 4xx 的过滤器 {#skipclienterrors}

```ts
import { createCircuitBreaker, skipClientErrors } from 's200/circuit-breaker';

const upstream = createCircuitBreaker({ errorFilter: skipClientErrors });
```

现成的 `errorFilter`：客户端导致的 `HttpError`（status < 500）不计数 —— 上游回答了那个请求，并没有失败 —— 而 5xx 应答、网络错误与普通异常都计数。与 `s200/proxy` 的经典搭配：被代理的 404 是调用方的真相，不是上游要死了。

## `circuitStatus` —— 面板与日志 {#circuitstatus}

```ts
import { circuitStatus } from 's200/circuit-breaker';

const { phase, failures, successes, probesInFlight, openedAt, retryAtMs } =
  circuitStatus(upstream);
```

对活机器的一次冻结快照 —— 即此刻 `canPass` 会看到的相位（已应用惰性的 `open` → `half-open` 转移），外加面板要的计数：窗口内失败数、half-open 连续成功数、在外探测数、最近一次跳闸的 epoch、以及调用重新被准入的最早 epoch。它是报告而非状态：改它什么都改变不了。

## 语义 {#semantics}

- **三相。** `closed` 放行一切，并在滑动 `windowMs` 窗口内累计被准入的失败；达到 `failureThreshold` 跳闸为 `open`。`open` 在 `cooldownMs` 流逝前什么都不放行。`half-open` 最多放行 `probeConcurrency` 个探测：任一被计数的失败立即重新跳闸为 `open`（冷却重新计时），连续 `successesNeeded` 次成功则带着全新的失败窗口闭合熔断器。
- **窗口滑动，成功从不抹除。** 一次失败在落地恰好 `windowMs` 后过期（无固定边界 —— 不会在窗口边缘被突发击穿）；`closed` 中的成功是空操作。探测后的闭合会清空窗口：新的 `closed` 时代从零开始。
- **`open` → `half-open` 是惰性的。** 没有定时器触发；冷却流逝后第一个 `canPass`/`record*`/`circuitStatus` 才是转移相位的那一个。没有流量时熔断器名义上保持 `open`，零成本。
- **准入基于槽位。** `canPass` 在 `half-open` 返回 `true` 即预留一个槽位；配对的 `record*` 释放它。永不结算的探测（挂死的调用）会漏掉它的槽位 —— 配合超时电池，让每个被准入的调用都恰好结算一次。
- **迟到的探测。** `probeConcurrency` > 1 时，在兄弟探测已重新跳闸之后才结算的探测，按它结算时活着的相位计数。并发下要精确记账就把并发度保持为 `1`（默认值）。
- **被过滤的错误仍结算准入。** `errorFilter` 只裁决失败是否累计；已经发生的调用的记账永远不会被跳过。
