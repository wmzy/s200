/**
 * Node adapter for `s200/websocket`: a zero-dependency RFC 6455 server.
 * `createUpgradeHandler(app)` returns the callback for the http server's
 * `'upgrade'` event — wire it through `s200/node`'s `serve` option:
 *
 * ```ts
 * import { serve } from 's200/node';
 * import { upgradeWebSocket } from 's200/websocket';
 * import { createUpgradeHandler } from 's200/websocket/node';
 *
 * const app = createApp();
 * upgradeWebSocket(app, '/chat', (socket, ctx) => { … });
 * const server = await serve(app, { port: 3000, upgrade: createUpgradeHandler(app) });
 * ```
 *
 * Scope is deliberately minimal: handshake, text/binary messages with
 * fragmentation, ping/pong, close handshake, a payload budget. No
 * permessage-deflate, no subprotocol negotiation — bring `ws` and wire the
 * raw `upgrade` event yourself when you need those.
 *
 * @module
 */

import type { App } from './app';
import type { Ctx } from './types';

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { createHash } from 'node:crypto';

import {
  createWsCtx,
  matchWebSocket,
  type WebSocketHandler,
  type WsCloseCb,
  type WsData,
  type WsErrorCb,
  type WsMessageCb,
  type WsSocket,
} from './websocket';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// Fatal: a text frame that is not valid UTF-8 must fail the connection
// (close 1007), not mojibake through a lossy decode. Non-streaming decode
// calls are stateless, so one decoder serves every message.
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });
const TEXT_ENCODER = new TextEncoder();

export type NodeUpgradeOptions = {
  /** Maximum accumulated message size in bytes; default 64 MiB. Oversized
   * messages close with 1009 before more of them is buffered. */
  readonly maxPayload?: number;
};

/** The callback signature of node's http `'upgrade'` event. */
export type NodeUpgradeHandler = (
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer
) => void;

/**
 * Builds the `'upgrade'` callback for `s200/node`'s `serve` option:
 * matches the request path against the app's WebSocket routes, answers
 * the RFC 6455 handshake, and runs the matched handler per connection.
 * Unknown paths destroy the socket; invalid handshakes get a 400.
 */
export function createUpgradeHandler(
  app: App,
  options: NodeUpgradeOptions = {}
): NodeUpgradeHandler {
  const maxPayload = options.maxPayload ?? 64 * 1024 * 1024;
  return (req, socket, head) => {
    acceptUpgrade(app, req, socket, head, maxPayload);
  };
}

function acceptUpgrade(
  app: App,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  maxPayload: number
): void {
  const url = new URL(
    req.url ?? '/',
    `http://${req.headers.host ?? 'localhost'}`
  );
  const matched = matchWebSocket(app, url.pathname);
  if (matched === undefined) {
    socket.destroy();
    return;
  }

  const upgrade = req.headers.upgrade;
  const connection = req.headers.connection;
  const version = req.headers['sec-websocket-version'];
  const key = req.headers['sec-websocket-key'];
  const tokens =
    typeof connection === 'string'
      ? connection.split(',').map((token) => token.trim().toLowerCase())
      : [];
  if (
    typeof upgrade !== 'string' ||
    upgrade.toLowerCase() !== 'websocket' ||
    !tokens.includes('upgrade') ||
    version !== '13' ||
    typeof key !== 'string' ||
    key === ''
  ) {
    socket.end(
      'HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'
    );
    return;
  }

  const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      '\r\n'
  );

  // Request-shaped context: params/query/url as an HTTP handler would see
  // them. rawHeaders keeps duplicate headers instead of node's merged view.
  const headers = new Headers();
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i];
    const value = req.rawHeaders[i + 1];
    if (name !== undefined && value !== undefined) {
      headers.append(name, value);
    }
  }
  const request = new Request(url, { method: req.method ?? 'GET', headers });
  runConnection(
    socket,
    head,
    maxPayload,
    matched.route.handler,
    createWsCtx(request, url, matched.params)
  );
}

/** One server-side frame: FIN+opcode byte, length, payload. */
function frameHeader(opcode: number, length: number): Buffer {
  if (length < 126) {
    return Buffer.from([0x80 | opcode, length]);
  }
  if (length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return header;
  }
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return header;
}

