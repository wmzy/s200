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

`NodeServer`：

| 字段 | 含义 |
| --- | --- |
| `server` | 原始 `HttpServer \| HttpsServer \| Http2SecureServer` —— `s200/lifecycle` 的优雅排空面 |
| `url` | `http://host:port` |
| `port` | 已绑定端口 |
| `close()` | 停止接受、排空在途请求后 resolve |

`NodeUpgradeHandler`：`node:http` `'upgrade'` 事件签名 `(req, socket, head) => void`。

## 供 `serveStatic` 注入的文件系统函数

适配器实现 [`serveStatic`](/zh/api/respond#静态文件) 的注入面，核心因此不碰文件系统：

| 函数 | 签名 | 含义 |
| --- | --- | --- |
| `createFileReader(root, { stream? })` | `(path) => Promise<Uint8Array \| ReadableStream \| null>` | 默认缓冲整文件读取；`{ stream: true }` 流式（大文件内存安全，但无 `stat` 支撑的尺寸/ranges） |
| `createFileStat(root)` | `(path) => Promise<StaticFileInfo \| null>` | 条件请求 + 流式 content-length 所需的文件元数据 |
| `createFileRangeReader(root)` | `(path, start, end) => Promise<ReadableStream \| null>` | 内存安全的 `[start, end]` range 流 |
| `createRealPathGuard(root)` | `(path) => Promise<string \| null>` | 符号链接逃逸守卫：解析真实路径逃出 `root` 时返回 `null` |

`NodeHttpsOptions`：`{ key, cert, ca?, http2? }` —— `key`/`cert` 接受字符串、`Buffer` 或数组（`node:https` 形状）。

## `brotliCompress(bytes)` → `Promise<Uint8Array>`

Node 的 `CompressionStream` 没有 brotli —— 这是 `s200/compress` 接受的注入编码器：

```ts
import { brotliCompress } from 's200/node';
use(app, compress({ brotli: { compress: brotliCompress } }));
```
