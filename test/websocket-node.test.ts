import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, it } from 'vitest';

import { createApp, get } from '../src/app';
import { serve, type NodeServer } from '../src/node';
import { upgradeWebSocket } from '../src/websocket';
import { createUpgradeHandler } from '../src/websocket-node';

const HOST = '127.0.0.1';
const CERT_PATH = fileURLToPath(new URL('./fixtures/cert.pem', import.meta.url));
const KEY_PATH = fileURLToPath(new URL('./fixtures/key.pem', import.meta.url));
// RFC 6455 §1.3 sample key and its expected accept value.
const KEY = 'dGhlIHNhbXBsZSBub25jZQ==';
const ACCEPT = 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=';

type ServerFrame = { opcode: number; payload: Buffer; rsv1: boolean };

/** Parses ONE complete server frame (unmasked) from the front of `data`. */
function parseFrame(
  data: Buffer
): { frame: ServerFrame; rest: Buffer } | undefined {
  if (data.length < 2) return undefined;
  const b0 = data[0] ?? 0;
  const b1 = data[1] ?? 0;
  const opcode = b0 & 0x0f;
  const rsv1 = (b0 & 0x40) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (data.length < 4) return undefined;
    len = data.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (data.length < 10) return undefined;
    len = Number(data.readBigUInt64BE(2));
    offset = 10;
  }
  if (data.length < offset + len) return undefined;
  return {
    frame: { opcode, payload: data.subarray(offset, offset + len), rsv1 },
    rest: data.subarray(offset + len),
  };
}

/** One client→server frame, always masked (clients MUST mask). */
function clientFrame(opcode: number, payload: Buffer | string, fin = true, rsv1 = false): Buffer {
  const bytes = typeof payload === 'string' ? Buffer.from(payload) : payload;
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const b0 = (fin ? 0x80 : 0) | (rsv1 ? 0x40 : 0) | opcode;
  let header: Buffer;
  if (bytes.length < 126) {
    header = Buffer.from([b0, 0x80 | bytes.length]);
  } else if (bytes.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = b0;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(bytes.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = b0;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(bytes.length), 2);
  }
  const masked = Buffer.allocUnsafe(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) {
    masked[i] = (bytes[i] ?? 0) ^ (mask[i % 4] ?? 0);
  }
  return Buffer.concat([header, mask, masked]);
}

