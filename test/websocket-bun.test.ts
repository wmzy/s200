import type { BunUpgrader, BunWs } from '../src/websocket-bun';

import { describe, it } from 'vitest';

import { createApp } from '../src/app';
import { upgradeWebSocket } from '../src/websocket';
import { createBunWebSocketBridge } from '../src/websocket-bun';

/** Flushes the handler microtask (the bridge starts route handlers on
 * `Promise.resolve().then`, exactly like the cloudflare bridge). */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

type FakeWs = BunWs & { data?: unknown };

/** A fake Bun socket that records what crossed it. */
type RecordingWs = FakeWs & {
  readonly sent: (string | Uint8Array)[];
  readonly closes: [number, string][];
};

/** A structural stand-in for Bun's per-connection socket: every member
 * the bridge touches records what crossed it, and `data` carries the
 * upgrade record from the upgrader into `open` (one seam cast — the
 * plain object satisfies the narrowed BunWs shape). */
const createFakeWs = (): RecordingWs => {
  const sent: (string | Uint8Array)[] = [];
  const closes: [number, string][] = [];
  return {
    send: (data: string | Uint8Array): void => {
      sent.push(data);
    },
    close: (code: number, reason: string): void => {
      closes.push([code, reason]);
    },
    ping: (): void => {
      /* Bun's ping passthrough — nothing to record. */
    },
    getBufferedAmount: (): number => 0,
    sent,
    closes,
  } as RecordingWs;
};

/** An upgrader that stashes the data record onto the fake socket, the
 * seam Bun.serve provides via `ws.data`. */
const upgraderFor = (ws: FakeWs): BunUpgrader => ({
  upgrade: (_request, options) => {
    ws.data = options?.data;
    return true;
  },
});

const handshake = (path: string): Request =>
  new Request(`http://bun${path}`, { headers: { upgrade: 'websocket' } });

describe('bun websocket bridge (unit)', () => {
  it('delivers messages to registered callbacks and echoes nothing', async () => {
    const app = createApp();
    const received: unknown[] = [];
    upgradeWebSocket(app, '/chat', (socket) => {
      socket.onMessage((data) => received.push(data));
    });
    const ws = createFakeWs();
    const bridge = createBunWebSocketBridge(app);
    (await bridge.upgrade(handshake('/chat'), upgraderFor(ws))).should.equal(
      true
    );
    bridge.websocket.open?.(ws);
    await tick();
    bridge.websocket.message?.(ws, 'hi');
    received.should.deep.equal(['hi']);
    ws.closes.should.deep.equal([]);
  });

  it('fans out a throwing message callback through onError and closes 1011', async () => {
    // A callback that throws mid-dispatch must not escape into Bun's
    // event delivery — the shared containment contract (reportHandlerError)
    // applies to the message path, same as the node adapter.
    const app = createApp();
    const errors: Error[] = [];
    upgradeWebSocket(app, '/throw', (socket) => {
      socket.onError((error) => errors.push(error));
      socket.onMessage(() => {
        throw new Error('mid-dispatch');
      });
    });
    const ws = createFakeWs();
    const bridge = createBunWebSocketBridge(app);
    (await bridge.upgrade(handshake('/throw'), upgraderFor(ws))).should.equal(
      true
    );
    bridge.websocket.open?.(ws);
    await tick();
    bridge.websocket.message?.(ws, 'x');
    errors.should.have.length(1);
    errors[0]!.message.should.equal('mid-dispatch');
    ws.closes.should.deep.equal([[1011, 'handler error']]);
  });
});
