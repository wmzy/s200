# Adapters

## Serving

```ts
import { serve } from 's200/node';
const server = await serve(app, { port: 0 });  // 0 = ephemeral
// server: { server, url, port, close(): Promise<void> }

import { serve } from 's200/bun';
const server = serve(app, { port: 3000 });
```

Both adapters expose the identical `serve(app, options)` surface; the core's `handle(app, request)` is the entire integration contract for any runtime with a fetch-shaped handler — `s200/deno` (`serve(app)` over `Deno.serve`) and `s200/cloudflare` (`createHandler(app)` as the module worker's default export) are the one-line adapters for those runtimes.

## Light mode

`s200/node` has an opt-in **light mode** — `serve(app, { light: true })` swaps the platform's per-request `Request`/`Response` constructors for light-weight duck-typed ones (nothing global is patched, the Web Standard contract stays the default). On the light path `ctx.req.headers`/`ctx.res.headers` are `LightHeaders` — a duck `Headers` with the full structural API (`get`/`set`/`has`/`append`/`delete`/`getSetCookie`/iteration), case-insensitive, insertion-ordered, and a legal `HeadersInit` everywhere (platform constructors fill from its pair iterator); `instanceof Headers` is simply false there. See `../benchmarks.md`: light mode buys ~28–35% whole-request throughput (machine-dependent) and lands between the real-Web-Standard class and the patched one. The batteries ride the light path too — `compress`/`etag` work off the light response's synchronous bytes (streamed bodies pipe through `CompressionStream` unchanged), `stream`/`streamSSE` ride the light response's stream body, `serveStatic` serves byte bodies, streamed files, and byte ranges, and the request body readers (`readJson`/`readText`/`readForm`/`readStream`) read the light request's stream — client disconnects abort `ctx.signal` here exactly like on the default path.

## TLS

`s200/node` also serves TLS — HTTPS, or HTTP/2 over TLS — through the same dispatch pipeline. HTTPS combines with `upgrade` for WSS (the WebSocket handler runs on the decrypted connection); only `http2: true` forbids `upgrade`, since HTTP/2 has no upgrade event:

```ts
await serve(app, {
  port: 443,
  https: { key: await readFile('key.pem'), cert: await readFile('cert.pem') },      // node:https
});
await serve(app, {
  port: 443,
  https: { key, cert, http2: true },                                                  // node:http2
});
await serve(app, {
  port: 443,
  https: { key, cert },                                                               // WSS
  upgrade: createUpgradeHandler(app),
});
```