/** Close-frame reason payload: control frames carry at most 125 bytes,
 * and the first two are the code — so a reason is capped at 123 bytes,
 * cut at a UTF-8 code-point boundary (never mid-sequence). */
function encodeCloseReason(reason: string): Uint8Array {
  const bytes = TEXT_ENCODER.encode(reason);
  if (bytes.byteLength <= 123) return bytes;
  let end = 123;
  while (end > 0 && (bytes[end] ?? 0) >>> 6 === 0b10) end -= 1;
  return bytes.subarray(0, end);
}

function runConnection(
  socket: Duplex,
  head: Buffer,
  maxPayload: number,
  handler: WebSocketHandler,
  ctx: Ctx
): void {
  const messageCbs: WsMessageCb[] = [];
  const closeCbs: WsCloseCb[] = [];
  const errorCbs: WsErrorCb[] = [];

  let pending = head;
  let finished = false;
  let closeSent = false;
  let closeCode = 1005; // "no status received" until one is negotiated
  let closeReason = '';
  let fragOpcode = 0; // 0 = no fragmented message in progress
  let fragChunks: Buffer[] = [];
  let fragSize = 0;

  const writeFrame = (opcode: number, payload: Uint8Array): void => {
    if (finished) return;
    socket.write(Buffer.concat([frameHeader(opcode, payload.byteLength), Buffer.from(payload)]));
  };

  const sendClose = (code: number, reason: string): void => {
    if (closeSent || finished) return;
    closeSent = true;
    closeCode = code;
    closeReason = reason;
    const reasonBytes = encodeCloseReason(reason);
    const payload = Buffer.alloc(2 + reasonBytes.byteLength);
    payload.writeUInt16BE(code, 0);
    payload.set(reasonBytes, 2);
    socket.write(Buffer.concat([frameHeader(0x8, payload.byteLength), payload]));
    socket.end(); // flush, then close our side once the peer answers
  };

  const failProtocol = (): void => sendClose(1002, 'protocol error');
  const failTooBig = (): void => sendClose(1009, 'message too big');
  const failUtf8 = (): void => sendClose(1007, 'invalid utf-8');

  const dispatchClose = (): void => {
    finished = true;
    for (const cb of closeCbs) cb(closeCode, closeReason);
    closeCbs.length = 0;
    messageCbs.length = 0;
    errorCbs.length = 0;
  };

  const deliver = (opcode: number, payload: Buffer): void => {
    let data: WsData;
    if (opcode === 0x1) {
      try {
        data = TEXT_DECODER.decode(payload);
      } catch {
        failUtf8();
        return;
      }
    } else {
      // Copy out of the shared parse buffer: payload must not pin it.
      data = payload.buffer.slice(
        payload.byteOffset,
        payload.byteOffset + payload.byteLength
      ) as ArrayBuffer;
    }
    for (const cb of messageCbs) {
      try {
        cb(data);
      } catch (error) {
        for (const errorCb of errorCbs) {
          errorCb(error instanceof Error ? error : new Error(String(error)));
        }
        sendClose(1011, 'handler error');
        return;
      }
    }
  };

  const parseFrames = (): void => {
    for (;;) {
      // After the close exchange, further frames are ignored (§5.5.1).
      if (finished || closeSent) return;
      if (pending.length < 2) return;
      const b0 = pending[0] ?? 0;
      const b1 = pending[1] ?? 0;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (pending.length < 4) return;
        len = pending.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (pending.length < 10) return;
        const big = pending.readBigUInt64BE(2);
        // §5.2: the most significant bit MUST be 0 — a negative length is
        // invalid and would otherwise stall the parser waiting for bytes.
        if (big < 0n || big > BigInt(Number.MAX_SAFE_INTEGER)) {
          failProtocol();
          return;
        }
        len = Number(big);
        offset = 10;
      }
      // RFC 6455 §5.5: control frames are single-frame and ≤125 bytes.
      if (opcode >= 0x8 && (!fin || len > 125)) {
        failProtocol();
        return;
      }
      // §5.1: every client frame MUST be masked.
      if (!masked) {
        failProtocol();
        return;
      }
      const mask = pending.subarray(offset, offset + 4);
      offset += 4;
      if (pending.length < offset + len) return; // incomplete — wait for more
      let payload = pending.subarray(offset, offset + len);
      if (len > 0) {
        // Copy while unmasking: payload shares `pending`, which must stay
        // intact for the next frame (and never leak into handler hands).
        const unmasked = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i += 1) {
          unmasked[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);
        }
        payload = unmasked;
      }
      pending = pending.subarray(offset + len);

      switch (opcode) {
        case 0x0: {
          // Continuation: only legal mid-fragmentation.
          if (fragOpcode === 0) {
            failProtocol();
            return;
          }
          fragSize += len;
          if (fragSize > maxPayload) {
            failTooBig();
            return;
          }
          fragChunks.push(payload);
          if (fin) {
            const message = Buffer.concat(fragChunks, fragSize);
            fragChunks = [];
            fragSize = 0;
            const op = fragOpcode;
            fragOpcode = 0;
            deliver(op, message);
          }
          break;
        }
        case 0x1:
        case 0x2: {
          if (fragOpcode !== 0) {
            failProtocol();
            return;
          }
          if (!fin) {
            fragOpcode = opcode;
            fragChunks = [payload];
            fragSize = len;
            if (fragSize > maxPayload) {
              failTooBig();
              return;
            }
          } else {
            if (len > maxPayload) {
              failTooBig();
              return;
            }
            deliver(opcode, payload);
          }
          break;
        }
        case 0x8: {
          // Close: echo the code/reason (or an empty frame for a bare one),
          // then let the TCP close finish the exchange.
          const code = len >= 2 ? payload.readUInt16BE(0) : 1005;
          let reason = '';
          if (len > 2) {
            try {
              reason = TEXT_DECODER.decode(payload.subarray(2));
            } catch {
              /* a bad reason is not a protocol failure */
            }
          }
          if (closeSent) {
            closeCode = code === 1005 ? closeCode : code;
          } else {
            closeCode = code === 1005 ? 1000 : code;
            closeReason = reason;
            closeSent = true;
            if (code === 1005) {
              socket.write(frameHeader(0x8, 0));
            } else {
              const echo = Buffer.alloc(2 + TEXT_ENCODER.encode(reason).byteLength);
              echo.writeUInt16BE(code, 0);
              echo.set(TEXT_ENCODER.encode(reason), 2);
              socket.write(Buffer.concat([frameHeader(0x8, echo.byteLength), echo]));
            }
          }
          socket.end();
          return;
        }
        case 0x9:
          // Ping → pong with the same payload (§5.5.3).
          writeFrame(0xa, payload);
          break;
        case 0xa:
          // Pong: nothing to do.
          break;
        default:
          failProtocol();
          return;
      }
    }
  };

  socket.on('data', (chunk: Buffer) => {
    pending =
      pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    parseFrames();
  });
  socket.on('error', (error) => {
    if (finished) return;
    for (const cb of errorCbs) cb(error);
    // An errored socket is done; destroy so the 'close' path runs.
    socket.destroy();
  });
  socket.on('end', () => {
    // Upgraded sockets are allowHalfOpen: a client FIN alone (no close
    // frame) would leave this side open forever — report 1006 and finish.
    if (closeSent || finished) return;
    closeCode = 1006;
    dispatchClose();
    socket.destroy();
  });
  socket.on('close', () => {
    if (!closeSent) {
      // Transport dropped without a close frame: report 1006.
      closeCode = 1006;
    }
    dispatchClose();
  });

  const socketApi: WsSocket = {
    send(data) {
      if (typeof data === 'string') {
        writeFrame(0x1, TEXT_ENCODER.encode(data));
      } else {
        writeFrame(0x2, data instanceof Uint8Array ? data : new Uint8Array(data));
      }
    },
    close(code, reason) {
      sendClose(code ?? 1000, reason ?? '');
    },
    onMessage(cb) {
      messageCbs.push(cb);
    },
    onClose(cb) {
      closeCbs.push(cb);
    },
    onError(cb) {
      errorCbs.push(cb);
    },
  };

  void Promise.resolve()
    .then(() => handler(socketApi, ctx))
    .catch((error: unknown) => {
      for (const cb of errorCbs) {
        cb(error instanceof Error ? error : new Error(String(error)));
      }
      sendClose(1011, 'handler error');
    });
}
