# WebSocket (`s200/websocket`, `s200/websocket/node`, `s200/websocket/bun`, `s200/websocket/cloudflare`)

WebSocket routes in the `data + functions` shape: `upgradeWebSocket` records `pattern → handler` routes on the app (pure data), and the runtime adapters consult the registry when a connection upgrades. Patterns use the router's segment syntax (`:param`, terminal `*rest`); matching is strict and first registration wins, exactly like HTTP routes. Upgrades run the app's middleware chain and the route's middlewares before the handshake completes — [Middleware & auth on upgrades](#middleware--auth-on-upgrades).

## Registration (`s200/websocket`)

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
// workers: ws.upgrade(request) ?? createHandler(app).fetch(…) — see below
```

| Function | Meaning |
| --- | --- |
| `upgradeWebSocket(app, pattern, ...middlewares, handler, options?)` | Registers route-scoped middlewares + a handler; returns the app |
| `matchWebSocket(app, pathname)` | Longest-match lookup against the registry → `WebSocketMatch \| undefined` |
| `resolveUpgrade(app, route, request, url, params)` | Runs the app + route middleware chain → `WsUpgradeDecision` (adapters' shared decision helper) |
| `createWsCtx(req, url, params)` | Builds a request-shaped `Ctx` (params/query/url) for a handler |
| `negotiateProtocol(offered, serverProtocols)` | The adapters' shared subprotocol rule: splits the offered `sec-websocket-protocol` header, server preference order — the first declared protocol the client also offered wins, `undefined` when none matches |
| `createWsSession()` | Fresh listener bag (`onMessage`/`onClose`/`onError`/`onPong` lists) backing one connection's socket registrations |
| `createWsSocket(session, protocol, transport)` | The adapters' shared socket factory: builds the `WsSocket` API around runtime transport closures (`send`/`close`/`ping`/`bufferedAmount`, optional `subscribePong`) |
| `runWsHandler(handler, socket, ctx, session, close)` | Runs the handler outside the middleware chain; a rejection fans out to `session.onError` and closes 1011 through `close` |

`upgradeWebSocket` mirrors the HTTP registrars' variadic shape: every argument between the pattern and the terminal handler is a route-scoped middleware, and the old four-argument form (`handler, options?` with no middlewares) keeps working.

`WebSocketRoute`: `{ pattern, segments, middlewares, handler, protocols?, perMessageDeflate? }` — one registry entry. The registry lives off-app (a `WeakMap` beside the app), so the core `App` shape stays HTTP-only and WebSocket state tree-shakes out of every non-WS consumer. `WebSocketMatch`: `{ route, params }` — what `matchWebSocket` returns.

`WebSocketRouteOptions`: `{ protocols?: readonly string[]; perMessageDeflate?: boolean }` — subprotocols in server preference order (the first one the client also offered wins); permessage-deflate (RFC 7692) negotiated as no-context-takeover both ways (node adapter implements it; the bun bridge leaves compression to Bun's native negotiation; Workers does not negotiate compression, so the cloudflare bridge ignores the flag).

`WsSocket` — the server side of one connection, plain function properties (no event-emitter object, no classes):

| Member | Meaning |
| --- | --- |
| `send(data)` | Text or binary message; best-effort backpressure (the runtime queues internally) |
| `bufferedAmount` | Bytes the transport has queued but not yet put on the wire — send-side backpressure visibility: grows while `send` outruns the network, drains back to `0` as the socket flushes (node: the socket's `writableLength`; bun: Bun's per-connection counter; cloudflare: Workers exposes no counter, so it stays `0`) |
| `close(code?, reason?)` | Starts the close handshake |
| `protocol` | The negotiated subprotocol, when the route declared protocols and the client offered one |
| `ping(payload?)` / `onPong(cb)` | Keep-alive primitive — pair them to detect dead peers (cloudflare: Workers manages keep-alive itself — `ping` forwards only if the runtime grows an API, `onPong` stays silent) |
| `onMessage(cb)` | `cb(data: WsData)` — `string \| ArrayBuffer \| Uint8Array` |
| `onClose(cb)` | Fires once with the negotiated close code (`1006` when the connection dropped without a close frame) |
| `onError(cb)` | Transport/processing errors on this connection |

Callback signatures: `WsMessageCb` = `(data: WsData) => void`, `WsCloseCb` = `(code: number, reason: string) => void`, `WsErrorCb` = `(error: Error) => void`.

`WebSocketHandler`: `(socket: WsSocket, ctx: Ctx) => void | Promise<void>`.

## Middleware & auth on upgrades

WebSocket upgrades run the app's middleware chain — the same `use(app, …)` middlewares as HTTP — and then the route's own middlewares, before the handshake completes. A middleware answers by writing `ctx.res` (or returning a `Response`, or throwing): that response rejects the upgrade and is answered as plain HTTP instead of `101` — the node adapter writes it to the socket before any protocol byte, the bun and cloudflare bridges return it from the fetch handler. An auth gate is therefore one ordinary middleware:

```ts
import { httpError, use } from 's200';
import { upgradeWebSocket } from 's200/websocket';

