# Edge 适配器（`s200/cloudflare`）

Cloudflare Workers 直接消费核心 —— `handle` 本身已是 Web Standard handler，适配器是一行薄层。

## Cloudflare Workers（`s200/cloudflare`）

```ts
import { createHandler } from 's200/cloudflare';
export default createHandler(app);
```

`createHandler(app)` → `WorkerHandler` —— module worker 的 default 导出形状：

```ts
type WorkerHandler = {
  fetch(
    request: Request,
    env: Record<string, unknown>,
    ctx: { waitUntil(promise: Promise<unknown>): void }
  ): Promise<Response> | Response;
};
```

Workers 在客户端断开时中止 fetch handler 请求的信号；适配器做特性检测并把该信号作为 `init.signal` 交给 `handle`，因此断线时体读取与 `ctx.signal` 消费者会立即取消。这里同样没有写完成事件，[`onFinish`](/zh/api/node#onfinish) 回调由响应体承载：cancel → `{ aborted: true }`、完成 → `{ aborted: false }`，恰好一次；空 body 响应在 handler 返回它时即告完成。

Workers 上的 WebSocket 升级与该适配器组合：[`s200/websocket/cloudflare`](/zh/api/websocket#cloudflare-s200-websocket-cloudflare) 的 `createCloudflareWebSocketBridge(app)` 应答握手，其余请求落回 `createHandler` 的 fetch。
