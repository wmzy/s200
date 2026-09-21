import type { NodeServer } from '../src/node';

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:http2';
import https from 'node:https';
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

  it('rejects the upgrade + https combination at serve time', async () => {
    const app = createApp();
    let error: unknown;
    try {
      await serve(app, {
        port: 0,
        upgrade: () => undefined,
        https: {
          key: await readFile(KEY_PATH),
          cert: await readFile(CERT_PATH),
        },
      });
    } catch (caught) {
      error = caught;
    }
    (error as Error | undefined)?.message.should.match(/HTTP\/1\.1-only/);
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
