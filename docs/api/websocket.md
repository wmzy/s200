# WebSocket (`s200/websocket`, `s200/websocket/node`, `s200/websocket/bun`)

WebSocket routes in the `data + functions` shape: `upgradeWebSocket` records `pattern → handler` routes on the app (pure data), and the runtime adapters consult the registry when a connection upgrades. Patterns use the router's segment syntax (`:param`, terminal `*rest`); matching is strict and first registration wins, exactly like HTTP routes.

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
| `upgradeWebSocket(app, pattern, handler, options?)` | Registers a handler; returns the app |
| `matchWebSocket(app, pathname)` | Longest-match lookup against the registry → `WebSocketMatch \| undefined` |
| `createWsCtx(req, url, params)` | Builds a request-shaped `Ctx` (params/query/url) for a handler |

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

## Node (`s200/websocket/node`)

A zero-dependency RFC 6455 server: handshake, text/binary messages with fragmentation, ping/pong, close handshake, and a payload budget. Opt-in subprotocol negotiation and permessage-deflate are implemented here.

```ts
import { createUpgradeHandler } from 's200/websocket/node';
const server = await serve(app, { port: 3000, upgrade: createUpgradeHandler(app) });
// plain ws:// — or wss:// by pairing upgrade with https (only http2: true excludes it)
```

| Function | Meaning |
| --- | --- |
| `createUpgradeHandler(app, options?)` | Builds the http server's `'upgrade'` callback: matches the path against the app's WebSocket routes, answers the handshake, runs the matched handler per connection. Unknown paths destroy the socket; invalid handshakes get a 400 |

`NodeUpgradeOptions`: `{ maxPayload?: number }` — maximum accumulated message size, default 64 MiB; oversized messages close with `1009` before more is buffered. `NodeUpgradeHandler`: `(req: IncomingMessage, socket: Duplex, head: Buffer) => void` — also the `upgrade` option type of `s200/node`'s `serve`.

## Bun (`s200/websocket/bun`)

Turns the app's WebSocket registry into `Bun.serve`'s `websocket` option plus an upgrade decision, passed through `s200/bun`'s `serve`. Bun implements the protocol; this module only routes upgrades and maps Bun's per-connection callbacks onto the `WsSocket` surface (including subprotocol negotiation, mirrored from the node adapter so both runtimes pick identically).

```ts
import { createBunWebSocketBridge } from 's200/websocket/bun';
serve(app, { port: 3000, websocket: createBunWebSocketBridge(app) });
```

| Function / Type | Meaning |
| --- | --- |
| `createBunWebSocketBridge(app)` | `{ upgrade, websocket }` — `upgrade(req, server)` decides inside the fetch handler whether the request becomes a WebSocket; `websocket` carries the per-connection callbacks |
| `BunWebSocketBridge` | `{ upgrade: (req, server: BunUpgrader) => boolean; websocket: BunWsHandlers }` |
| `BunUpgrader` | The `server` Bun hands its fetch handler: `upgrade(request, options?) => boolean` |
| `BunWs` / `BunWsHandlers` | Bun's per-connection socket and the `open`/`message`/`close`/`pong` callback set, narrowed to the members used |
