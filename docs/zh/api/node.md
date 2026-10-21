# Node 适配器（`s200/node`）

在 Node 的 `http`/`https`/`http2` 服务器上服务应用。

## `serve(app, options?)` → `Promise<NodeServer>`

```ts
import { serve } from 's200/node';
const server = await serve(app, { port: 3000 });
console.log(server.url);        // http://127.0.0.1:3000
await server.close();
```

`NodeServeOptions`：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `port` | `0`（临时） | 监听端口 |
| `host` | — | 主机名 |
| `upgrade` | — | WebSocket `'upgrade'` 回调 —— 传 `s200/websocket/node` 的 `createUpgradeHandler(app)`（见 [`s200/websocket`](/zh/api/websocket)） |
| `light` | `false` | 启用快速路径：适配器构造轻量 `Request`/`Response` 对象（不打全局补丁；handler 仍见 Web Standard 形状）。注意：`clone()` 仅对字节支撑体有效；奇异 `BodyInit`（Blob/FormData）需一次真实 `Response` 构造 |
| `abortOnDisconnect` | `true` | 客户端在响应完成前断开时中止 `ctx.signal`；`false` 跳过每请求 `AbortController` |
| `https` | — | `NodeHttpsOptions`：经 `node:https` 提供 TLS，或 `http2: true` 走 HTTP/2-over-TLS（不支持明文 h2c；HTTP/2 无 `upgrade` 事件，故 `http2: true` + `upgrade` 在 `serve` 时抛错 —— WSS 需要 HTTP/1.1-over-TLS） |
| `server` | — | `NodeServerTunables`：精选的 node 服务器旋钮（`maxHeaderSize`、`requestTimeout`、`headersTimeout`、`keepAliveTimeout`、`connectionsCheckingInterval`、`keepAlive`、`noDelay`、`highWaterMark`），在每条路径（http、https、HTTP/2-over-TLS）的构造期生效 —— 只有这些白名单字段会传给 node 的构造器 |
| `closeGraceMs` | `10_000` | 优雅关闭预算（ms）。`close()` 停止接受新连接、销毁空闲 keep-alive socket、放行在途响应 —— 最后一个落地即 resolve。预算耗尽时仍未结束的连接被硬杀（`closeAllConnections()`，外加适配器自行登记的 upgraded/websocket socket）。`0` 立即硬杀：调用 `close()` 的那一刻在途响应即死 |
| `clientError` | — | `(err, socket) => void`，接到服务器的 `'clientError'` 事件 —— 畸形请求进入你的钩子而非 node 默认行为（销毁肇事 socket）。不传时 node 自身行为原样保留 |

`NodeServer`：

| 字段 | 含义 |
| --- | --- |
| `server` | 原始 `NodeServerKind`（`HttpServer \| HttpsServer \| Http2SecureServer`）—— `s200/lifecycle` 的优雅排空面 |
| `url` | `http://host:port` |
| `port` | 已绑定端口 |
| `close()` | 默认优雅：停止接受新连接，在 `closeGraceMs` 内排空在途请求后 resolve（见下） |

`NodeUpgradeHandler`：`node:http` `'upgrade'` 事件签名 `(req, socket, head) => void`。

## 优雅关闭

`close()` 默认优雅 —— 即 `s200/lifecycle` 与分片执行器共用的排空模式：

1. **停止接受** —— `server.close()`：自此刻起新连接一律拒绝。
2. **销毁空闲 keep-alive socket**，并在此后排空中反复扫（响应落地会把它的 keep-alive socket 留在空闲态；不补扫的话 `close()` 要等满该 socket 自己的 `keepAliveTimeout`）。
3. **等在途响应** —— 最后一个落地时 `close()` 的 promise 即刻 resolve，不用等满预算。
4. **到预算即硬杀** —— `closeGraceMs`（默认 `10_000`）耗尽时，`closeAllConnections()` 加上适配器自建的 upgraded（websocket）socket 登记表，销毁一切仍打开的连接。被 `'upgrade'` 接管的 socket 对 node 自己的 `closeAllConnections()` 不可见；正是登记表让预算对 websocket 服务器成为真正的上界。

`closeGraceMs: 0` 跳过以上全部：立即销毁一切，在途响应一并杀死。

HTTP/2-over-TLS 上跑同一序列 —— node 的 `close()` 自行拆除会话；idle/all 两类连接调用没有 http2 对应物，直接跳过。

## 服务器旋钮 {#server-tunables}

`server: NodeServerTunables` 把精选的 node 服务器旋钮传给底层构造器 —— 同样八个字段在 http、https、HTTP/2-over-TLS 三条路径都生效：

