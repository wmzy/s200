/**
 * WebSocket chat rooms — a slice of `s200/websocket` over the node
 * adapter's zero-dependency RFC 6455 server.
 *
 * Batteries on show:
 *   - `upgradeWebSocket` registering a ws route (`/chat/:room`) — ws
 *     routes live beside the HTTP route table, so plain GETs to the same
 *     path never match them (they fall through to the ordinary 404)
 *   - `createUpgradeHandler` wired into `serve`'s `upgrade` option
 *   - the socket surface: `send` / `onMessage` / `onClose` with a plain
 *     in-memory room roster (Map<room, Set<peer>>)
 *   - `serveStatic` for the chat page
 */
import type { App } from 's200';

import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createApp, use, serveStatic  } from 's200';
import { upgradeWebSocket } from 's200/websocket';
import { createFileReader, createFileStat, serve } from 's200/node';
import { createUpgradeHandler } from 's200/websocket/node';

const publicDir = fileURLToPath(new URL('./public', import.meta.url));

/** One connected chatter: a display name plus their socket's send. */
type Peer = { readonly name: string; readonly send: (data: string) => void };

/** Room roster — plain data, no classes, no event emitters. */
const rooms = new Map<string, Set<Peer>>();

const broadcast = (room: Set<Peer>, message: Record<string, unknown>): void => {
  const frame = JSON.stringify(message);
  for (const peer of room) {
    peer.send(frame);
  }
};

export const app: App = createApp();

// The chat page (chat.html, also served as the index at /).
use(
  app,
  serveStatic({
    read: createFileReader(publicDir),
    stat: createFileStat(publicDir),
    index: 'chat.html',
    cacheControl: 'no-cache',
  })
);

upgradeWebSocket(app, '/chat/:room', (socket, ctx) => {
  const roomName = ctx.params.room;
  const name = ctx.url.searchParams.get('name') ?? 'anon';
  const room = rooms.get(roomName) ?? new Set<Peer>();
  rooms.set(roomName, room);

  const peer: Peer = { name, send: (data) => socket.send(data) };
  room.add(peer);
  broadcast(room, { type: 'system', room: roomName, text: `${name} joined`, members: room.size });

  socket.onMessage((data) => {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    broadcast(room, { type: 'message', room: roomName, from: name, text });
  });

  socket.onClose(() => {
    room.delete(peer);
    if (room.size === 0) {
      rooms.delete(roomName);
    } else {
      broadcast(room, { type: 'system', room: roomName, text: `${name} left`, members: room.size });
    }
  });
});

export async function main(): Promise<void> {
  const server = await serve(app, {
    port: Number(process.env.PORT ?? 3000),
    upgrade: createUpgradeHandler(app),
  });
  console.log(`ws-chat listening on ${server.url} — open ${server.url}/ and pick a room`);
}

// Serve only when executed directly (`node app.ts`), not when smoke.ts
// imports the app to drive it on an ephemeral port.
const entry =
  process.argv[1] === undefined
    ? undefined
    : pathToFileURL(realpathSync(process.argv[1])).href;
if (entry === import.meta.url) {
  await main();
}
