import type { WsData, WsSocket } from '../src/websocket';

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, it } from 'vitest';

import { createApp, use } from '../src/app';
import { httpError } from '../src/errors';
import { upgradeWebSocket } from '../src/websocket';
import {
  createCloudflareWebSocketBridge,
  type CloudflareWebSocket,
} from '../src/websocket-cloudflare';

/** Flushes the handler microtask (the bridge starts route handlers on
 * `Promise.resolve().then`, exactly like the bun bridge). */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

type FakeListener = (event: unknown) => void;

type FakePair = {
  readonly pair: { 0: CloudflareWebSocket; 1: CloudflareWebSocket };
  readonly client: CloudflareWebSocket;
  readonly server: CloudflareWebSocket;
  emit(type: string, event: unknown): void;
  readonly sent: WsData[];
  readonly closes: ([number | undefined, string | undefined])[];
  readonly pings: (string | Uint8Array | undefined)[];
  accepts(): number;
};

/** A structural stand-in for `new WebSocketPair()` — two plain objects
 * sharing one listener map, so `emit` drives exactly what the bridge
 * registered. Extras toggle the members workerd does not guarantee
 * (`bufferedAmount`, `ping`). */
const createFakePair = (extras: { bufferedAmount?: number; withPing?: boolean } = {}): FakePair => {
  const listeners = new Map<string, FakeListener[]>();
  const sent: WsData[] = [];
  const closes: ([number | undefined, string | undefined])[] = [];
  const pings: (string | Uint8Array | undefined)[] = [];
  let accepted = 0;
  // One seam cast per end: the plain object satisfies every member the
  // bridge touches; the overloaded `addEventListener` target demands
  // exact listener shapes a single generic fake cannot spell strictly.
  const makeEnd = (): CloudflareWebSocket =>
    ({
      accept() {
        accepted += 1;
      },
      send(data: WsData) {
        sent.push(data);
      },
      close(code?: number, reason?: string) {
        closes.push([code, reason]);
      },
      addEventListener(type: string, listener: FakeListener) {
        const list = listeners.get(type) ?? [];
        list.push(listener);
        listeners.set(type, list);
      },
      ...(extras.bufferedAmount !== undefined ? { bufferedAmount: extras.bufferedAmount } : {}),
      ...(extras.withPing === true
        ? { ping: (data?: string | Uint8Array) => { pings.push(data); } }
        : {}),
    }) as CloudflareWebSocket;
  const client = makeEnd();
  const server = makeEnd();
  return {
    pair: { 0: client, 1: server },
    client,
    server,
    emit(type: string, event: unknown) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    sent,
    closes,
    pings,
    accepts: () => accepted,
  };
};

/** Installs a fake `WebSocketPair` global — a function expression works
 * under `new` (a constructor returning an object overrides the instance;
 * an arrow function would throw "not a constructor"). The bridge resolves
 * the global lazily inside `upgrade`. */
const installPair = (fake: FakePair): void => {
  (globalThis as { WebSocketPair?: unknown }).WebSocketPair = function () {
    return fake.pair;
  };
};

const uninstallPair = (): void => {
  delete (globalThis as { WebSocketPair?: unknown }).WebSocketPair;
};

afterEach(uninstallPair);

const handshake = (path: string, headers: Record<string, string> = {}): Request =>
  new Request(`http://worker${path}`, {
    headers: { upgrade: 'websocket', ...headers },
  });

