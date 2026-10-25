# 反向代理（`s200/proxy`）

基于 fetch 的反向代理原语 —— 补全 s200 网关故事的运行时那一跳。`s200/gateway` 生成 nginx/K8s/ALB 配置，`s200/shard-dev` 在进程内跨分片调度，而本模块转发真实流量：把请求经 `fetch` 流式转发到上游 URL，把上游响应原样交回，双向剥离逐跳（hop-by-hop）头。上面那一层见[分片与调度指南](../guides/sharding.md)。

## `proxyRequest` —— 低层转发 {#proxyrequest}

```ts
import { proxyRequest } from 's200/proxy';

get(app, '/legacy', (ctx) => proxyRequest(ctx, 'http://127.0.0.1:8080/legacy'));
```

把 `ctx` 的请求转发到绝对 `target` URL，返回剥离逐跳头后的上游响应。`ctx.res` 归调用者所有：handler 直接返回该结果，中间件则赋值给它。挂起的 `setHeader` 值会排到返回的响应上，因此链上更早盖章的头（request-id、安全头）也会随代理响应发出。

| `ProxyInit` | 含义 | 默认 |
| --- | --- | --- |
| `headers` | 额外的上游请求头，在转发的头集合之后应用 —— 显式给出的头（`authorization`、`accept-encoding`）胜出 | — |
| `signal` | 额外的中止源，经 `AbortSignal.any` 与 `ctx.signal` 组合 | 仅 `ctx.signal` |
| `preserveHost` | 原样转发进入的 `host` 头 | `false`（丢弃；运行时按目标 URL 钉住 Host） |
| `clientAddress` | 追加到 `x-forwarded-for` 的地址：字符串，或每请求解析器 | 省略 → 既有链原样透传 |
| `redirect` | 上游重定向模式 | `'manual'`（3xx 原样透传，`Location` 不改写） |

## `createProxy` —— 作为中间件的前缀分发 {#createproxy}

```ts
import { createProxy } from 's200/proxy';

use(app, '/api', createProxy({
  upstream: 'http://127.0.0.1:8080',
  rewrite: (p) => p.replace(/^\/api/, '') || '/',
}));
```

到达该中间件的每个请求都被转发到 `upstream`（origin + 可选路径前缀 + 改写后的 pathname + 进入请求的 search），上游响应成为 `ctx.res`。该中间件是终端 —— 它从不调用 `next()` —— 因而上面的 `use` 前缀就是分发本身：`/api` 之下的一切都归上游，`rewrite` 通常剥掉挂载前缀。

| `CreateProxyOptions` | 含义 | 默认 |
| --- | --- | --- |
| `upstream` | 上游的 base URL —— origin 加可选路径前缀；自带 query/hash 是装配期错误（请求自己的 query 才是要发出的） | 必填 |
| `rewrite` | 转发前改写 pathname | 恒等 |
| `preserveHost` | 见 `ProxyInit.preserveHost` | `false` |
| `clientAddress` | 见 `ProxyInit.clientAddress` | 省略 |

## 语义 {#semantics}

- **流式，零缓冲。** 请求体（`ctx.req.body`）以 `duplex: 'half'` 交给 `fetch` —— 客户端产出字节时上游即刻可见；响应体端到端保持流。代理转发会消费请求体：链上更早读过它的中间件（`readJson` 等）会破坏转发，`proxyRequest` 会抛出说明这一点的普通 `Error`。
- **双向剥离逐跳头。** RFC 9110 §7.6.1（`connection`、`keep-alive`、`proxy-authenticate`、`proxy-authorization`、`te`、`trailer`、`transfer-encoding`、`upgrade`），外加进入的 `connection` 头点名的每个 token —— 请求与响应两侧都剥。
- **`x-forwarded-*` 只累积。** `x-forwarded-proto` 与 `x-forwarded-host` 从进入请求追加；`x-forwarded-for` 追加 `clientAddress` 给出的地址 —— 无地址可认领的一跳保持链不动，而不是追加垃圾值（`s200/rate-limit` 与 `s200/trust-proxy` 的首跳取键因此保持可信）。
- **`accept-encoding` 钉为 `identity`。** fetch 传输层会透明解码内容编码，压缩的上游会把已解码的 body 与过期的 `content-encoding`/`content-length` 头配对。钉住 identity 让代理的字节与头端到端诚实；`init.headers` 里显式的 `accept-encoding` 覆盖该钉住。
- **content-length 只透传，绝不伪造。** 上游设置的长度随流原样携带 —— 显式 CL 契约约束的是 s200 自己创建的响应体，不是透传响应。无 body 状态码（204/205/304）不带 body 发出。
- **Host 遵循 fetch 规范。** 严格实现规范的运行时（undici/node、浏览器）无论转发的头集合如何，都把 `Host` 钉到目标 URL 的 authority；`preserveHost: true` 原样转发进入的头 —— 允许调用者设 Host 的运行时（Bun）遵循之，严格运行时则覆盖之。原始 host 的可靠载体是追加的 `x-forwarded-host`。
- **不代理 upgrade。** 协议升级（WebSocket）不在代理之列 —— `fetch` 没有 upgrade 通道；用 `s200/websocket` 终结它们。也不改写 `Location`：默认 `redirect: 'manual'` 下 3xx 原样透传。

## 失败映射 {#failure-mapping}

`fetch` 被拒时经标准错误边界映射为 `httpError`（`onError` 与链内响应契约照常适用）：

| 条件 | 响应 |
| --- | --- |
| 链接的 signal 已中止 —— 客户端断开，或超时电池的 deadline 打在 `ctx.signal` 上 | `499 Client Closed Request`（nginx 惯例：是请求自己这一侧放弃，不是上游） |
| 其他任何网络故障 —— 连接拒绝、DNS、TLS | `502 Bad Gateway` |

传输层细节（errno、TLS 原因）留在内部 —— 客户端得知的是映射结果，不是拓扑。
