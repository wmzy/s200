# Edge 适配器（`s200/deno`、`s200/cloudflare`）

Deno 与 Cloudflare Workers 直接消费核心 —— `handle` 本身已是 Web Standard handler，两个适配器都是一行薄层。

## Deno（`s200/deno`）

```ts
import { serve } from 's200/deno';
const server = serve(app, { port: 8000 });
await server.finished;          // 服务器停止时 resolve
```

`serve(app, options?)` → `DenoServer`：

| 字段 | 含义 |
| --- | --- |
| `server` | `Deno.serve` 实例：`{ finished: Promise<void>; shutdown(): Promise<void> }` |
| `url` | `http://host:port`（`0.0.0.0` 主机报告为 `127.0.0.1`） |
| `port` | 已绑定端口 |
| `close()` | `server.shutdown()` |

`DenoServeOptions`：`{ port?, hostname?, onListen? }` —— `port` 默认 `8000`。Deno 不回传临时端口，重要时请显式指定。Deno 在客户端断开时中止 fetch handler 请求的信号；适配器做特性检测并把该信号作为 `init.signal` 传入 `handle`，实现协作取消。

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

Workers 在客户端断开时中止 fetch handler 请求的信号；适配器做特性检测并把该信号作为 `init.signal` 交给 `handle`，因此断线时体读取与 `ctx.signal` 消费者会立即取消。