| 字段 | node 默认 | 含义 |
| --- | --- | --- |
| `maxHeaderSize` | `16384` | 每请求头部预算（字节） |
| `requestTimeout` | `300_000` | 整个请求的期限（ms，`0` 关闭） |
| `headersTimeout` | `60_000` | 仅头部的期限（ms）—— 必须 ≤ `requestTimeout` |
| `keepAliveTimeout` | `5_000` | keep-alive 空闲窗口（ms） |
| `connectionsCheckingInterval` | `30_000` | 未完成请求的清账周期（ms） |
| `keepAlive` | `false` | socket 上的 TCP keep-alive 探测 |
| `noDelay` | `true` | `socket.setNoDelay` —— 关闭 Nagle |
| `highWaterMark` | `16384` | 每 socket 流缓冲大小（字节） |

**生产提示。** 让 `keepAliveTimeout` 明显低于上游负载均衡的空闲超时：LB 认为连接已闲置而丢弃、后端却仍持有它，是经典的静默 502 陷阱（下一个请求骑上了 LB 早已抛弃的 socket）。惯用配方是 LB 空闲超时 ≥ `keepAliveTimeout` + 几秒余量。`requestTimeout` 限制的是*整个*请求（含 body）—— 超长时间流式上传/下载会被它拦腰截断，流式端点请自行调大（或设 `0` 关闭，改靠 `headersTimeout` + 自己的 body 限制）。

## Host 头加固

适配器用 `Host` 头（HTTP/2 上是 `:authority`）拼出每个请求的 URL。超出 authority 语法的 Host —— 除字母数字、`.`、`-`、`:`（端口）、`[`/`]`（IPv6 字面量）之外的任何字符，包括 `/ \ ? # @`、空白、percent 转义与空值 —— 一律回退为 `localhost`，不进入 URL：伪造的 `Host: evil.com/a` 既污染不了解析出的 pathname，也不会让 URL 无法解析。合法 Host 原样通过 —— `example.com`、`example.com:8080`、`[::1]:3000`。

## `onFinish(ctx, fn)`（core barrel） {#onfinish}

```ts
import { onFinish } from 's200';

get(app, '/report', (ctx) => {
  onFinish(ctx, ({ aborted }) => {
    console.log('report response finished', aborted ? 'early' : 'cleanly');
  });
  return json(ctx, buildReport());
});
```

注册一个每请求**恰好运行一次**的回调 —— 先到先触发，后续触发是 no-op：

- `{ aborted: false }` —— 响应已完整写完。
- `{ aborted: true }` —— 连接先行结束：客户端断开、响应体被 cancel，或写中途失败。

回调是 fire-and-forget：同步抛错（或返回的 promise 拒绝）会经 app 的 `logError` 记录，绝不打断响应或其他回调。请在 finish 之前注册 —— 之后的注册会被静默丢弃。

node 适配器上的触发点是 socket 写完成与提前 `'close'`；有无 `light` 都会触发，`abortOnDisconnect: false` 只跳过 `ctx.signal` 的中止 —— finish 回调照常运行。

## 流式响应的断连传播

拉取流式响应体期间，客户端断开（`abortOnDisconnect` 的每请求 signal，默认开启）会 cancel body reader：handler 侧的生成器收到 `finally`，等待中的背压等待立即拒绝而不是挂在死掉的 socket 上，响应随后被销毁。`abortOnDisconnect: false` 时循环只走普通 drain 背压，不传播 cancel。

## 供 `serveStatic` 注入的文件系统函数

适配器实现 [`serveStatic`](/zh/api/respond#静态文件) 的注入面，核心因此不碰文件系统：

| 函数 | 签名 | 含义 |
| --- | --- | --- |
| `createFileReader(root, { stream?, realPath?, streamThreshold? })` | `(path) => Promise<Uint8Array \| ReadableStream \| null>` | 默认即安全：解析出的真实路径必须留在 `root` 内（指向别处的符号链接按 miss 处理；`realPath: false` 关闭），且严格大于 `streamThreshold`（默认 16 MiB）的文件流式返回而非缓冲。`{ stream: true }` 不论大小一律流式 |
| `createFileStat(root)` | `(path) => Promise<StaticFileInfo \| null>` | 条件请求 + 流式 content-length 所需的文件元数据 |
| `createFileRangeReader(root)` | `(path, start, end) => Promise<ReadableStream \| null>` | 内存安全的 `[start, end]` range 流 |
| `createRealPathGuard(root)` | `(path) => Promise<string \| null>` | 符号链接逃逸守卫：解析真实路径逃出 `root` 时返回 `null` —— `createFileReader` 已默认内置 |

超过阈值的文件走流式，请在 reader 旁一并注入 `createFileStat`/`createFileRangeReader`，让这些响应保住 content-length、校验器（ETag/Last-Modified/304）与 `206`/`416` range 语义。

`NodeHttpsOptions`：`{ key, cert, ca?, http2? }` —— `key`/`cert` 接受字符串、`Buffer` 或数组（`node:https` 形状）。

## `brotliCompress(bytes)` → `Promise<Uint8Array>`

Node 的 `CompressionStream` 没有 brotli —— 这是 `s200/compress` 接受的注入编码器：

```ts
import { brotliCompress } from 's200/node';
use(app, compress({ brotli: { compress: brotliCompress } }));
```
