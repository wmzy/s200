# ws-chat — WebSocket rooms

Multi-room chat over s200's zero-dependency RFC 6455 server. Demonstrates
the **`s200/websocket`** battery: `upgradeWebSocket` registering
`/chat/:room`, and the node adapter's `createUpgradeHandler` wired into
`serve`'s `upgrade` option. The room state is plain data — a
`Map<string, Set<Peer>>` roster updated from the socket surface
(`send`/`onMessage`/`onClose`), with messages broadcast as JSON frames:

```json
{"type":"system","room":"room1","text":"grace joined","members":2}
{"type":"message","room":"room1","from":"ada","text":"hello"}
```

Semantics worth noting: ws routes live **beside** the HTTP route table, so
a plain `GET /chat/room1` (no `Upgrade` header) never matches them — it
falls through `serveStatic` to the default 404. Only the server's
`'upgrade'` event reaches ws dispatch.

- `WS /chat/:room?name=…` — join, broadcast, leave (roster events + cleanup)
- `GET /` — `public/chat.html`, a minimal chat page (`WebSocket` client)

## Run

```sh
pnpm install
pnpm build          # workspace root once — app.ts imports the built s200 entries
pnpm --filter @s200-example/ws-chat start
# open http://localhost:3000/ in two tabs (different names, same room)
```

## Try it

```sh
wscat -c 'ws://localhost:3000/chat/lobby?name=ada'
# in another terminal:
wscat -c 'ws://localhost:3000/chat/lobby?name=grace'   # both see the join + each other's messages
wscat -c 'ws://localhost:3000/chat/other?name=linus'   # isolated from lobby
```

## Smoke

```sh
pnpm --filter @s200-example/ws-chat smoke
# or: cd examples/ws-chat && node smoke.ts
```

Two layers, both driving the real `app.ts` against the workspace `src/`
(via `../ts-resolve.mjs`, which redirects the public `s200*` entry names)
on an ephemeral port:

1. `smoke.ts` (node) — HTTP-level checks: the chat page serves, and
   `GET /chat/room1` without an `Upgrade` header is a 404.
2. `smoke-ws.ts` (bun, spawned by `smoke.ts`) — a real ws round trip with
   bun's native WebSocket client: two peers in room1 see join/broadcast/
   leave events with correct roster sizes, and a third peer in room2 never
   sees room1 traffic. Skipped with a logged note when bun is missing.

Both close their sockets/server and exit 0.