describe('cloudflare websocket bridge (unit)', () => {
  it('returns the documented bridge shape', () => {
    const bridge = createCloudflareWebSocketBridge(createApp());
    bridge.should.not.equal(undefined);
    (typeof bridge.upgrade).should.equal('function');
    // Structural probe: the object shape matches the exported type.
    Object.keys(bridge).should.deep.equal(['upgrade']);
  });

  it('upgrades a matched handshake: 101 response carrying the pair client', async () => {
    const app = createApp();
    use(app, async (ctx, next) => {
      ctx.state.user = 'alice';
      await next();
    });
    let seen: WsSocket | undefined;
    let room: unknown;
    let user: unknown;
    upgradeWebSocket(app, '/chat/:room', (socket, ctx) => {
      seen = socket;
      room = ctx.params.room;
      user = ctx.state.user;
    });
    const fake = createFakePair();
    installPair(fake);
    const res = await createCloudflareWebSocketBridge(app).upgrade(handshake('/chat/general'));
    // Node's undici Response rejects status 101, so the unit path asserts
    // the documented stand-in (real workerd asserts the native 101 in the
    // smoke + the miniflare section below).
    res!.should.not.equal(undefined);
    res!.status.should.equal(101);
    const carried: unknown = (res as Response & { webSocket?: unknown }).webSocket;
    (carried === fake.client).should.be.true;
    // The pair's server half was accepted exactly once, before the handler.
    fake.accepts().should.equal(1);
    await tick();
    (seen !== undefined).should.be.true;
    room!.should.equal('general');
    user!.should.equal('alice');
    res!.headers.has('sec-websocket-protocol').should.be.false;
  });

  it('negotiates subprotocols in server preference order', async () => {
    const app = createApp();
    let protocol: unknown;
    upgradeWebSocket(app, '/proto', (socket) => {
      protocol = socket.protocol;
    }, { protocols: ['chat.b', 'chat.a'] });
    const fake = createFakePair();
    installPair(fake);
    const res = await createCloudflareWebSocketBridge(app).upgrade(
      handshake('/proto', { 'sec-websocket-protocol': 'chat.a, chat.b' })
    );
    res!.status.should.equal(101);
    (res!.headers.get('sec-websocket-protocol') ?? '').should.equal('chat.b');
    await tick();
    protocol!.should.equal('chat.b');
  });

  it('leaves protocol unset when the client offers no shared one', async () => {
    const app = createApp();
    let protocol: unknown = 'sentinel';
    upgradeWebSocket(app, '/proto', (socket) => {
      protocol = socket.protocol;
    }, { protocols: ['chat.a'] });
    installPair(createFakePair());
    const res = await createCloudflareWebSocketBridge(app).upgrade(
      handshake('/proto', { 'sec-websocket-protocol': 'other' })
    );
    res!.status.should.equal(101);
    res!.headers.has('sec-websocket-protocol').should.be.false;
    await tick();
    (protocol === undefined).should.be.true;
  });

  it('falls through to HTTP for plain GETs and unregistered paths', async () => {
    const app = createApp();
    upgradeWebSocket(app, '/ws', () => undefined);
    const bridge = createCloudflareWebSocketBridge(app);
    // No upgrade header: the same path is an ordinary HTTP request.
    const plain = await bridge.upgrade(new Request('http://worker/ws'));
    (plain === undefined).should.be.true;
    // Handshake to a path with no ws route: also the HTTP chain's caller.
    const unmatched = await bridge.upgrade(handshake('/nope'));
    (unmatched === undefined).should.be.true;
  });

  it('answers a middleware rejection as plain HTTP without touching a pair', async () => {
    const app = createApp();
    upgradeWebSocket(
      app,
      '/gated',
      async (ctx) => {
        ctx.res = new Response('no token', { status: 401 });
      },
      () => undefined
    );
    const fake = createFakePair();
    installPair(fake);
    const res = await createCloudflareWebSocketBridge(app).upgrade(handshake('/gated'));
    res!.status.should.equal(401);
    (await res!.text()).should.equal('no token');
    fake.accepts().should.equal(0);
  });

  it('maps a thrown HttpError to its status and envelope', async () => {
    const app = createApp();
    upgradeWebSocket(
      app,
      '/denied',
      async () => {
        throw httpError(403, 'ops room is admin-only');
      },
      () => undefined
    );
    const res = await createCloudflareWebSocketBridge(app).upgrade(handshake('/denied'));
    res!.status.should.equal(403);
    (await res!.json()).should.deep.equal({ error: 'ops room is admin-only' });
  });

  it('answers 501 when the runtime has no WebSocketPair global', async () => {
    uninstallPair();
    const app = createApp();
    upgradeWebSocket(app, '/ws', () => undefined);
    const res = await createCloudflareWebSocketBridge(app).upgrade(handshake('/ws'));
    res!.status.should.equal(501);
  });
});

