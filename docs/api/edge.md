# Edge Adapters (`s200/cloudflare`)

Cloudflare Workers consume the core directly — `handle` is already a Web Standard handler, so the adapter is one line over it.

## Cloudflare Workers (`s200/cloudflare`)

```ts
import { createHandler } from 's200/cloudflare';
export default createHandler(app);
```

`createHandler(app)` → `WorkerHandler` — the module-worker default export shape:

```ts
type WorkerHandler = {
  fetch(
    request: Request,
    env: Record<string, unknown>,
    ctx: { waitUntil(promise: Promise<unknown>): void }
  ): Promise<Response> | Response;
};
```

Workers abort the fetch-handler request's signal on client disconnect; the adapter feature-detects it and hands that signal to `handle` (`init.signal`), so body reads and `ctx.signal` consumers cancel promptly on disconnect. There is no write-completion event either, so [`onFinish`](/api/node#onfinish) callbacks ride the response body: cancel → `{ aborted: true }`, completion → `{ aborted: false }`, exactly once; a null-body response finishes when the handler returns it.

WebSocket upgrades on Workers compose with this adapter: `createCloudflareWebSocketBridge(app)` from [`s200/websocket/cloudflare`](/api/websocket#cloudflare-s200-websocket-cloudflare) answers the handshakes, everything else falls through to `createHandler`'s fetch.
