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

`DenoServeOptions`: `{ port?, hostname?, onListen? }` — `port` defaults to `8000`. Deno does not report an ephemeral port back, so pick one explicitly when it matters. Deno aborts the fetch-handler request's signal on client disconnect; the adapter feature-detects it and passes that signal into `handle` (`init.signal`) for cooperative cancellation.

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

Workers abort the fetch-handler request's signal on client disconnect; the adapter feature-detects it and hands that signal to `handle` (`init.signal`), so body reads and `ctx.signal` consumers cancel promptly on disconnect.