describe('cloudflare WsSocket adapter (unit)', () => {
  const drive = async (
    extras: { bufferedAmount?: number; withPing?: boolean } = {}
  ): Promise<{ fake: FakePair; socket: WsSocket }> => {
    const app = createApp();
    let socket: WsSocket | undefined;
    upgradeWebSocket(app, '/ws', (s) => {
      socket = s;
    });
    const fake = createFakePair(extras);
    installPair(fake);
    await createCloudflareWebSocketBridge(app).upgrade(handshake('/ws'));
    await tick();
    return { fake, socket: socket! };
  };

  it('maps send, bufferedAmount, ping and close defaults', async () => {
    const { fake, socket } = await drive({ bufferedAmount: 42, withPing: true });
    const bytes = new Uint8Array([1, 2, 3]);
    const buffer = new ArrayBuffer(2);
    socket.send('text');
    socket.send(bytes);
    socket.send(buffer);
    fake.sent.should.deep.equal(['text', bytes, buffer]);
    socket.bufferedAmount.should.equal(42);
    socket.ping('x');
    socket.ping();
    fake.pings.should.deep.equal(['x', undefined]);
    socket.close();
    socket.close(4400, 'bye');
    fake.closes.should.deep.equal([
      [1000, ''],
      [4400, 'bye'],
    ]);
  });

  it('reports bufferedAmount 0 and no-op ping when the runtime exposes neither', async () => {
    const { socket } = await drive();
    socket.bufferedAmount.should.equal(0);
    socket.ping('x'); // no throw, no crash — workerd manages keep-alive itself
  });

  it('forwards message, close and error events to registered callbacks', async () => {
    const { fake, socket } = await drive();
    const received: WsData[] = [];
    const closed: [number, string][] = [];
    const errors: Error[] = [];
    let pongs = 0;
    socket.onMessage((data) => received.push(data));
    socket.onClose((code, reason) => closed.push([code, reason]));
    socket.onError((error) => errors.push(error));
    socket.onPong(() => {
      pongs += 1;
    });
    fake.emit('message', { data: 'hi' });
    const buffer = new ArrayBuffer(2);
    fake.emit('message', { data: buffer });
    fake.emit('close', { code: 1000, reason: 'done' });
    fake.emit('error', new Error('boom'));
    fake.emit('error', 'not an error');
    fake.emit('pong', {});
    received.should.deep.equal(['hi', buffer]);
    closed.should.deep.equal([[1000, 'done']]);
    (errors[0] instanceof Error).should.be.true;
    errors[0]!.message.should.equal('boom');
    (errors[1] instanceof Error).should.be.true;
    pongs.should.equal(1);
  });

  it('surfaces handler errors through onError and closes 1011', async () => {
    const app = createApp();
    const errors: Error[] = [];
    upgradeWebSocket(app, '/boom', (socket) => {
      socket.onError((error) => errors.push(error));
      throw new Error('kaboom');
    });
    const fake = createFakePair();
    installPair(fake);
    await createCloudflareWebSocketBridge(app).upgrade(handshake('/boom'));
    await tick();
    errors.should.have.length(1);
    errors[0]!.message.should.equal('kaboom');
    fake.closes.should.deep.equal([[1011, 'handler error']]);
  });

  it('fans out a throwing message callback through onError and closes 1011', async () => {
    // A callback that throws mid-dispatch must not escape into workerd's
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
    const fake = createFakePair();
    installPair(fake);
    await createCloudflareWebSocketBridge(app).upgrade(handshake('/throw'));
    await tick();
    fake.emit('message', { data: 'x' });
    errors.should.have.length(1);
    errors[0]!.message.should.equal('mid-dispatch');
    fake.closes.should.deep.equal([[1011, 'handler error']]);
  });
});

// --- workerd section: real round trip through miniflare, when present. ---
// miniflare is not a devDependency (CI installs it transiently for the
// cloudflare job, which exercises this same round trip through
// scripts/smoke-cloudflare.mjs); locally the section auto-skips.