// App-level: gates every upgrade on the app (HTTP requests too, if you
// don't scope it) — a missing token rejects the handshake with 401.
use(app, async (ctx, next) => {
  const user = await verifyToken(ctx.req.headers.get('authorization'));
  if (user === null) {
    ctx.res = new Response('missing token', { status: 401 });
    return;
  }
  ctx.state.user = user;
  await next();
});

// Route-level: same shape as the HTTP registrars.
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

The exact semantics, mirroring HTTP dispatch:

- **Order** — app middlewares first (prefix-scoped `use(app, '/ws', …)` groups included — scoping checks `ctx.url.pathname`), then the route's middlewares, in registration order; unwinding is reverse, exactly like an HTTP chain.
- **Rejection** — any middleware writing `ctx.res`, returning a `Response`, or throwing rejects the upgrade; the client receives that HTTP response (a thrown `HttpError` maps to its status and `{ error }` envelope, anything else goes through the app's `onError`/`logError` policy — a silent custom `onError` falls back to the default mapping, since an upgrade has no fallback body). `setHeader`/`setHeaders` entries pending on the ctx ride the rejection response.
- **Approval** — when the chain settles with `ctx.res` still `undefined`, the upgrade proceeds: the socket is the response. Middlewares observe `res: undefined` on unwind, and every `ctx.state` mutation rides into the handler's ctx (the same ctx object — `resolveUpgrade` hands it back to the adapter). A middleware that neither answers nor calls `next()` approves implicitly — call `next()` or answer, there is no third branch.
- **The handler itself runs after approval**, outside the chain: errors it throws do not pass through the middlewares again (they surface through `socket.onError` + close 1011, the pre-existing behavior).

`resolveUpgrade(app, route, request, url, params)` is the shared decision helper every adapter calls — `WsUpgradeDecision` is `{ ok: true; ctx: Ctx }` or `{ ok: false; response: Response }`. It exists for adapter authors; applications get the same behavior from `serve` + `createUpgradeHandler` / `createBunWebSocketBridge` / `createCloudflareWebSocketBridge`. The same is true of the connection-phase helpers: `negotiateProtocol` runs the shared subprotocol rule, and `createWsSession` + `createWsSocket` + `runWsHandler` build each runtime's socket — an adapter supplies only its transport closures (node's RFC 6455 framing, bun's `ArrayBuffer`→view coercion, workerd's optional `ping`/`bufferedAmount`).

## Node (`s200/websocket/node`)

A zero-dependency RFC 6455 server: handshake, text/binary messages with fragmentation, ping/pong, close handshake, and a payload budget. Opt-in subprotocol negotiation and permessage-deflate are implemented here.

```ts
import { createUpgradeHandler } from 's200/websocket/node';
const server = await serve(app, { port: 3000, upgrade: createUpgradeHandler(app) });
// plain ws:// — or wss:// by pairing upgrade with https (only http2: true excludes it)
```

| Function | Meaning |
| --- | --- |
| `createUpgradeHandler(app, options?)` | Builds the http server's `'upgrade'` callback: matches the path against the app's WebSocket routes, runs the app + route middleware chain (a rejection is answered as plain HTTP instead of `101`), answers the handshake, and runs the matched handler per connection. Unknown paths destroy the socket; invalid handshakes get a 400 |

`NodeUpgradeOptions`: `{ maxPayload?: number }` — maximum accumulated message size, default **4 MiB**. The budget is enforced at **header-parse time**: a data frame whose declared length alone exceeds `maxPayload` — or a continuation that would push an in-progress fragmented message past it — fails the connection with `1009` immediately, before a single payload byte is buffered (a client declaring a 2^40-byte frame gets its `1009` after a few bytes, not after a terabyte). Control frames are exempt — RFC 6455 already caps them at 125 bytes. The post-buffer checks remain as defense in depth for the accumulated case. `NodeUpgradeHandler`: `(req: IncomingMessage, socket: Duplex, head: Buffer) => void` — also the `upgrade` option type of `s200/node`'s `serve`.

