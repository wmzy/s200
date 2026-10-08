# Bun 适配器（`s200/bun`）

在 `Bun.serve` 上服务应用。

## `serve(app, options?)` → `BunServer`

```ts
import { serve } from 's200/bun';
const server = serve(app, { port: 3000 });   // 同步 —— Bun.serve 是同步的
console.log(server.url);                      // http://localhost:3000
await server.close();
```

`BunServeOptions`：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `port` | `0` | 监听端口 |
| `hostname` | — | 主机名 |
| `websocket` | — | `s200/websocket/bun` 的桥：`{ upgrade, websocket }` —— `upgrade` 在 fetch handler 内决定请求是否升级为 WebSocket；`websocket` 半边携带每连接回调 |

`BunServer`：

| 字段 | 含义 |
| --- | --- |
| `url` / `port` | 绑定地址 |
| `server` | 原始 `Bun.serve` 句柄（`BunServedServer`）：`stop(closeActiveConnections?)` —— `stop(false)` 等待在途请求，`stop()`/`stop(true)` 强制关闭。这是 `s200/lifecycle` 鸭子类型化的优雅排空面 |
| `close()` | `stop(true)` —— 同时丢弃在途连接，因此 `close()` 立即 resolve |

注意：Bun 在客户端断开时不会可靠中止 `request.signal`，因此适配器不做断线接线（不同于 Node 适配器的 `abortOnDisconnect`）。

## 供 `serveStatic` 注入的文件系统函数

由 `Bun.file` 支撑 —— 与 Node 适配器相同的注入面（见 [`s200/node`](/zh/api/node#供-servestatic-注入的文件系统函数)）：

| 函数 | 签名 | 含义 |
| --- | --- | --- |
| `createFileReader(root, { stream? })` | `(path) => Promise<Uint8Array \| ReadableStream \| null>` | 默认 `Bun.file` 字节；`{ stream: true }` 流式 |
| `createFileStat(root)` | `(path) => Promise<StaticFileInfo \| null>` | 条件请求所需的 `size` + `lastModified` |
| `createFileRangeReader(root)` | `(path, start, end) => Promise<ReadableStream \| null>` | `Bun.file(...).slice(start, end).stream()` |
| `createRealPathGuard(root)` | `(path) => Promise<string \| null>` | 经 `realpathSync` 的符号链接逃逸守卫 |
