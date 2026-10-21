import type { NodeServer } from '../src/node';

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { connect } from 'node:http2';
import https from 'node:https';
import { Socket } from 'node:net';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, it } from 'vitest';

import { createApp, get, post, use } from '../src/app';
import { readJson } from '../src/body';
import { createFileReader, createRealPathGuard, serve } from '../src/node';
import { json, send } from '../src/respond';

const KEY_PATH = fileURLToPath(new URL('./fixtures/key.pem', import.meta.url));
const CERT_PATH = fileURLToPath(new URL('./fixtures/cert.pem', import.meta.url));

describe('node adapter (real http)', () => {
  let nodeServer: NodeServer;
  let dir: string;

  beforeAll(async () => {
    const app = createApp();
    use(app, async (ctx, next) => {
      await next();
      // Onion check: the header can only be set after the inner chain
      // produced a response.
      ctx.res?.headers.append('x-s200', 'node');
    });
    get(app, '/hello/:name', (ctx) => json(ctx, { hello: ctx.params.name }));
    post(app, '/echo', async (ctx) => json(ctx, await readJson(ctx)));
    get(app, '/cookies', (ctx) =>
      send(ctx, 'ok', { headers: [['set-cookie', 'a=1'], ['set-cookie', 'b=2']] })
    );
    get(app, '/boom', () => {
      throw new Error('boom');
    });
    get(app, '/host-echo', (ctx) =>
      json(ctx, { host: ctx.url.host, pathname: ctx.url.pathname })
    );
    nodeServer = await serve(app, { port: 0 });

    dir = await mkdtemp(join(tmpdir(), 's200-node-'));
    await writeFile(join(dir, 'hello.txt'), 'hello from disk');
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'sub', 'nested.txt'), 'nested');
  });

  it('resolves the ephemeral port and url', () => {
    nodeServer.port.should.be.a('number');
    nodeServer.port.should.be.greaterThan(0);
    nodeServer.url.should.equal(`http://127.0.0.1:${nodeServer.port}`);
    nodeServer.server.listening.should.be.true;
  });

  it('routes GET with params, middleware header and JSON body', async () => {
    const res = await fetch(`${nodeServer.url}/hello/world`);
    res.status.should.equal(200);
    res.headers.get('x-s200')?.should.equal('node');
    (await res.json()).should.deep.equal({ hello: 'world' });
  });

  it('round-trips a POST JSON body through the web stream', async () => {
    const payload = { a: 1, list: ['x', 'y'] };
    const res = await fetch(`${nodeServer.url}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    res.status.should.equal(200);
    res.headers.get('x-s200')?.should.equal('node');
    (await res.json()).should.deep.equal(payload);
  });

  it('keeps duplicated set-cookie headers separate', async () => {
    const res = await fetch(`${nodeServer.url}/cookies`);
    res.status.should.equal(200);
    res.headers.getSetCookie().should.deep.equal(['a=1', 'b=2']);
  });

  it('answers unmatched routes with the default 404 JSON, middlewares still ran', async () => {
    const res = await fetch(`${nodeServer.url}/nope`);
    res.status.should.equal(404);
    res.headers.get('x-s200')?.should.equal('node');
    (await res.json()).should.deep.equal({ error: 'Not Found' });
  });

  it('maps a throwing handler to the default 500 JSON', async () => {
    const res = await fetch(`${nodeServer.url}/boom`);
    res.status.should.equal(500);
    (await res.json()).should.deep.equal({ error: 'Internal Server Error' });
  });

  describe('Host header sanitization', () => {
    // Raw http.request: fetch cannot carry a crafted Host (forbidden header).
    const echo = async (
      host: string
    ): Promise<{ host: string; pathname: string }> => {
      const body = await new Promise<string>((resolve, reject) => {
        const request = http.request(
          {
            host: '127.0.0.1',
            port: nodeServer.port,
            path: '/host-echo',
            headers: { host },
          },
          (message) => {
            let data = '';
            message.on('data', (chunk: Buffer) => (data += chunk.toString()));
            message.on('end', () => resolve(data));
          }
        );
        request.on('error', reject);
        request.end();
      });
      return JSON.parse(body) as { host: string; pathname: string };
    };

    it('keeps a path-polluting Host out of the parsed URL', async () => {
      const echoed = await echo('evil.com/a');
      echoed.host.should.equal('localhost');
      echoed.pathname.should.equal('/host-echo');
    });

    it('falls back to localhost for userinfo/query/fragment/backslash/whitespace Hosts', async () => {
      const bad = [
        'user@evil.com',
        'evil.com?x=1',
        'evil.com#f',
        'evil.com\\..',
        'evil. com',
        'evil.com\t/a',
      ];
      for (const candidate of bad) {
        const echoed = await echo(candidate);
        echoed.host.should.equal('localhost');
        echoed.pathname.should.equal('/host-echo');
      }
    });

    it('falls back to localhost for an empty Host (raw socket)', async () => {
      // http.request replaces an empty Host with its own computed (legal)
      // one — only a raw socket reaches the adapter with `Host:` empty. (A
      // request with no Host at all is rejected by node's own parser with
      // a 400 before the adapter ever sees it.)
      const raw = (request: string): Promise<string> =>
        new Promise((resolve, reject) => {
          const socket = new Socket();
          let data = '';
          socket.on('error', reject);
          socket.on('data', (chunk: Buffer) => (data += chunk.toString()));
          socket.on('close', () => resolve(data));
          socket.connect(nodeServer.port, '127.0.0.1');
          socket.write(request);
        });
      const response = await raw(
        'GET /host-echo HTTP/1.1\r\nHost:\r\nConnection: close\r\n\r\n'
      );
      const echoed = JSON.parse(
        response.slice(response.indexOf('\r\n\r\n') + 4)
      ) as { host: string; pathname: string };
      echoed.host.should.equal('localhost');
      echoed.pathname.should.equal('/host-echo');
    });

    it('keeps legal hosts, ports and IPv6 literals untouched', async () => {
      (await echo('example.com')).host.should.equal('example.com');
      (await echo('example.com:8080')).host.should.equal('example.com:8080');
      (await echo('[::1]:3000')).host.should.equal('[::1]:3000');
      (await echo('sub.example-site.com')).host.should.equal(
        'sub.example-site.com'
      );
    });
  });

  describe('createFileReader', () => {
    it('reads files under the root as bytes', async () => {
      const read = createFileReader(dir);
      const bytes = (await read('/hello.txt')) as Uint8Array;
      new TextDecoder().decode(bytes).should.equal('hello from disk');
      const nested = (await read('sub/nested.txt')) as Uint8Array;
      new TextDecoder().decode(nested).should.equal('nested');
    });

    it('streams files under the root with { stream: true }', async () => {
      const read = createFileReader(dir, { stream: true });
      const stream = await read('/hello.txt');
      (stream !== null && !(stream instanceof Uint8Array)).should.be.true;
      const text = await new Response(stream as BodyInit).text();
      text.should.equal('hello from disk');
    });

    it('returns null for missing paths and directories', async () => {
      const read = createFileReader(dir);
      (await read('/missing.txt') === null).should.be.true;
      (await read('/sub') === null).should.be.true; // EISDIR
    });
  });

  describe('createRealPathGuard', () => {
    let guardDir: string;
    let outsideDir: string;

    beforeAll(async () => {
      guardDir = await mkdtemp(join(tmpdir(), 's200-guard-'));
      outsideDir = await mkdtemp(join(tmpdir(), 's200-outside-'));
      await writeFile(join(guardDir, 'ok.txt'), 'ok');
      await writeFile(join(outsideDir, 'secret.txt'), 'secret');
      await symlink(join(outsideDir, 'secret.txt'), join(guardDir, 'leak.txt'));
    });

    afterAll(async () => {
      await rm(guardDir, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    });

    it('returns the real path for files inside the root', async () => {
      const guard = createRealPathGuard(guardDir);
      (await guard('ok.txt') === null).should.be.false;
    });

    it('returns null for symlinks escaping the root', async () => {
      const guard = createRealPathGuard(guardDir);
      (await guard('leak.txt') === null).should.be.true;
    });

    it('returns null for missing files', async () => {
      const guard = createRealPathGuard(guardDir);
      (await guard('missing.txt') === null).should.be.true;
    });

    it('returns null for everything when the root itself is missing', async () => {
      const guard = createRealPathGuard(join(guardDir, 'no-such-root'));
      (await guard('x.txt') === null).should.be.true;
    });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    const url = nodeServer.url;
    await nodeServer.close();
    nodeServer.server.listening.should.be.false;
    // Nothing listens anymore: keep-alive sockets were dropped by close().
    // The rejection shape varies (ECONNREFUSED or a destroyed pooled socket),
    // so only the fact of rejection is asserted.
    let rejected = false;
    try {
      await fetch(`${url}/hello/x`);
    } catch {
      rejected = true;
    }
    rejected.should.be.true;
  });
});

describe('node adapter TLS', () => {
  it('serves HTTPS through the same pipeline', async () => {
    const app = createApp();
    get(app, '/hello/:name', (ctx) => json(ctx, { hello: ctx.params.name }));
    const tls = await serve(app, {
      port: 0,
      https: {
        key: await readFile(KEY_PATH),
        cert: await readFile(CERT_PATH),
      },
    });
    try {
      tls.url.startsWith('https://').should.be.true;
      const text = await new Promise<string>((resolve, reject) => {
        https.get(`${tls.url}/hello/tls`, { rejectUnauthorized: false }, (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => (data += chunk.toString()));
          res.on('end', () => resolve(data));
        }).on('error', reject);
      });
      JSON.parse(text).should.deep.equal({ hello: 'tls' });
    } finally {
      await tls.close();
    }
  });

  it('serves HTTP/2 over TLS with the same pipeline', async () => {
    const app = createApp();
    get(app, '/hello/:name', (ctx) => json(ctx, { hello: ctx.params.name }));
    const tls = await serve(app, {
      port: 0,
      https: {
        key: await readFile(KEY_PATH),
        cert: await readFile(CERT_PATH),
        http2: true,
      },
    });
    try {
      const client = connect(tls.url, { rejectUnauthorized: false });
      try {
        const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
          const req = client.request({ ':path': '/hello/h2' });
          let body = '';
          req.on('response', (headers) => {
            const status = Number(headers[':status']);
            req.on('data', (chunk: Buffer) => (body += chunk.toString()));
            req.on('end', () => resolve({ status, body }));
          });
          req.on('error', reject);
          req.end();
        });
        result.status.should.equal(200);
        JSON.parse(result.body).should.deep.equal({ hello: 'h2' });
      } finally {
        client.close();
      }
    } finally {
      await tls.close();
    }
  });

  it('keeps a legal :authority on HTTP/2 (polluted ones die at the protocol level)', async () => {
    // nghttp2 validates host/:authority values as authorities — a polluted
    // one (e.g. with '/') is answered NGHTTP2_PROTOCOL_ERROR before the
    // adapter ever sees it, so the h2 half of the SAFE_HOST gate is
    // defense in depth; what is reachable and contractual is the legal
    // passthrough.
    const app = createApp();
    get(app, '/host-echo', (ctx) =>
      json(ctx, { host: ctx.url.host, pathname: ctx.url.pathname })
    );
    const tls = await serve(app, {
      port: 0,
      https: {
        key: await readFile(KEY_PATH),
        cert: await readFile(CERT_PATH),
        http2: true,
      },
    });
    try {
      const client = connect(tls.url, { rejectUnauthorized: false });
      try {
        const echoed = await new Promise<{ host: string; pathname: string }>(
          (resolve, reject) => {
            const req = client.request({
              ':path': '/host-echo',
              ':authority': 'example.com',
            });
            let data = '';
            req.on('response', () => {
              req.on('data', (chunk: Buffer) => (data += chunk.toString()));
              req.on('end', () => resolve(JSON.parse(data)));
            });
            req.on('error', reject);
            req.end();
          }
        );
        echoed.host.should.equal('example.com');
        echoed.pathname.should.equal('/host-echo');
      } finally {
        client.close();
      }
    } finally {
      await tls.close();
    }
  });

  it('rejects the upgrade + http2 combination at serve time', async () => {
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

describe('node adapter graceful close and server tunables', () => {
  it('drains an in-flight response before resolving close()', async () => {
    const app = createApp();
    get(app, '/slow', async (ctx) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return json(ctx, { done: true });
    });
    const server = await serve(app, { port: 0 });
    try {
      const pending = fetch(`${server.url}/slow`);
      // Let the request reach the handler before closing.
      await new Promise((resolve) => setTimeout(resolve, 25));
      const started = Date.now();
      const closing = server.close();
      const res = await pending; // close() must not kill the in-flight response
      res.status.should.equal(200);
      (await res.json()).should.deep.equal({ done: true });
      await closing; // resolves once the response landed — not at grace
      server.server.listening.should.be.false;
      (Date.now() - started).should.be.below(2_000);
    } finally {
      await server.close().catch(() => undefined);
    }
  });

  it('closes idle keep-alive sockets instead of waiting out their timeout', async () => {
    const app = createApp();
    get(app, '/', (ctx) => send(ctx, 'ok'));
    const server = await serve(app, { port: 0 });
    // Park a raw socket whose request already completed: it sits idle on
    // keep-alive and would otherwise hold close() open for its own 5s
    // keepAliveTimeout (or the 10s grace).
    const socket = new Socket();
    const received = await new Promise<string>((resolve, reject) => {
      let data = '';
      socket.on('error', reject);
      socket.on('data', (chunk: Buffer) => {
        data += chunk.toString();
        if (data.endsWith('ok')) resolve(data);
      });
      socket.connect(server.port, '127.0.0.1');
      socket.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
    });
    received.should.contain('HTTP/1.1 200');
    try {
      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      const started = Date.now();
      await server.close();
      (Date.now() - started).should.be.below(2_000);
      await closed; // the client sees the FIN from the destroyed socket
      socket.destroyed.should.be.true;
    } finally {
      socket.destroy();
    }
  });

  it('hard-kills in-flight responses immediately with closeGraceMs: 0', async () => {
    const app = createApp();
    get(app, '/slow', async (ctx) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return json(ctx, { done: true });
    });
    const server = await serve(app, { port: 0, closeGraceMs: 0 });
    try {
      const pending = fetch(`${server.url}/slow`);
      await new Promise((resolve) => setTimeout(resolve, 25));
      const started = Date.now();
      await server.close(); // resolves well before the handler finishes
      (Date.now() - started).should.be.below(150);
      let rejected = false;
      try {
        await pending;
      } catch {
        rejected = true;
      }
      rejected.should.be.true; // the in-flight response died with the socket
    } finally {
      await server.close().catch(() => undefined);
    }
  });

  it('applies the curated tunables on the plain http path', async () => {
    const app = createApp();
    const server = await serve(app, {
      port: 0,
      server: {
        keepAliveTimeout: 1_234,
        requestTimeout: 5_678,
        headersTimeout: 4_321,
        maxHeaderSize: 4_096,
        connectionsCheckingInterval: 3_000,
      },
    });
    try {
      // maxHeaderSize/connectionsCheckingInterval exist at runtime but are
      // missing from this @types/node's http.Server surface.
      const raw = server.server as http.Server & {
        maxHeaderSize: number;
        connectionsCheckingInterval: number;
      };
      raw.keepAliveTimeout.should.equal(1_234);
      raw.requestTimeout.should.equal(5_678);
      raw.headersTimeout.should.equal(4_321);
      raw.maxHeaderSize.should.equal(4_096);
      raw.connectionsCheckingInterval.should.equal(3_000);
    } finally {
      await server.close();
    }
  });

  it('applies the curated tunables on the https path', async () => {
    const app = createApp();
    const server = await serve(app, {
      port: 0,
      server: { keepAliveTimeout: 2_345, requestTimeout: 6_789 },
      https: { key: await readFile(KEY_PATH), cert: await readFile(CERT_PATH) },
    });
    try {
      const raw = server.server as https.Server;
      raw.keepAliveTimeout.should.equal(2_345);
      raw.requestTimeout.should.equal(6_789);
    } finally {
      await server.close();
    }
  });

  it('bounds the drain on upgraded (websocket) sockets: grace hard-kills them', async () => {
    // Sockets taken over by 'upgrade' are invisible to node's own
    // closeIdleConnections()/closeAllConnections() — without the
    // adapter's registry close() would hang forever on them.
    const app = createApp();
    const server = await serve(app, {
      port: 0,
      closeGraceMs: 300,
      upgrade: (req, socket) => {
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'
        );
      },
    });
    const socket = new Socket();
    const upgraded = new Promise<void>((resolve, reject) => {
      socket.on('error', reject);
      socket.on('data', () => resolve());
      socket.connect(server.port, '127.0.0.1');
      socket.write('GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    });
    try {
      await upgraded;
      const started = Date.now();
      await server.close(); // resolves at the grace bound, not never
      const elapsed = Date.now() - started;
      elapsed.should.be.at.least(250); // it did wait the grace window
      elapsed.should.be.below(2_000);
      await new Promise<void>((resolve) => socket.once('close', () => resolve()));
      socket.destroyed.should.be.true;
    } finally {
      socket.destroy();
    }
  });

  it('wires the clientError hook for malformed requests', async () => {
    const app = createApp();
    get(app, '/', (ctx) => send(ctx, 'ok'));
    const seen: string[] = [];
    const server = await serve(app, {
      port: 0,
      clientError: (err, socket) => {
        seen.push((err as Error & { code?: string }).code ?? err.message);
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      },
    });
    try {
      // A NUL byte in a header value never parses — node hands the socket
      // to 'clientError' instead of the request handler.
      const reply = await new Promise<string>((resolve, reject) => {
        const socket = new Socket();
        let data = '';
        socket.on('error', reject);
        socket.on('data', (chunk: Buffer) => (data += chunk.toString()));
        socket.on('close', () => resolve(data));
        socket.connect(server.port, '127.0.0.1');
        socket.write('GET / HTTP/1.1\r\nHost: \x00bad\r\n\r\n');
      });
      seen.should.have.lengthOf(1);
      seen[0]?.should.equal('HPE_INVALID_HEADER_TOKEN');
      reply.should.contain('400 Bad Request');
    } finally {
      await server.close();
    }
  });
});

describe('node adapter light mode', () => {
  let light: NodeServer;

  beforeAll(async () => {
    const app = createApp();
    use(app, async (ctx, next) => {
      await next();
      ctx.res?.headers.append('x-s200', 'light');
    });
    get(app, '/hello/:name', (ctx) => json(ctx, { hello: ctx.params.name }));
    get(app, '/text', (ctx) => send(ctx, 'plain', { status: 201 }));
    get(app, '/empty', (ctx) => send(ctx, null));
    post(app, '/echo', async (ctx) => json(ctx, await readJson(ctx)));
    get(app, '/boom', () => {
      throw new Error('boom');
    });
    get(app, '/nope', () => undefined);
    light = await serve(app, { port: 0, light: true });
  });

  afterAll(async () => {
    await light.close();
  });

  it('serves JSON, text, params and middleware headers', async () => {
    const res = await fetch(`${light.url}/hello/world`);
    res.status.should.equal(200);
    res.headers.get('x-s200')?.should.equal('light');
    res.headers.get('content-type')?.should.contain('application/json');
    res.headers.get('content-length')?.should.equal('17');
    (await res.json()).should.deep.equal({ hello: 'world' });
  });

  it('serves plain text with status and bodyless responses', async () => {
    const text = await fetch(`${light.url}/text`);
    text.status.should.equal(201);
    (await text.text()).should.equal('plain');
    text.headers.get('content-length')?.should.equal('5');

    const empty = await fetch(`${light.url}/empty`);
    empty.status.should.equal(200);
    empty.headers.get('content-length')?.should.equal('0');
  });

  it('round-trips a POST JSON body', async () => {
    const res = await fetch(`${light.url}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 1 }),
    });
    (await res.json()).should.deep.equal({ a: 1 });
  });

  it('answers 404 and 500 through the light fallback path', async () => {
    const missing = await fetch(`${light.url}/missing`);
    missing.status.should.equal(404);
    (await missing.json()).should.deep.equal({ error: 'Not Found' });

    const boom = await fetch(`${light.url}/boom`);
    boom.status.should.equal(500);

    // A matched route that never wrote a response hits the 500 fallback.
    const nope = await fetch(`${light.url}/nope`);
    nope.status.should.equal(500);
  });

  it('handles HEAD with content-length and no body', async () => {
    const res = await fetch(`${light.url}/hello/world`, { method: 'HEAD' });
    res.status.should.equal(200);
    res.headers.get('content-length')?.should.equal('17');
    (await res.text()).should.equal('');
  });
});
