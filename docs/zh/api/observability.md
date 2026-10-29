# 可观测性（`s200/logger`、`s200/request-id`、`s200/timing`、`s200/otel`、`s200/version`）

请求日志、关联 ID、服务器耗时、OpenTelemetry 形状的追踪/指标与 API 版本协商。

## 日志（`s200/logger`）

经可插拔 `sink`/`format` 每请求一行。状态永远是真实状态 —— 回退**与错误响应**在链内物化，因此 logger 看到每个请求，包括 500。

```ts
use(app, logger());   // ISO 时间 方法 路径 状态 耗时
```

`LoggerOptions`：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `sink` | `console.log` | `(line: string) => void` |
| `format` | `ISO 时间 方法 路径 状态 耗时` | `(ctx, durationMs) => string` |

## 请求 ID（`s200/request-id`）

每请求的规范关联 ID：传入的 ID 被尊重（代理盖自己的），缺失的生成。ID 暴露在 `ctx.state.requestId` 并刻到响应上 —— 错误响应也包含。

```ts
use(app, requestId());
```

`RequestIdOptions`：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `header` | `'x-request-id'` | 请求/响应头名 |
| `generator` | `crypto.randomUUID()` | `() => string` |

## 服务器耗时（`s200/timing`）

每请求一个 RFC 8006 §7.2 `Server-Timing` 头：命名 span 按注册顺序，随后是总耗时。在 unwind 时经延迟头机制（`setHeader`）刻写，因此 404/405/500 与映射错误响应同样携带 —— 链内边界在 unwind 运行前物化所有响应。

```ts
use(app, timing());
const stop = startTiming(ctx, 'db');
const rows = await query(sql);
stop(); // Server-Timing: db;dur=5.2, total;dur=18.3
```

`startTiming(ctx, name)` 在任何持有 `ctx` 的地方可用 —— handler 与下游中间件皆可。stop 函数从未运行的 span 在头刻写时闭合（其时长覆盖到 unwind）；stop 调用两次只记录第一次的时长。span 名必须是 RFC 7230 token（不含空格、逗号、分号）。未安装该中间件时调用 `startTiming` 无害 —— 每请求的 span 列表弱键引用，随请求消亡。时长为毫秒、一位小数（亚毫秒精度），由 `formatMs(dur)` 格式化 —— logger 的耗时列用的同一导出，自定义 `format` 回调与响应头因此不会漂移。

`TimingOptions`：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `total` | `'total'` | 总耗时条目的名字 |

## OTel（`s200/otel`）

两个中间件使用**结构性**（子集）类型 —— `@opentelemetry/api` 的 `Span`/`Tracer`/`Meter`/`Counter`/`Histogram` 的子集，因此真正的 OTel 对象满足它们，桥接只需一个 lambda。零依赖：W3C trace-context 解析留在用户侧。

### `trace(options?)` —— 每请求一个 span

在 `next()` 前开始、unwind 时结束（链内错误边界先物化所有响应，因此记录的 `http.response.status_code` 永远是真实值）。unwind 时设置的属性：`http.request.method`、`url.path`、`http.response.status_code`、`s200.duration_ms`。状态映射遵循 OTel HTTP 语义约定：`>= 500` → ERROR（`code: 2`），否则 UNSET。`next()` 拒绝时，span 记录异常、置 ERROR、结束并重抛。

`TraceOptions`：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `tracer` | 内置 no-op | `Tracer` —— `startSpan(name, { attributes?, parentContext? }) => Span` |
| `attributes` | — | `startSpan` 时刻在每个 span 上的静态属性 |
| `spanName` | `` `${method} ${pathname}` `` | `(ctx) => string` |
| `extract` | — | `(headers: Headers) => unknown` —— 分布式上下文钩子；其不透明返回值作为 `parentContext` 透传（如用你的 tracer 的 propagation API 解析 `traceparent`） |

```ts
import { trace } from 's200/otel';
import { propagation } from '@opentelemetry/api';
use(app, trace({
  tracer: { startSpan: (name, opts) => otelTracer.startSpan(name, { attributes: opts?.attributes }, opts?.parentContext) },
  extract: (headers) => propagation.extract(headers, { get: (c, k) => c.get(k) ?? undefined }),
}));
```

### `metrics(options?)` —— HTTP 服务器指标

`MetricsOptions`：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `meter` | 内置 no-op | `Meter` —— `createCounter(name, opts?) => Counter`、`createHistogram(name, opts?) => Histogram` |
| `attributes` | — | 静态记录或逐请求回调 —— 铺在默认值之上，可追加（`url.route`、`service.name`）或覆盖 |
| `now` | `performance.now` | 时钟覆盖 |

结构性仪表类型：`Counter` = `{ add(value, attributes?) }`（兼容 OTel 的 `UpDownCounter` —— `add(+1)`/`add(-1)` 同样平衡）、`Histogram` = `{ record(value, attributes?) }`。`MetricAttributes`：`Record<string, AttributeValue>` —— 仪表接受的属性记录，也是 `MetricsOptions.attributes` 携带的类型。`InstrumentOptions`：`{ description?, unit?, advice?: { explicitBucketBoundaries? } }`。`AttributeValue`：`string | number | boolean | readonly (string | number | boolean)[]`。

## API 版本（`s200/version`）

NestJS 风格的版本协商闸门。两种携带在头里的策略；解析出的版本在 `next()` 运行前落到 `ctx.state.version`，响应携带指明协商头的 `Vary`，使共享缓存按版本分键。URI 版本化刻意不重建 —— `mount(app, '/v1', v1App)` 是路由原生等价物。

```ts
use(app, apiVersion({ versions: ['1', '2'], default: '1' }));
// header 策略：  x-api-version: 2
// mediaType 策略：Accept: application/vnd.api+json;version=2
```

`ApiVersionOptions`：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `strategy` | `'header'` | `'header'`（专用头）或 `'mediaType'`（厂商 JSON 类型上的 `version` 参数） |
| `header` | `'x-api-version'` | `'header'` 策略的头名 |
| `mediaType` | `'vnd.api'` | `'mediaType'` 策略的厂商子类型 —— 匹配 Accept 中 `application/<mediaType>+json` 条目 |
| `versions` | （必填，非空） | 支持的版本，精确匹配（大小写敏感） |
| `default` | — | 请求未携带时假设的版本；不设则无版本请求以 `404 API version required` 应答 |

不支持的版本就地 `404` —— handler 永不运行。