## Bun (`s200/websocket/bun`)

Turns the app's WebSocket registry into `Bun.serve`'s `websocket` option plus an upgrade decision, passed through `s200/bun`'s `serve`. Bun implements the protocol; this module only routes upgrades and maps Bun's per-connection callbacks onto the `WsSocket` surface (including subprotocol negotiation, mirrored from the node adapter so both runtimes pick identically). `socket.bufferedAmount` is backed by Bun's per-connection `getBufferedAmount()` counter.

```ts
import { createBunWebSocketBridge } from 's200/websocket/bun';
serve(app, { port: 3000, websocket: createBunWebSocketBridge(app) });
```

| Function / Type | Meaning |
| --- | --- |
| `createBunWebSocketBridge(app)` | `{ upgrade, websocket }` — `upgrade(req, server)` decides inside the fetch handler whether the request becomes a WebSocket (the app + route middleware chain runs first; a rejecting middleware's `Response` is answered as plain HTTP); `websocket` carries the per-connection callbacks |
| `BunWebSocketBridge` | `{ upgrade: (req, server: BunUpgrader) => Promise<boolean \| Response>; websocket: BunWsHandlers }` — `true` = upgraded, a `Response` = rejection, `false` = not a ws route |
| `BunUpgrader` | The `server` Bun hands its fetch handler: `upgrade(request, options?) => boolean` |
| `BunWs` / `BunWsHandlers` | Bun's per-connection socket and the `open`/`message`/`close`/`pong` callback set, narrowed to the members used |

## Cloudflare (`s200/websocket/cloudflare`)

The Workers counterpart: a module worker's `fetch` returns a `Response`, so the bridge composes with [`s200/cloudflare`](/api/edge)'s `createHandler` — `ws.upgrade(request)` answers WebSocket handshakes, `undefined` falls through to the HTTP fetch. Workerd implements the protocol; the bridge only routes the upgrade (the `new WebSocketPair()` + `status: 101` + `init.webSocket` idiom) and maps the pair's server half onto the `WsSocket` surface, subprotocol negotiation included (server preference order, mirrored from the node adapter; the negotiated protocol also rides the 101 response's `sec-websocket-protocol` header so the runtime completes the handshake).

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

`upgrade(request)` answers: a `101` `Response` carrying the pair's client half (return it straight from `fetch`), the rejection `Response` when a middleware denied the handshake (plain HTTP), or `undefined` when the request carries no `Upgrade: websocket` header or matches no ws route (the HTTP chain's caller). On Workers without `WebSocketPair` (a non-workerd host importing the bridge) it answers `501` instead of crashing.

| Function / Type | Meaning |
| --- | --- |
| `createCloudflareWebSocketBridge(app)` | `{ upgrade }` — the ws half of the worker's `fetch`; handler and ctx threading match the other bridges |
| `CloudflareWebSocketBridge` | `{ upgrade: (request: Request) => Promise<Response \| undefined> }` — a `Response` is the answer, `undefined` falls through to HTTP |
| `CloudflareWebSocket` / `CloudflareWebSocketPair` | One endpoint of a Workers `WebSocketPair` / the `{ 0: client, 1: server }` pair value, narrowed to the members used |

Workers-specific notes: the runtime replies to close frames automatically (compatibility dates from 2026-04-07 — older dates leave the reciprocal close to the handler, so call `socket.close()` in `onClose` there); `socket.bufferedAmount` stays `0` (workerd exposes no counter); `socket.ping()` is a no-op and `onPong` never fires (workerd manages keep-alive itself — the bridge forwards both if a future runtime grows the API); `perMessageDeflate` is ignored (Workers does not negotiate compression).

### The three bridges at a glance

| | node (`websocket/node`) | bun (`websocket/bun`) | cloudflare (`websocket/cloudflare`) |
| --- | --- | --- | --- |
| Integration | `serve(app, { upgrade })` | `serve(app, { websocket })` | `ws.upgrade(request) ?? worker.fetch(…)` |
| Protocol by | s200's zero-dependency RFC 6455 server | Bun's native ws | workerd's native ws |
| Subprotocols | server preference order | same | same (+ header on the 101) |
| `perMessageDeflate` | implemented (opt-in) | Bun's negotiation | ignored |
| `bufferedAmount` | socket `writableLength` | Bun's counter | `0` (not exposed) |
| `ping` / `onPong` | frames | frames | no-op / silent (runtime-managed) |
| Rejection answer | written to the socket pre-handshake | returned from fetch | returned from fetch |
| Unknown ws path | socket destroyed | falls through to HTTP | falls through to HTTP |
