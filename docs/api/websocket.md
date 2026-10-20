# WebSocket (`s200/websocket`, `s200/websocket/node`, `s200/websocket/bun`)

WebSocket routes in the `data + functions` shape: `upgradeWebSocket` records `pattern → handler` routes on the app (pure data), and the runtime adapters consult the registry when a connection upgrades. Patterns use the router's segment syntax (`:param`, terminal `*rest`); matching is strict and first registration wins, exactly like HTTP routes. Upgrades run the app's middleware chain and the route's middlewares before the handshake completes — [Middleware & auth on upgrades](#middleware--auth-on-upgrades).

## Registration (`s200/websocket`)

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

| Function | Meaning |
| --- | --- |
| `upgradeWebSocket(app, pattern, ...middlewares, handler, options?)` | Registers route-scoped middlewares + a handler; returns the app |
| `matchWebSocket(app, pathname)` | Longest-match lookup against the registry → `WebSocketMatch \| undefined` |
| `resolveUpgrade(app, route, request, url, params)` | Runs the app + route middleware chain → `WsUpgradeDecision` (adapters' shared decision helper) |
| `createWsCtx(req, url, params)` | Builds a request-shaped `Ctx` (params/query/url) for a handler |

`upgradeWebSocket` mirrors the HTTP registrars' variadic shape: every argument between the pattern and the terminal handler is a route-scoped middleware, and the old four-argument form (`handler, options?` with no middlewares) keeps working.

`WebSocketRoute`: `{ pattern, segments, middlewares, handler, protocols?, perMessageDeflate? }` — one registry entry. The registry lives off-app (a `WeakMap` beside the app), so the core `App` shape stays HTTP-only and WebSocket state tree-shakes out of every non-WS consumer. `WebSocketMatch`: `{ route, params }` — what `matchWebSocket` returns.

`WebSocketRouteOptions`: `{ protocols?: readonly string[]; perMessageDeflate?: boolean }` — subprotocols in server preference order (the first one the client also offered wins); permessage-deflate (RFC 7692) negotiated as no-context-takeover both ways (node adapter implements it; the bun bridge leaves compression to Bun's native negotiation).

`WsSocket` — the server side of one connection, plain function properties (no event-emitter object, no classes):

| Member | Meaning |
| --- | --- |
| `send(data)` | Text or binary message; best-effort backpressure (the runtime queues internally) |
| `close(code?, reason?)` | Starts the close handshake |
| `protocol` | The negotiated subprotocol, when the route declared protocols and the client offered one |
| `ping(payload?)` / `onPong(cb)` | Keep-alive primitive — pair them to detect dead peers |
| `onMessage(cb)` | `cb(data: WsData)` — `string \| ArrayBuffer \| Uint8Array` |
| `onClose(cb)` | Fires once with the negotiated close code (`1006` when the connection dropped without a close frame) |
| `onError(cb)` | Transport/processing errors on this connection |

Callback signatures: `WsMessageCb` = `(data: WsData) => void`, `WsCloseCb` = `(code: number, reason: string) => void`, `WsErrorCb` = `(error: Error) => void`.

`WebSocketHandler`: `(socket: WsSocket, ctx: Ctx) => void | Promise<void>`.

## Middleware & auth on upgrades

WebSocket upgrades run the app's middleware chain — the same `use(app, …)` middlewares as HTTP — and then the route's own middlewares, before the handshake completes. A middleware answers by writing `ctx.res` (or returning a `Response`, or throwing): that response rejects the upgrade and is answered as plain HTTP instead of `101` — the node adapter writes it to the socket before any protocol byte, the bun bridge returns it from the fetch handler. An auth gate is therefore one ordinary middleware:

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

`resolveUpgrade(app, route, request, url, params)` is the shared decision helper both adapters call — `WsUpgradeDecision` is `{ ok: true; ctx: Ctx }` or `{ ok: false; response: Response }`. It exists for adapter authors; applications get the same behavior from `serve` + `createUpgradeHandler` / `createBunWebSocketBridge`.

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

`NodeUpgradeOptions`: `{ maxPayload?: number }` — maximum accumulated message size, default 64 MiB; oversized messages close with `1009` before more is buffered. `NodeUpgradeHandler`: `(req: IncomingMessage, socket: Duplex, head: Buffer) => void` — also the `upgrade` option type of `s200/node`'s `serve`.

## Bun (`s200/websocket/bun`)

Turns the app's WebSocket registry into `Bun.serve`'s `websocket` option plus an upgrade decision, passed through `s200/bun`'s `serve`. Bun implements the protocol; this module only routes upgrades and maps Bun's per-connection callbacks onto the `WsSocket` surface (including subprotocol negotiation, mirrored from the node adapter so both runtimes pick identically).

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