/** The miniflare surface this section uses — a runtime-resolved optional
 * tool, so the import goes through a non-literal specifier (no TS2307 on
 * machines without it; node still resolves it when installed). */
type MiniflareModule = {
  Miniflare: new (options: {
    modulesRoot: string;
    modules: { type: 'ESModule'; path: string }[];
    compatibilityDate: string;
  }) => {
    dispatchFetch(
      url: string,
      init?: { headers: Record<string, string> }
    ): Promise<Response & { webSocket?: CloudflareWebSocket }>;
    dispose(): Promise<void>;
  };
};

const importMiniflare = (): Promise<MiniflareModule> => {
  const specifier = 'miniflare';
  return import(/* @vite-ignore */ specifier) as Promise<MiniflareModule>;
};

const distDir = fileURLToPath(new URL('../dist', import.meta.url));
const distWsCloudflare = join(distDir, 'websocket-cloudflare.mjs');
const canUseWorkerd =
  existsSync(distWsCloudflare) &&
  (await importMiniflare()
    .then(() => true)
    .catch(() => false));

if (!canUseWorkerd) {
  console.log(
    'websocket-cloudflare: miniflare or dist/websocket-cloudflare.mjs unavailable — ' +
      'workerd round trip skipped (CI covers it via scripts/smoke-cloudflare.mjs)'
  );
}

describe.skipIf(!canUseWorkerd)('cloudflare websocket bridge on workerd (miniflare)', () => {
  it('round trips a real upgrade', async () => {
    const { Miniflare } = await importMiniflare();
    // workerd sees only the modules miniflare lists — copy the transitive
    // relative-import closure of the entry next to it (smoke script's trick).
    const dir = mkdtempSync(join(tmpdir(), 's200-ws-cloudflare-test-'));
    const entry = join(dir, 'worker.mjs');
    const copied: string[] = [];
    const queue = [
      distWsCloudflare,
      join(distDir, 'websocket.mjs'),
      join(distDir, 'cloudflare.mjs'),
      join(distDir, 'index.mjs'),
    ];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      cpSync(file, join(dir, basename(file)));
      copied.push(basename(file));
      const code = readFileSync(file, 'utf8');
      for (const match of code.matchAll(/from\s*["'](\.{1,2}\/[^"']+)["']/g)) {
        queue.push(join(distDir, match[1]!));
      }
    }
    writeFileSync(
      entry,
      `// Generated by test/websocket-cloudflare.test.ts — safe to delete.
import { createApp } from './index.mjs';
import { createHandler } from './cloudflare.mjs';
import { upgradeWebSocket } from './websocket.mjs';
import { createCloudflareWebSocketBridge } from './websocket-cloudflare.mjs';

const app = createApp();
upgradeWebSocket(app, '/echo/:room', (socket, ctx) => {
  socket.onMessage((data) => socket.send('[' + ctx.params.room + '] ' + String(data)));
});
const ws = createCloudflareWebSocketBridge(app);
const worker = createHandler(app);
export default {
  fetch: (request, env, ctx) =>
    ws.upgrade(request).then((res) => res ?? worker.fetch(request, env, ctx)),
};
`
    );
    const mf = new Miniflare({
      modulesRoot: dir,
      modules: [
        { type: 'ESModule' as const, path: entry },
        ...copied.map((name) => ({ type: 'ESModule' as const, path: join(dir, name) })),
      ],
      compatibilityDate: '2025-01-01',
    });
    try {
      const res = await mf.dispatchFetch('http://worker/echo/general', {
        headers: { upgrade: 'websocket' },
      });
      res.status.should.equal(101);
      const client = (res as Response & { webSocket?: CloudflareWebSocket }).webSocket;
      (client !== undefined).should.be.true;
      client!.accept();
      const echoed = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('echo timeout')), 5000);
        client!.addEventListener('message', (event) => {
          clearTimeout(timer);
          resolve(event.data);
        });
        client!.addEventListener('error', () => {
          clearTimeout(timer);
          reject(new Error('socket error'));
        });
        client!.send('hi');
      });
      String(echoed).should.equal('[general] hi');
      client!.close(1000, 'done');
    } finally {
      await mf.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
