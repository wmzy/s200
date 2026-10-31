# WebSocket（`s200/websocket`、`s200/websocket/node`、`s200/websocket/bun`、`s200/websocket/cloudflare`）

`data + functions` 形状的 WebSocket 路由：`upgradeWebSocket` 在应用上记录 `pattern → handler` 路由（普通数据），运行时适配器在连接升级时查询注册表。模式使用路由的分段语法（`:param`、末端 `*rest`）；匹配严格、先注册先得，与 HTTP 路由完全一致。升级在握手完成前先运行应用的中间件链与路由的中间件 —— 见[升级上的中间件与鉴权](#升级上的中间件与鉴权)。

## 注册（`s200/websocket`）

```ts
import { upgradeWebSocket } from 's200/websocket';
import { createUpgradeHandler } from 's200/websocket/node';   // node
import { createBunWebSocketBridge } from 's200/websocket/bun'; // bun
import { createCloudflareWebSocketBridge } from 's200/websocket/cloudflare'; // workers

upgradeWebSocket(app, '/chat/:room', (socket, ctx) => {
  socket.onMessage((data) => socket.send(`[${ctx.params.room}] ${data}`));
}, { protocols: ['graphql-ws'], perMessageDeflate: true });

await serve(app, { port: 3000, upgrade: createUpgradeHandler(app) });            // node
serve(app, { port: 3000, websocket: createBunWebSocketBridge(app) });            // bun
// workers：ws.upgrade(request) ?? createHandler(app).fetch(…) —— 见下文
```

| 函数 | 含义 |
| --- | --- |
| `upgradeWebSocket(app, pattern, ...middlewares, handler, options?)` | 注册路由级中间件 + handler；返回应用 |
| `matchWebSocket(app, pathname)` | 对注册表做最长匹配查找 → `WebSocketMatch \| undefined` |
| `resolveUpgrade(app, route, request, url, params)` | 运行应用 + 路由中间件链 → `WsUpgradeDecision`（适配器共用的判定帮助函数） |
| `createWsCtx(req, url, params)` | 为 handler 构建请求形状的 `Ctx`（params/query/url） |
| `negotiateProtocol(offered, serverProtocols)` | 适配器共用的子协议规则：拆分客户端提供的 `sec-websocket-protocol` 头，按服务端偏好序 —— 第一个客户端也提供的声明协议胜出，无匹配时为 `undefined` |
| `createWsSession()` | 新建监听器袋（`onMessage`/`onClose`/`onError`/`onPong` 列表），支撑一条连接的 socket 注册 |
| `createWsSocket(session, protocol, transport)` | 适配器共用的 socket 工厂：围绕运行时传输闭包（`send`/`close`/`ping`/`bufferedAmount`，可选 `subscribePong`）构建 `WsSocket` API |
| `runWsHandler(handler, socket, ctx, session, close)` | 在中间件链之外运行 handler；拒绝时向 `session.onError` 扇出并经 `close` 关闭 1011 |

`upgradeWebSocket` 镜像 HTTP 注册器的 variadic 形状：模式与末端 handler 之间的每个实参都是路由级中间件；旧的四参形式（无中间件的 `handler, options?`）继续有效。

`WebSocketRoute`：`{ pattern, segments, middlewares, handler, protocols?, perMessageDeflate? }` —— 一条注册表项。注册表挂在应用之外（应用旁的 `WeakMap`），因此核心 `App` 形状保持纯 HTTP，WebSocket 状态在所有非 WS 消费者中被 tree-shake 掉。`WebSocketMatch`：`{ route, params }` —— `matchWebSocket` 的返回值。

`WebSocketRouteOptions`：`{ protocols?: readonly string[]; perMessageDeflate?: boolean }` —— 子协议按服务端偏好序（客户端提供的第一个匹配者胜出）；permessage-deflate（RFC 7692）双向 no-context-takeover 协商（node 适配器实现；bun 桥把压缩交给 Bun 原生协商；Workers 不协商压缩，cloudflare 桥忽略该开关）。

`WsSocket` —— 一连接的服务端，纯函数属性（无事件发射器对象、无类）：

| 成员 | 含义 |
| --- | --- |
| `send(data)` | 文本或二进制消息；尽力背压（运行时内部排队） |
| `bufferedAmount` | 传输层已排队、尚未发送到网络的字节数 —— 发送侧背压可见性：`send` 快于网络时增长，socket 冲刷后回落到 `0`（node：socket 的 `writableLength`；bun：Bun 的每连接计数器；cloudflare：Workers 不暴露计数器，恒为 `0`） |
| `close(code?, reason?)` | 启动关闭握手 |
| `protocol` | 协商出的子协议 —— 路由声明了 protocols 且客户端提供了时 |
| `ping(payload?)` / `onPong(cb)` | 保活原语 —— 配对检测死连接（cloudflare：Workers 自行管理保活 —— `ping` 仅在运行时提供该 API 时转发，`onPong` 保持沉默） |
| `onMessage(cb)` | `cb(data: WsData)` —— `string \| ArrayBuffer \| Uint8Array` |
| `onClose(cb)` | 以协商的关闭码触发一次（无关闭帧断开为 `1006`） |
| `onError(cb)` | 本连接的传输/处理错误 |

回调签名：`WsMessageCb` = `(data: WsData) => void`，`WsCloseCb` = `(code: number, reason: string) => void`，`WsErrorCb` = `(error: Error) => void`。

`WebSocketHandler`：`(socket: WsSocket, ctx: Ctx) => void | Promise<void>`。

## 升级上的中间件与鉴权

WebSocket 升级在握手完成之前，先运行应用的中间件链（与 HTTP 相同的那些 `use(app, …)` 中间件），再运行路由自己的中间件。中间件通过写 `ctx.res`（或返回一个 `Response`、或抛错）作答：该响应即拒绝升级，并以普通 HTTP 应答替代 `101` —— node 适配器在写出任何协议字节之前把它写回 socket，bun 与 cloudflare 桥从 fetch handler 返回它。鉴权门因此就是一个普通中间件：

```ts
import { httpError, use } from 's200';
import { upgradeWebSocket } from 's200/websocket';

// 应用级：门控此应用上的每次升级（不限作用域时 HTTP 请求同样经过）——
// 缺少 token 的握手以 401 拒绝。
use(app, async (ctx, next) => {
  const user = await verifyToken(ctx.req.headers.get('authorization'));
  if (user === null) {
    ctx.res = new Response('missing token', { status: 401 });
    return;
  }
  ctx.state.user = user;
  await next();
});

// 路由级：与 HTTP 注册器相同的形状。
upgradeWebSocket(
  app,
  '/ws/room/:id',
  async (ctx, next) => {
    if (ctx.state.user !== 'admin' && ctx.params.id === 'ops') {
      throw httpError(403, 'ops room is admin-only');
    }
    await next();
  },
  (socket, ctx) => {
    socket.onMessage((data) => socket.send(`${String(ctx.state.user)}: ${String(data)}`));
  }
);
```

精确语义，与 HTTP 分发一致：

- **顺序** —— 先应用中间件（含 `use(app, '/ws', …)` 前缀作用域组 —— 作用域检查用 `ctx.url.pathname`），后路由中间件，按注册序；回卷反向，与 HTTP 链完全相同。
- **拒绝** —— 任何中间件写 `ctx.res`、返回 `Response` 或抛错都会拒绝升级；客户端收到该 HTTP 响应（抛出的 `HttpError` 映射为它的状态码与 `{ error }` 信封，其他错误走应用的 `onError`/`logError` 策略 —— 自定义 `onError` 保持沉默时回落默认映射，因为升级没有可用的 fallback body）。ctx 上挂起的 `setHeader`/`setHeaders` 条目会附在拒绝响应上。
- **批准** —— 链正常结束且 `ctx.res` 仍为 `undefined` 时升级继续：socket 即响应。中间件在回卷侧看到 `res: undefined`，且所有 `ctx.state` 修改都随 handler 的 ctx 一并传递（同一个 ctx 对象 —— `resolveUpgrade` 把它交还给适配器）。既不作答也不调 `next()` 的中间件隐式批准 —— 要么调 `next()` 要么作答，没有第三条分支。
- **handler 本身在批准之后运行**，位于链外：它抛出的错误不再经过中间件（走 `socket.onError` + 以 1011 关闭的既有行为）。
- **消息回调在分发中途抛错时，三个适配器一律同等遏制** —— node、bun、workerd 都将其扇出到 `socket.onError` 并以 1011 `'handler error'` 关闭，而不是让错误逃逸进运行时的事件分发；排在抛错回调之后的回调不再执行。

`resolveUpgrade(app, route, request, url, params)` 是所有适配器共用的判定帮助函数 —— `WsUpgradeDecision` 为 `{ ok: true; ctx: Ctx }` 或 `{ ok: false; response: Response }`。它面向适配器作者；应用通过 `serve` + `createUpgradeHandler` / `createBunWebSocketBridge` / `createCloudflareWebSocketBridge` 获得相同行为。连接阶段的帮助函数同理：`negotiateProtocol` 执行共用的子协议规则，`createWsSession` + `createWsSocket` + `runWsHandler` 构建各运行时的 socket —— 适配器只需提供自己的传输闭包（node 的 RFC 6455 帧封装、bun 的 `ArrayBuffer`→视图转换、workerd 的可选 `ping`/`bufferedAmount`）。

## Node（`s200/websocket/node`）

零依赖 RFC 6455 服务器：握手、带分片的文本/二进制消息、ping/pong、关闭握手与负载预算。可选子协议协商与 permessage-deflate 在此实现。

```ts
import { createUpgradeHandler } from 's200/websocket/node';
const server = await serve(app, { port: 3000, upgrade: createUpgradeHandler(app) });
// 明文 ws:// —— 或与 https 配对得 wss://（仅 http2: true 排除）
```

| 函数 | 含义 |
| --- | --- |
| `createUpgradeHandler(app, options?)` | 构建 http 服务器的 `'upgrade'` 回调：把路径与应用的 WebSocket 路由匹配、运行应用 + 路由中间件链（拒绝以普通 HTTP 应答替代 `101`）、应答握手、每连接运行匹配 handler。未知道路销毁 socket；非法握手得 400 |

`NodeUpgradeOptions`：`{ maxPayload?: number }` —— 累计消息上限，默认 **4 MiB**。预算在**帧头解析时**强制执行：声明长度独自超过 `maxPayload` 的数据帧 —— 或会把进行中的分片消息推过上限的延续帧 —— 立即以 `1009` 断开，一个负载字节都不缓冲（声明 2^40 字节帧的客户端在几个字节后就会收到 `1009`，而不是缓冲完 1TB 之后）。控制帧不受此限 —— RFC 6455 已把它们限制在 125 字节。缓冲后的检查保留作为累计场景的纵深防御。`NodeUpgradeHandler`：`(req: IncomingMessage, socket: Duplex, head: Buffer) => void` —— 也是 `s200/node` 的 `serve` 的 `upgrade` 选项类型。

## Bun（`s200/websocket/bun`）

把应用的 WebSocket 注册表变成 `Bun.serve` 的 `websocket` 选项加升级判定，经 `s200/bun` 的 `serve` 传入。Bun 实现协议；本模块只做升级路由并把 Bun 的每连接回调映射到 `WsSocket` 面（含子协议协商，与 node 适配器镜像，使两个运行时选择一致）。`socket.bufferedAmount` 由 Bun 每连接的 `getBufferedAmount()` 计数器支撑。

```ts
import { createBunWebSocketBridge } from 's200/websocket/bun';
serve(app, { port: 3000, websocket: createBunWebSocketBridge(app) });
```

| 函数 / 类型 | 含义 |
| --- | --- |
| `createBunWebSocketBridge(app)` | `{ upgrade, websocket }` —— `upgrade(req, server)` 在 fetch handler 内决定请求是否升级（先运行应用 + 路由中间件链；拒绝中间件的 `Response` 以普通 HTTP 应答）；`websocket` 携带每连接回调 |
| `BunWebSocketBridge` | `{ upgrade: (req, server: BunUpgrader) => Promise<boolean \| Response>; websocket: BunWsHandlers }` —— `true` = 已升级，`Response` = 拒绝，`false` = 非 ws 路由 |
| `BunUpgrader` | Bun 交给 fetch handler 的 `server`：`upgrade(request, options?) => boolean` |
| `BunWs` / `BunWsHandlers` | Bun 的每连接 socket 与 `open`/`message`/`close`/`drain`/`pong` 回调集，收窄到用到的成员 |

## Cloudflare（`s200/websocket/cloudflare`）{#cloudflare-s200-websocket-cloudflare}

Workers 侧的对应物：module worker 的 `fetch` 返回 `Response`，因此该桥与 [`s200/cloudflare`](/zh/api/edge) 的 `createHandler` 组合 —— `ws.upgrade(request)` 应答 WebSocket 握手，`undefined` 落回 HTTP fetch。协议由 workerd 实现；本模块只做升级路由（`new WebSocketPair()` + `status: 101` + `init.webSocket` 惯用法）并把 pair 的服务端映射到 `WsSocket` 面，含子协议协商（服务端偏好序，与 node 适配器镜像；协商结果同时挂在 101 响应的 `sec-websocket-protocol` 头上，让运行时完成握手）。

```ts
import { createHandler } from 's200/cloudflare';
import { createCloudflareWebSocketBridge } from 's200/websocket/cloudflare';

const ws = createCloudflareWebSocketBridge(app);
const worker = createHandler(app);

export default {
  fetch: (request, env, ctx) =>
    ws.upgrade(request).then((res) => res ?? worker.fetch(request, env, ctx)),
};
```

`upgrade(request)` 的应答：携带 pair 客户端的 `101` `Response`（直接从 `fetch` 返回即可）；中间件拒绝握手时的拒绝 `Response`（普通 HTTP）；请求未携带 `Upgrade: websocket` 头或未命中 ws 路由时返回 `undefined`（交给 HTTP 链）。在没有 `WebSocketPair` 的宿主上（非 workerd 运行时导入该桥）应答 `501` 而不是崩溃。

| 函数 / 类型 | 含义 |
| --- | --- |
| `createCloudflareWebSocketBridge(app)` | `{ upgrade }` —— worker `fetch` 的 ws 一半；handler 与 ctx 传递与其他桥一致 |
| `CloudflareWebSocketBridge` | `{ upgrade: (request: Request) => Promise<Response \| undefined> }` —— `Response` 即应答，`undefined` 落回 HTTP |
| `CloudflareWebSocket` / `CloudflareWebSocketPair` | Workers `WebSocketPair` 的一端 / `{ 0: client, 1: server }` pair 值，收窄到用到的成员 |

Workers 特有说明：运行时自动回应关闭帧（2026-04-07 起的 compatibility date —— 更早的日期需在 handler 里自行回应，即 `onClose` 中调 `socket.close()`）；`socket.bufferedAmount` 恒为 `0`（workerd 不暴露计数器）；`socket.ping()` 为 no-op、`onPong` 永不触发（workerd 自行管理保活 —— 若未来运行时提供该 API，桥会直接转发）；`perMessageDeflate` 被忽略（Workers 不协商压缩）。

### 三桥对照

| | node（`websocket/node`） | bun（`websocket/bun`） | cloudflare（`websocket/cloudflare`） |
| --- | --- | --- | --- |
| 接入方式 | `serve(app, { upgrade })` | `serve(app, { websocket })` | `ws.upgrade(request) ?? worker.fetch(…)` |
| 协议实现 | s200 零依赖 RFC 6455 服务器 | Bun 原生 ws | workerd 原生 ws |
| 子协议 | 服务端偏好序 | 同左 | 同左（+ 101 响应头） |
| `perMessageDeflate` | 实现（opt-in） | Bun 协商 | 忽略 |
| `bufferedAmount` | socket `writableLength` | Bun 计数器 | `0`（不暴露） |
| `ping` / `onPong` | 帧 | 帧 | no-op / 沉默（运行时托管） |
| 拒绝应答 | 握手前写回 socket | 从 fetch 返回 | 从 fetch 返回 |
| 未知 ws 路径 | 销毁 socket | 落回 HTTP | 落回 HTTP |