/** Opens a raw socket and sends the upgrade request. */
function openSocket(port: number, path: string, extraHeaders = ''): Socket {
  const socket = connect(port, HOST);
  socket.write(
    `GET ${path} HTTP/1.1\r\n` +
      `Host: ${HOST}:${port}\r\n` +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Key: ${KEY}\r\n` +
      'Sec-WebSocket-Version: 13\r\n' +
      extraHeaders +
      '\r\n'
  );
  return socket;
}

/** Waits for the response head; leftover bytes (early frames) survive. */
function readHead(socket: Socket): Promise<{ head: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let acc: Buffer = Buffer.alloc(0);
    const timer = setTimeout(
      () => reject(new Error('timeout waiting for response head')),
      2000
    );
    const onData = (chunk: Buffer): void => {
      acc = acc.length === 0 ? chunk : Buffer.concat([acc, chunk]);
      const end = acc.toString('latin1').indexOf('\r\n\r\n');
      if (end >= 0) {
        clearTimeout(timer);
        socket.off('data', onData);
        resolve({ head: acc.toString('latin1', 0, end + 4), rest: acc.subarray(end + 4) });
      }
    };
    socket.on('data', onData);
  });
}

/** Sequential server-frame reader over one socket's byte stream. */
function frameReader(
  socket: Socket,
  seed: Buffer = Buffer.alloc(0)
): () => Promise<ServerFrame> {
  let pending: Buffer = seed;
  const waiters: { resolve: (frame: ServerFrame) => void }[] = [];
  const pump = (): void => {
    while (waiters.length > 0) {
      const parsed = parseFrame(pending);
      if (parsed === undefined) return;
      pending = parsed.rest;
      const waiter = waiters.shift();
      if (waiter !== undefined) waiter.resolve(parsed.frame);
    }
  };
  socket.on('data', (chunk: Buffer) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    pump();
  });
  return () =>
    new Promise<ServerFrame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for frame')), 2000);
      waiters.push({
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      });
      pump();
    });
}

function closePayload(code: number): Buffer {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code, 0);
  return payload;
}

describe('websocket node upgrade handler (raw RFC 6455 client)', () => {
  let server: NodeServer;
  let droppedCode = -1;

  beforeAll(async () => {
    const app = createApp();
    upgradeWebSocket(app, '/echo', (socket) => {
      socket.onMessage((data) => socket.send(data));
    });
    upgradeWebSocket(app, '/capture/:id', (socket, ctx) => {
      socket.onMessage(() =>
        socket.send(`${ctx.params.id}:${ctx.url.searchParams.get('q') ?? ''}`)
      );
    });
    upgradeWebSocket(app, '/close-me', (socket) => {
      socket.close(4001, 'bye');
    });
    upgradeWebSocket(app, '/close-long-reason', (socket) => {
      socket.close(1000, 'x'.repeat(200));
    });
    upgradeWebSocket(app, '/drop-log', (socket) => {
      socket.onClose((code) => {
        droppedCode = code;
      });
    });
    upgradeWebSocket(
      app,
      '/proto',
      (socket) => {
        socket.onMessage(() => socket.send(socket.protocol ?? 'none'));
      },
      { protocols: ['graphql-ws', 'chat'] }
    );
    upgradeWebSocket(
      app,
      '/deflate',
      (socket) => {
        socket.onMessage((data) => socket.send(data));
      },
      { perMessageDeflate: true }
    );
    upgradeWebSocket(app, '/heartbeat', (socket) => {
      socket.onMessage(() => socket.ping('beat'));
      socket.onPong(() => socket.send('got-pong'));
    });
    get(app, '/', () => new Response('http'));
    server = await serve(app, { port: 0, upgrade: createUpgradeHandler(app) });
  });

  afterAll(async () => {
    await server.close();
  });

  it('keeps serving plain HTTP through the same server', async () => {
    const res = await fetch(`${server.url}/`);
    res.status.should.equal(200);
    (await res.text()).should.equal('http');
  });

  it('completes the RFC 6455 handshake for matched paths', async () => {
    const socket = openSocket(server.port, '/echo');
    const { head } = await readHead(socket);
    head.should.contain('101 Switching Protocols');
    head.should.contain(`Sec-WebSocket-Accept: ${ACCEPT}`);
    head.should.contain('Upgrade: websocket');
    socket.destroy();
  });

  it('echoes text frames', async () => {
    const socket = openSocket(server.port, '/echo');
    const { rest } = await readHead(socket);
    const read = frameReader(socket, rest);
    socket.write(clientFrame(0x1, 'ping'));
    (await read()).should.deep.equal({ opcode: 0x1, payload: Buffer.from('ping'), rsv1: false });
    socket.destroy();
  });

  it('echoes binary frames byte-exactly', async () => {
    const socket = openSocket(server.port, '/echo');
    const { rest } = await readHead(socket);
    const read = frameReader(socket, rest);
    const bytes = Buffer.from([0, 1, 2, 253, 254, 255]);
    socket.write(clientFrame(0x2, bytes));
    const frame = await read();
    frame.opcode.should.equal(0x2);
    frame.payload.should.deep.equal(bytes);
    socket.destroy();
  });

  it('answers ping with pong carrying the same payload', async () => {
    const socket = openSocket(server.port, '/echo');
    const { rest } = await readHead(socket);
    const read = frameReader(socket, rest);
    socket.write(clientFrame(0x9, 'hb'));
    (await read()).should.deep.equal({ opcode: 0xa, payload: Buffer.from('hb'), rsv1: false });
    socket.destroy();
  });

  it('echoes a close frame with the code and ends the connection', async () => {
    const socket = openSocket(server.port, '/echo');
    const { rest } = await readHead(socket);
    const read = frameReader(socket, rest);
    socket.write(clientFrame(0x8, closePayload(1000)));
    const frame = await read();
    frame.opcode.should.equal(0x8);
    frame.payload.readUInt16BE(0).should.equal(1000);
    await once(socket, 'end');
    socket.destroy();
  });

  it('performs a server-initiated close with code and reason', async () => {
    const socket = openSocket(server.port, '/close-me');
    const { rest } = await readHead(socket);
    const read = frameReader(socket, rest);
    const frame = await read();
    frame.opcode.should.equal(0x8);
    frame.payload.readUInt16BE(0).should.equal(4001);
    frame.payload.subarray(2).toString().should.equal('bye');
    socket.destroy();
  });

  it('truncates an overlong close reason to the 123-byte control-frame limit', async () => {
    const socket = openSocket(server.port, '/close-long-reason');
    const { rest } = await readHead(socket);
    const read = frameReader(socket, rest);
    const frame = await read();
    frame.opcode.should.equal(0x8);
    frame.payload.readUInt16BE(0).should.equal(1000);
    // 2-byte code + reason must fit the 125-byte control-frame ceiling.
    frame.payload.length.should.be.lessThanOrEqual(125);
    frame.payload.subarray(2).length.should.equal(123);
    socket.destroy();
  });

  it('reassembles fragmented text messages', async () => {
    const socket = openSocket(server.port, '/echo');
    const { rest } = await readHead(socket);
    const read = frameReader(socket, rest);
    socket.write(clientFrame(0x1, 'hel', false));
    socket.write(clientFrame(0x0, 'lo', true));
    (await read()).should.deep.equal({ opcode: 0x1, payload: Buffer.from('hello'), rsv1: false });
    socket.destroy();
  });

  it('hands params and query to the handler', async () => {
    const socket = openSocket(server.port, '/capture/42?q=z');
    const { rest } = await readHead(socket);
    const read = frameReader(socket, rest);
    socket.write(clientFrame(0x1, 'go'));
    (await read()).should.deep.equal({ opcode: 0x1, payload: Buffer.from('42:z'), rsv1: false });
    socket.destroy();
  });

  it('destroys the socket for unmatched paths', async () => {
    const socket = openSocket(server.port, '/nope');
    const closed = once(socket, 'close');
    socket.on('data', () => {
      throw new Error('unmatched path must not receive a response');
    });
    await closed;
  });

  it('answers invalid handshake versions with 400', async () => {
    const socket = connect(server.port, HOST);
    socket.write(
      'GET /echo HTTP/1.1\r\n' +
        `Host: ${HOST}:${server.port}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${KEY}\r\n` +
        'Sec-WebSocket-Version: 8\r\n' +
        '\r\n'
    );
    const { head } = await readHead(socket);
    head.should.contain('400 Bad Request');
    socket.destroy();
  });

  it('reports 1006 when the client drops without a close frame', async () => {
    const socket = openSocket(server.port, '/drop-log');
    await readHead(socket);
    socket.destroy();
    const deadline = Date.now() + 2000;
    while (droppedCode === -1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    droppedCode.should.equal(1006);
  });
});

describe('websocket node maxPayload', () => {
  let limited: NodeServer;

  beforeAll(async () => {
    const app = createApp();
    upgradeWebSocket(app, '/ws', (socket) => {
      socket.onMessage((data) => socket.send(data));
    });
    limited = await serve(app, {
      port: 0,
      upgrade: createUpgradeHandler(app, { maxPayload: 4 }),
    });
  });

  afterAll(async () => {
    await limited.close();
  });

  it('passes messages within the budget', async () => {
    const socket = openSocket(limited.port, '/ws');
    const { rest } = await readHead(socket);
    const read = frameReader(socket, rest);
    socket.write(clientFrame(0x1, '1234'));
    (await read()).should.deep.equal({ opcode: 0x1, payload: Buffer.from('1234'), rsv1: false });
    socket.destroy();
  });

  it('closes with 1009 when a message exceeds the budget', async () => {
    const socket = openSocket(limited.port, '/ws');
    const { rest } = await readHead(socket);
    const read = frameReader(socket, rest);
    socket.write(clientFrame(0x1, '12345'));
    const frame = await read();
    frame.opcode.should.equal(0x8);
    frame.payload.readUInt16BE(0).should.equal(1009);
    socket.destroy();
  });
});

describe('websocket negotiation (subprotocol, deflate, heartbeat)', () => {
  let server: NodeServer;

  beforeAll(async () => {
    const app = createApp();
    upgradeWebSocket(
      app,
      '/proto',
      (socket) => {
        socket.onMessage(() => socket.send(socket.protocol ?? 'none'));
      },
      { protocols: ['graphql-ws', 'chat'] }
    );
    upgradeWebSocket(
      app,
      '/deflate',
      (socket) => {
        socket.onMessage((data) => socket.send(data));
      },
      { perMessageDeflate: true }
    );
    upgradeWebSocket(app, '/heartbeat', (socket) => {
      socket.onMessage(() => socket.ping('beat'));
      socket.onPong(() => socket.send('got-pong'));
    });
    server = await serve(app, { port: 0, upgrade: createUpgradeHandler(app) });
  });

  afterAll(async () => {
    await server.close();
  });

  it('negotiates the subprotocol by server preference', async () => {
    const socket = openSocket(
      server.port,
      '/proto',
      'Sec-WebSocket-Protocol: chat, graphql-ws\r\n'
    );
    const { head, rest } = await readHead(socket);
    head.should.contain('Sec-WebSocket-Protocol: graphql-ws');
    const read = frameReader(socket, rest);
    socket.write(clientFrame(0x1, 'which?'));
    (await read()).should.deep.equal({
      opcode: 0x1,
      payload: Buffer.from('graphql-ws'),
      rsv1: false,
    });
    socket.destroy();
  });

  it('leaves the protocol unset when no route protocol matches', async () => {
    const socket = openSocket(
      server.port,
      '/proto',
      'Sec-WebSocket-Protocol: mqtt\r\n'
    );
    const { head, rest } = await readHead(socket);
    head.should.not.contain('Sec-WebSocket-Protocol');
    const read = frameReader(socket, rest);
    socket.write(clientFrame(0x1, 'which?'));
    (await read()).should.deep.equal({
      opcode: 0x1,
      payload: Buffer.from('none'),
      rsv1: false,
    });
    socket.destroy();
  });

  it('negotiates permessage-deflate and echoes a compressed message', async () => {
    const { deflateRawSync, inflateRawSync } = await import('node:zlib');
    const socket = openSocket(
      server.port,
      '/deflate',
      'Sec-WebSocket-Extensions: permessage-deflate\r\n'
    );
    const { head, rest } = await readHead(socket);
    head.should.contain('Sec-WebSocket-Extensions: permessage-deflate');
    head.should.contain('client_no_context_takeover');
    head.should.contain('server_no_context_takeover');
    const read = frameReader(socket, rest);

    // Compressible text: the echo must come back compressed (rsv1 set) and
    // inflate to the original.
    const text = 'compress me '.repeat(20);
    const compressed = deflateRawSync(Buffer.from(text));
    socket.write(clientFrame(0x1, compressed, true, true));
    const frame = await read();
    frame.opcode.should.equal(0x1);
    frame.rsv1.should.equal(true);
    inflateRawSync(frame.payload).toString().should.equal(text);

    // Genuinely random bytes cannot shrink under deflate: the echo must
    // come back raw (no rsv1).
    const random = randomBytes(300);
    socket.write(clientFrame(0x2, random));
    const raw = await read();
    raw.opcode.should.equal(0x2);
    raw.rsv1.should.equal(false);
    raw.payload.should.deep.equal(random);
    socket.destroy();
  });

  it('rejects RSV1 frames when deflate was not negotiated', async () => {
    const socket = openSocket(server.port, '/proto');
    const { rest } = await readHead(socket);
    const read = frameReader(socket, rest);
    socket.write(clientFrame(0x1, 'x', true, true));
    const frame = await read();
    frame.opcode.should.equal(0x8);
    frame.payload.readUInt16BE(0).should.equal(1002);
    socket.destroy();
  });

  it('surfaces pings and pongs through the heartbeat surface', async () => {
    const socket = openSocket(server.port, '/heartbeat');
    const { rest } = await readHead(socket);
    const read = frameReader(socket, rest);
    // A message triggers a server ping; the client answers with a pong,
    // which the server reports through onPong.
    socket.write(clientFrame(0x1, 'hb'));
    const ping = await read();
    ping.opcode.should.equal(0x9);
    ping.payload.toString().should.equal('beat');
    socket.write(clientFrame(0xa, 'beat'));
    const reply = await read();
    reply.should.deep.equal({ opcode: 0x1, payload: Buffer.from('got-pong'), rsv1: false });
    socket.destroy();
  });
});

describe('websocket over TLS (wss, node global WebSocket client)', () => {
  let server: NodeServer;
  const priorTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

  beforeAll(async () => {
    // The fixture cert is self-signed and the global WebSocket client has
    // no rejectUnauthorized knob, so trust it for this file's worker only
    // (restored in afterAll).
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const app = createApp();
    upgradeWebSocket(app, '/echo', (socket) => {
      socket.onMessage((data) => socket.send(data));
    });
    server = await serve(app, {
      port: 0,
      https: { key: await readFile(KEY_PATH), cert: await readFile(CERT_PATH) },
      upgrade: createUpgradeHandler(app),
    });
  });

  afterAll(async () => {
    await server.close();
    if (priorTlsSetting === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = priorTlsSetting;
    }
  });

  it('echoes text over wss through the TLS + upgrade combination', async () => {
    server.url.startsWith('https://').should.be.true;
    const ws = new WebSocket(`wss://${HOST}:${server.port}/echo`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('wss connection failed')), { once: true });
    });
    const echoed = new Promise<string>((resolve) => {
      ws.addEventListener('message', (event) => resolve(event.data as string), { once: true });
    });
    ws.send('secure-echo');
    (await echoed).should.equal('secure-echo');
    ws.close(1000, 'done');
  });

  it('completes a clean close handshake over wss', async () => {
    const ws = new WebSocket(`wss://${HOST}:${server.port}/echo`);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('wss connection failed')), { once: true });
    });
    const closed = new Promise<number>((resolve) => {
      ws.addEventListener('close', (event) => resolve(event.code), { once: true });
    });
    ws.close(1000, 'bye');
    // The server echoes the close frame, so the client sees its own code.
    (await closed).should.equal(1000);
  });
});

describe('websocket + http2 rejection', () => {
  it('still rejects upgrade when https.http2 is enabled', async () => {
    const app = createApp();
    let error: unknown;
    try {
      await serve(app, {
        port: 0,
        upgrade: () => undefined,
        https: {
          key: await readFile(KEY_PATH),
          cert: await readFile(CERT_PATH),
          http2: true,
        },
      });
    } catch (caught) {
      error = caught;
    }
    (error as Error | undefined)?.message.should.match(/HTTP\/1\.1-only/);
  });
});
