# 分片与调度

一个 s200 应用就是一个事件循环：路由和中间件共享一个单线程运行时，这正是每个基于 isolate 的平台（Cloudflare Workers、Vercel Fluid 实例）在*每个*单元内部运行的模型。本指南讲的是其上一层：把一张路由表变成可独立调度的**单元**——独立的进程、pod 或惰性生成的线程——而无需写第二套路由定义，也无需把调度器烤进框架。

设计立场借鉴自这些平台的真实运作方式：

- **隔离的轴线是策略，不是路由。** 一个 500 条路由、扩缩容/超时/限额策略整齐划一的应用就是一个单元（多副本复制）。只有离群的路由组——重计算、不同超时、不同信任级别——才配拥有自己的单元。永远不要按路由 1:1 分片。
- **路由器住在单元之外。** 谁做分发谁就得读 URL；一个已经读完请求的单元，就错过了所有廉价交接点。所以分发发生在网关（nginx、Gateway API、ALB）或开发用分发器上——永远不要在分片*内部*做。
- **库提供数据面；调度器仍归你所有。** s200 导出单元描述符、分发接缝、executor 和指标面。放置决策属于 k8s、你的 supervisor 配置，或你日后构建的平台。

## 五个组成部分

| 模块 | 职责 |
|---|---|
| `s200/shard` | 路由策略标注 + `ShardSpec`（可序列化的单元描述符）+ `shardApp` 分区 + `matchShard` 分发接缝 |
| `s200/gateway` | 纯生成器：同一份 specs → nginx.conf / Gateway API HTTPRoute / ALB 监听器规则 |
| `s200/shard-dev` | 前缀语义一致的进程内分发器——无需 nginx 的本地一致性 |
| `s200/executor` | executor（`inline` / `thread` / `process` / `external`）+ supervisor：Node ≥26.6 监听器传递的惰性线程生成、fork 进程 shim、带退避的重启 |
| `s200/unit-metrics` | 调度器之眼：在途请求数、队列深度、事件循环利用率、RSS、warm/cold——以中间件 + 端点形式提供 |

一张路由表喂饱全部五个模块。声明一次，任意形态部署。

## 1. 标注策略，切分应用

```ts
import { createApp, get } from 's200';
import { policy, shardSpecs, shardApp, type ShardGroup } from 's200/shard';

const app = createApp();
get(app, '/catalog/*', catalogHandler);
get(app, '/reports/*', reportHandler);        // 重负载：独立单元
get(app, '/health', healthHandler);

// 路由级策略——存放在 app 之外（WeakMap），像 s200/meta 一样可 tree-shaking
policy(app, 'GET', '/reports/*', { timeoutMs: 300_000, memoryMb: 512, streaming: true });

const groups: readonly ShardGroup[] = [
  { id: 'reports', prefix: '/reports', entry: './reports-shard.ts' },
  { id: 'main', prefix: '/' },                // '/' 是兜底前缀
];

const specs = shardSpecs(app, groups);        // 可序列化，JSON 就绪
```

`ShardSpec` 是纯数据：id、prefix、路由表条目（method/pattern/params）、合并后的策略（组基线 + 首见路由覆盖；`maxConcurrency` 只放宽），以及供 thread/process 执行的可选 `entry` 模块。`shardSpecs` 遇到孤儿路由会抛错——不匹配任何组（也未被任何 `policy(..., { shard })` 认领）的路由会按名称列出，绝不静默丢弃。

`shardApp(app, group)` 是 `mount` 的逆操作：取出该组的路由且**绝对模式原样不变**、携带全部应用级中间件（`use(app, prefix, ...)` 按路径限定自身作用域，因此能正确组合）、继承 `match`/`onError`/`onNotFound`。`mount(parent, '', shardApp(app, group))` 可以原样还原出先前的行为。

## 2. 生成网关配置，而不是第二套路由器

```ts
import { nginxConf, gatewayRoutes, albRules } from 's200/gateway';

nginxConf(specs);                    // upstream keepalive 三件套 + location ^~ 块
gatewayRoutes(specs, { hostname: 'api.example.com' });  // Gateway API HTTPRoute YAML
albRules(specs, { listenerArn, targetGroupArns: { reports: arn1, main: arn2 } });
```

nginx 视图把手工配置必错的三件事直接烤了进去：upstream `keepalive`、`proxy_http_version 1.1` 和 `Connection ""` 头清除（缺了它们，每个请求都要为通往分片的新建 TCP 握手买单）。策略映射为指令——`timeoutMs` → `proxy_read_timeout`、`streaming` → `proxy_buffering off`——并映射为 Gateway/ALB 的等价物。相同输入，逐字节相同的输出：在 CI 里 diff 你的配置。

