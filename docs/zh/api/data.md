# 数据与配置（`s200/cache`、`s200/config`、`s200/events`、`s200/schedule`）

响应缓存、类型化的快速失败配置、带类型的消息总线与 cron/interval 调度器。

## 缓存（`s200/cache`）

带 TTL + LRU 式驱逐与有界体大小的响应缓存。读穿透：未命中时运行其下链并存储可缓存响应；命中时 handler 永不运行。

```ts
use(app, cache({ ttl: 60, max: 1000 }));
use(app, cache({ store: redisCacheStore }));   // 跨实例共享
```

默认安全：仅 `GET` 的 200 且带体的响应被存储；携带 `Set-Cookie` 的响应永不缓存（缓存的会话 cookie 将会话泄漏），携带 `Authorization` 的请求永不被服务，请求的 `Cache-Control: no-cache` 强制重新验证。体在存储前被克隆，因此对发起请求的响应交付不受影响。

`CacheOptions`：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `ttl` | `60` | 条目寿命（秒） |
| `max` | `1000` | 最大条目数，超出驱逐最旧（仅进程内存储的事务） |
| `sizeLimit` | 1 MiB | 最大缓存体字节数 |
| `methods` | `['GET']` | 从缓存服务的方法 |
| `key` | `` `${method} ${pathname}${search}` `` | 自定义缓存键 `(ctx) => string` |
| `skip` | — | 额外跳过谓词（每次查找与存储前运行） |
| `store` | 有界进程内 Map，命中时刷新 | `CacheStore`（见下） —— 跨实例共享缓存 |

`CacheStore`：`get(key)`、`set(key, entry)`、`delete(key)` —— `get`/`delete` 可异步（网络化存储）；`set` 原子存储整个条目。`CacheEntry`：`{ exp, status, headers: [string, string][], body: Uint8Array }`。过期由中间件每次读取时检查；存储亦可提前驱逐。

## 配置（`s200/config`）

类型化的快速失败配置，基于 `s200/validate` 使用的同一 Standard Schema 通道。`parseEnv` 是纯 `.env` 解析器；`createConfig` 在**构造时**校验合并后的记录 —— 失败抛出聚合全部问题的单个 `Error`，因此错误部署在启动时死亡并带完整清单，而非首个问题。

```ts
import { parseEnv, createConfig } from 's200/config';
const { valid } = createConfig(schema, { ...parseEnv(await readFile('.env', 'utf8')), ...process.env });
// valid: schema.types.output —— 从此完全带类型
```

| 函数 | 含义 |
| --- | --- |
| `parseEnv(text)` | 纯 `.env` 解析器 → `Record<string, string>`：注释、空行、`export ` 前缀、带转义的引号值、重复键后者胜；不支持多行值 |
| `createConfig<S>(schema, input)` | 校验一次；返回 `{ valid: OutputOf<S> }` |

`Config<S>`：`{ readonly valid: OutputOf<S> }` —— 调用方唯一拿到的句柄，且只在快速失败闸门通过后。

环境值以字符串到达 —— 把模式的输入侧声明为字符串、在输出侧强制转换（输入 ≠ 输出推断，同 `jsonBody`）。I/O 保持注入：`parseEnv` 接收文本，你读文件（核心绝不触碰文件系统）。

## 事件（`s200/events`）

带类型的消息总线 —— `@for-fun/event-emitter`（该电池唯一依赖）上的薄而逐键类型化的外观。API 是一组绑定的函数，无类。

```ts
import { createBus } from 's200/events';
type M = { 'user:created': [userId: string]; 'order:shipped': [orderId: string, tracking: string] };
const bus = createBus<M>();
const off = bus.on('user:created', (userId) => …);
bus.emit('user:created', 'u-1');
await bus.emitAsync('order:shipped', 'o-1', '1Z999');
```

`Bus<M>`：

| 成员 | 含义 |
| --- | --- |
| `on(key, handler)` / `once(key, handler)` | 订阅（once 在运行前移除自身）；返回退订函数 |
| `off(key?)` / `off(key, handler)` | 清空全部、某键的或某一次订阅 |
| `emit(key, …args)` | 按注册序同步扇出 |
| `emitAsync(key, …args)` | 调用当前快照的监听器，全部 settle 后 resolve（allSettled 语义） |
| `onError(handler)` | 订阅两种 emit 共用的错误通道 |
| `setMaxListeners(n)` | 升降每键泄漏警告上限；`0` 静默。纯诊断性 |

错误契约（`emit`/`emitAsync` 共用）：同步错误**收集**而非快速失败 —— 抛错的监听器不阻断同伴；扇出完成后所有收集的错误按监听器顺序走 `onError` 通道，无订阅者时首个收集的错误重抛给 emit 调用方（或拒绝 `emitAsync` 的 promise）。

`BusOptions`：`{ maxListeners?: number }`。`EventsMap`：`Record<string, unknown[]>` —— 事件名 → 监听器参数元组。

## 调度（`s200/schedule`）

`@nestjs/schedule` 的零依赖实现：cron 表达式与固定间隔，落在普通数据与函数上。

`nextRun(expr, from)` 是纯 5 字段 cron 匹配器（分 时 日 月 周），以 **UTC** 解释。支持的字段语法：`*`、`a`、`a-b`、步长（`*` 或 `a-b` 加 `/n`）、逗号混合（`5,10-20/3,45`）。无星期名、无 `L`/`W`/`#` 扩展。星期 0–7 且 0 与 7 都是周日；当日与周同时受限（非裸 `*`）时，日期匹配其**任一**（Vixie cron 规则）。

`createScheduler` 在 `setTimeout` 链上运行作业，从每个作业的下一个绝对发生点重新武装，因此刻度不累积漂移 —— 超过约 24.8 天定时器上限的延迟分块重新武装。作业并发为 1：上一轮还在跑时落地的刻度被跳过而非排队，下一刻度落在运行结算后的下一个网格点。抛错/拒绝的作业路由到 `onError`，绝不破坏循环。

```ts
const scheduler = createScheduler({ onError: (err, expr) => console.error(expr, err) });
scheduler.cron('*/5 * * * *', () => cleanup());
scheduler.interval(60_000, () => heartbeat());
scheduler.start();
await scheduler.stop();   // 取消所有定时器，等待在途运行
```

| 成员 | 含义 |
| --- | --- |
| `scheduler.cron(expr, fn)` | 注册 cron 作业（即时校验 —— `0 0 31 2 *` 这类不可满足表达式在此抛错）；在运行中的调度器上注册立即武装 |
| `scheduler.interval(ms, fn)` | 固定间隔作业；首轮在武装后 `ms` 落地，后续保持在该绝对网格上 |
| `scheduler.start()` | 武装所有已注册作业；已启动或 `stop` 之后抛错（调度器一次性） |
| `scheduler.stop()` | 取消所有定时器，在在途运行结束后 resolve；未启动的调度器上为 no-op，幂等 |

`SchedulerOptions`：`{ now?（默认 `Date.now`）, onError?（默认 `console.error`） }` —— `onError` 收到每个抛错/拒绝的值加作业标签（cron 表达式或 `interval:<ms>`）。`JobFn`：`() => void | Promise<void>`。
