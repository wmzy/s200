# Edge Adapters (`s200/deno`, `s200/cloudflare`)

Deno and Cloudflare Workers consume the core directly — `handle` is already a Web Standard handler, so both adapters are one line over it.

## Deno (`s200/deno`)

```ts
import { serve } from 's200/deno';
const server = serve(app, { port: 8000 });
await server.finished;          // resolves when the server stops
```

`serve(app, options?)` → `DenoServer`:

| Field | Meaning |
| --- | --- |
| `server` | The `Deno.serve` instance: `{ finished: Promise<void>; shutdown(): Promise<void> }` |
| `url` | `http://host:port` (a `0.0.0.0` host reports as `127.0.0.1`) |
| `port` | Bound port |
| `close()` | `server.shutdown()` |

`DenoServeOptions`: `{ port?, hostname?, onListen? }` — `port` defaults to `8000`. Pass `port: 0` for an ephemeral port — the bound port still reaches `onListen`, but `server.port`/`server.url` keep the requested value, so pick one explicitly when reading them. Deno aborts the fetch-handler request's signal on client disconnect; the adapter feature-detects it and passes that signal into `handle` (`init.signal`) for cooperative cancellation. Deno.serve has no write-completion event, so [`onFinish`](/api/node#onfinish) callbacks ride the response body: when any are registered the adapter wraps the body — cancel (client gone → `{ aborted: true }`) or completion (`{ aborted: false }`) runs them exactly once; a null-body response finishes as soon as the handler returns it.

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

Workers abort the fetch-handler request's signal on client disconnect; the adapter feature-detects it and hands that signal to `handle` (`init.signal`), so body reads and `ctx.signal` consumers cancel promptly on disconnect. There is no write-completion event either, so [`onFinish`](/api/node#onfinish) callbacks ride the response body the same way as on Deno: cancel → `{ aborted: true }`, completion → `{ aborted: false }`, exactly once; a null-body response finishes when the handler returns it.