前缀粒度是诚实的极限：网关按路径前缀分发，从不按方法——`GET /users` 和 `POST /users` 天生住在同一个分片里，在包括下文开发分发器在内的每个视图中都是如此。

## 3. 在同一条接缝上开发

```ts
import { createDispatcher } from 's200/shard-dev';

const dispatch = createDispatcher(
  groups.map((group) => ({ spec: shardSpecs(app, [group])[0]!, app: shardApp(app, group) })),
  fallbackApp,                                  // 可选：未匹配的前缀
);
const res = await dispatch(new Request('http://local/reports/q4'));  // → handle(shardApp)
```

`createDispatcher` 按生成配置所编码的同一条 `matchShard` 最长前缀接缝路由——开发行为与生产分发是构造上的一致，而非靠纪律维持。未命中会交给 fallback 应用（或一个朴素的 404）。这也是 `inline` executor 的形态：所有分片在一个进程里，零基础设施。

## 4. 执行：线程换密度，进程换隔离

```ts
import { runShards } from 's200/executor';

const supervisor = runShards([
  { spec: specs[0]!, executor: { kind: 'thread', entry: './reports-shard.ts' }, port: 31001 },
  { spec: specs[1]!, executor: { kind: 'external', address: '10.0.0.4:8080' } },
]);
await supervisor.start();                      // 仅当每个单元都能服务时才返回
await supervisor.stop();                       // 宽限期内排空，然后终止
supervisor.units();                            // 每个单元的 state/port/restarts/lastError
```

- **`thread`** —— 每个分片一个 worker isolate，**惰性**生成：supervisor 预先绑定端口（闲置监听器零成本），把早到的连接挂起停放，首个流量到来时才生成 worker，然后把监听服务器*连同*停放的 socket 一起移交过去（Node ≥ 26.6，Unix；已验证的机制——被移交的监听器保留 `pauseOnConnect`，因此 worker 能恢复每一个 socket）。路由代码在首次请求时于线程内加载（`await import(entry)`）。在移交不可用的场合（更老的 node——worker 线程句柄移交是 Node ≥ 26 的能力），supervisor 改为把已接受的 socket 逐字节中继到 worker 的私有端口：同样的惰性生成、同样服务首次请求，supervisor 依旧从不解析 HTTP。`memoryMb` 映射为 worker 的 `resourceLimits`。
- **`process`** —— fork 模块内置的 shim（哨兵环境变量 `S200_ENTRY`/`S200_PORT`，`SIGTERM` 排空）。真正的崩溃隔离，可独立施加 cgroup；也是编排器把分片调度为独立 pod 时看到的形态。
- **`inline`** —— 没有要运行的东西；与 `createDispatcher` 搭配使用。
- **`external`** —— 是一个地址而非生命周期：单元已经在别处（另一台机器、另一个机群）运行；`units()` 出于完整性才报告它。

意外退出的单元以指数退避重启（100ms 起翻倍，封顶 5s）；`stop()` 在 3s 宽限期内排空，然后强杀。线程共享进程——一次原生段错误会杀死整个 supervisor；进程才是诚实的隔离边界（见本指南理据中的平台对比：JS 级崩溃隔离 ≠ 原生崩溃隔离）。

## 5. 上报调度器所需的信息

```ts
import { createUnitMetrics, unitMetricsEndpoint } from 's200/unit-metrics';

const metrics = createUnitMetrics({ maxConcurrency: 32, warmAfter: 1 });
use(app, metrics.middleware);
get(app, '/unit-metrics', unitMetricsEndpoint(metrics));
// { inFlight, queueDepth, requests, maxInFlight, eventLoopUtilization, rss, heapUsed, warm, startedAt }
```

`inFlight`/`queueDepth`（超容时）、事件循环利用率（快照差值，无后台定时器）、RSS/堆内存，以及 warm/cold 标志——这些正是缩容到零和最少负载决策所消费的输入。同一批数字在 k8s 下（把端点接进探针）和你自建的控制面下都可用：库的契约止步于诚实的自我上报；放置决策留在边界之外。

## 它不是什么

这里没有全局解析器、预热池或跨机器导流——那些是平台资产，刻意的边界在于 `s200` 始终是数据面。机群级分片（多机）就是同一份 specs + Gateway/ALB 视图 + 你的编排器；单机内多单元的密度（数百租户）就是 `thread` executor。这个库拒绝长出调度器，为的是能在它*之上*构建一个。
