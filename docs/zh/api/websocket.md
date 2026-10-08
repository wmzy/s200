# WebSocket（`s200/websocket`、`s200/websocket/node`、`s200/websocket/bun`）

`data + functions` 形状的 WebSocket 路由：`upgradeWebSocket` 在应用上记录 `pattern → handler` 路由（普通数据），运行时适配器在连接升级时查询注册表。模式使用路由的分段语法（`:param`、末端 `*rest`）；匹配严格、先注册先得，与 HTTP 路由完全一致。

## 注册（`s200/websocket`）

```ts
import { upgradeWebSocket } from 's200/websocket';
import { createUpgradeHandler } from 's200/websocket/node';   // node
import { createBunWebSocketBridge } from 's200/websocket/bun'; // bun

upgradeWebSocket(app, '/chat/:room', (socket, ctx) => {
  socket.onMessage((data) => socket.send(`[${ctx.params.room}] ${data}`));
}, { protocols: ['graphql-ws'], perMessageDeflate: true });

await serve(app, { port: 3000, upgrade: createUpgradeHandler(app) });            // node
serve(app, { port: 3000, websocket: createBunWebSocketBridge(app) });            // bun
```

| 函数 | 含义 |
| --- | --- |
| `upgradeWebSocket(app, pattern, handler, options?)` | 注册 handler；返回应用 |
| `matchWebSocket(app, pathname)` | 对注册表做最长匹配查找 → `WebSocketMatch \| undefined` |
| `createWsCtx(req, url, params)` | 为 handler 构建请求形状的 `Ctx`（params/query/url） |

`WebSocketRoute`：`{ pattern, segments, handler, protocols?, perMessageDeflate? }` —— 一条注册表项。注册表挂在应用之外（应用旁的 `WeakMap`），因此核心 `App` 形状保持纯 HTTP，WebSocket 状态在所有非 WS 消费者中被 tree-shake 掉。`WebSocketMatch`：`{ route, params }` —— `matchWebSocket` 的返回值。

`WebSocketRouteOptions`：`{ protocols?: readonly string[]; perMessageDeflate?: boolean }` —— 子协议按服务端偏好序（客户端提供的第一个匹配者胜出）；permessage-deflate（RFC 7692）双向 no-context-takeover 协商（node 适配器实现；bun 桥把压缩交给 Bun 原生协商）。

`WsSocket` —— 一连接的服务端，纯函数属性（无事件发射器对象、无类）：

| 成员 | 含义 |
| --- | --- |
| `send(data)` | 文本或二进制消息；尽力背压（运行时内部排队） |
| `close(code?, reason?)` | 启动关闭握手 |
| `protocol` | 协商出的子协议 —— 路由声明了 protocols 且客户端提供了时 |
| `ping(payload?)` / `onPong(cb)` | 保活原语 —— 配对检测死连接 |
| `onMessage(cb)` | `cb(data: WsData)` —— `string \| ArrayBuffer \| Uint8Array` |
| `onClose(cb)` | 以协商的关闭码触发一次（无关闭帧断开为 `1006`） |
| `onError(cb)` | 本连接的传输/处理错误 |

回调签名：`WsMessageCb` = `(data: WsData) => void`，`WsCloseCb` = `(code: number, reason: string) => void`，`WsErrorCb` = `(error: Error) => void`。

`WebSocketHandler`：`(socket: WsSocket, ctx: Ctx) => void | Promise<void>`。

## Node（`s200/websocket/node`）

零依赖 RFC 6455 服务器：握手、带分片的文本/二进制消息、ping/pong、关闭握手与负载预算。可选子协议协商与 permessage-deflate 在此实现。

```ts
import { createUpgradeHandler } from 's200/websocket/node';
const server = await serve(app, { port: 3000, upgrade: createUpgradeHandler(app) });
// 明文 ws:// —— 或与 https 配对得 wss://（仅 http2: true 排除）
```

| 函数 | 含义 |
| --- | --- |
| `createUpgradeHandler(app, options?)` | 构建 http 服务器的 `'upgrade'` 回调：把路径与应用的 WebSocket 路由匹配、应答握手、每连接运行匹配 handler。未知道路销毁 socket；非法握手得 400 |

`NodeUpgradeOptions`：`{ maxPayload?: number }` —— 累计消息上限，默认 64 MiB；超限消息在缓冲更多之前以 `1009` 关闭。`NodeUpgradeHandler`：`(req: IncomingMessage, socket: Duplex, head: Buffer) => void` —— 也是 `s200/node` 的 `serve` 的 `upgrade` 选项类型。

## Bun（`s200/websocket/bun`）

把应用的 WebSocket 注册表变成 `Bun.serve` 的 `websocket` 选项加升级判定，经 `s200/bun` 的 `serve` 传入。Bun 实现协议；本模块只做升级路由并把 Bun 的每连接回调映射到 `WsSocket` 面（含子协议协商，与 node 适配器镜像，使两个运行时选择一致）。

```ts
import { createBunWebSocketBridge } from 's200/websocket/bun';
serve(app, { port: 3000, websocket: createBunWebSocketBridge(app) });
```

| 函数 / 类型 | 含义 |
| --- | --- |
| `createBunWebSocketBridge(app)` | `{ upgrade, websocket }` —— `upgrade(req, server)` 在 fetch handler 内决定请求是否升级；`websocket` 携带每连接回调 |
| `BunWebSocketBridge` | `{ upgrade: (req, server: BunUpgrader) => boolean; websocket: BunWsHandlers }` |
| `BunUpgrader` | Bun 交给 fetch handler 的 `server`：`upgrade(request, options?) => boolean` |
| `BunWs` / `BunWsHandlers` | Bun 的每连接 socket 与 `open`/`message`/`close`/`pong` 回调集，收窄到用到的成员 |
