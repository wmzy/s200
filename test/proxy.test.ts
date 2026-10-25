import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { App } from '../src/app';

import http from 'node:http';

import { afterAll, beforeAll, describe, it } from 'vitest';

import { createApp, get, handle, use } from '../src/app';
import { createProxy, proxyRequest } from '../src/proxy';
import { request } from '../src/test';

/**
 * The upstream is a REAL node http server (adapter-test precedent): it
 * answers per pathname — `/echo` reflects what it saw as JSON, `/hop`
 * ships hop-by-hop response headers raw, `/slow` holds the response so
 * aborts and failures have a window, `/204` answers bodyless. The proxy
 * side is driven in-process through s200/test's `request()`.
 */
type Seen = {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  chunks: number;
  bodyLength: number;
};

type Echo = {
  method: string;
  url: string;
  host: string | null;
  xff: string | null;
  xfp: string | null;
  xfh: string | null;
  connection: string | null;
  keepAlive: string | null;
  te: string | null;
  trailer: string | null;
  upgrade: string | null;
  proxyAuthorization: string | null;
  xNamed: string | null;
  acceptEncoding: string | null;
  bodyLength: number;
  chunks: number;
};

/** Set by the streaming test: the upstream acks its first body chunk by
 * resolving this — a buffered proxy would deadlock against the gate. */
let ackFirstChunk: (() => void) | undefined;

/** node types incoming header values as `string | string[] | undefined`;
 * the echoed fields here are always single-valued (or absent). */
const single = (value: string | string[] | undefined): string | null =>
  typeof value === 'string' ? value : null;

describe('proxy battery (real upstream)', () => {
  let upstreamAuthority = '';
  let server: http.Server;
  let app: App;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const record: Seen = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        chunks: 0,
        bodyLength: 0,
      };
      req.on('data', (chunk: Buffer) => {
        record.chunks += 1;
        record.bodyLength += chunk.length;
        if (ackFirstChunk !== undefined && record.bodyLength > 0) {
          ackFirstChunk();
          ackFirstChunk = undefined;
        }
      });
      req.on('end', () => {
        const pathname = (record.url.split('?')[0] ?? '') as string;
        if (pathname.endsWith('/hop')) {
          res.writeHead(200, [
            'connection',
            'x-hop-token',
            'keep-alive',
            'timeout=5',
            'proxy-authenticate',
            'Basic realm="upstream"',
            'te',
            'trailers',
            'upgrade',
            'h2c',
            'x-hop-token',
            '1',
            'content-type',
            'text/plain',
            'set-cookie',
            'a=1',
            'set-cookie',
            'b=2',
          ]);
          res.end('hello');
          return;
        }
        if (pathname.endsWith('/slow')) {
          setTimeout(() => res.end('late'), 400);
          return;
        }
        if (pathname.endsWith('/204')) {
          res.writeHead(204);
          res.end();
          return;
        }
        const echo: Echo = {
          method: record.method,
          url: record.url,
          host: single(req.headers.host),
          xff: single(req.headers['x-forwarded-for']),
          xfp: single(req.headers['x-forwarded-proto']),
          xfh: single(req.headers['x-forwarded-host']),
          connection: single(req.headers.connection),
          keepAlive: single(req.headers['keep-alive']),
          te: single(req.headers.te),
          trailer: single(req.headers.trailer),
          upgrade: single(req.headers.upgrade),
          proxyAuthorization: single(req.headers['proxy-authorization']),
          xNamed: single(req.headers['x-named']),
          acceptEncoding: single(req.headers['accept-encoding']),
          bodyLength: record.bodyLength,
          chunks: record.chunks,
        };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(echo));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    upstreamAuthority = `127.0.0.1:${String(port)}`;
    const UP = `http://${upstreamAuthority}`;

    app = createApp();
    use(app, '/api', createProxy({ upstream: UP }));
    use(app, '/v2', createProxy({ upstream: UP, rewrite: (p) => p.replace(/^\/v2/, '') || '/' }));
    use(app, '/addr', createProxy({ upstream: UP, clientAddress: () => '192.0.2.9' }));
    get(app, '/direct', (ctx) => proxyRequest(ctx, `${UP}/echo`));
    get(app, '/direct-host', (ctx) => proxyRequest(ctx, `${UP}/echo`, { preserveHost: true }));
    get(app, '/direct-addr', (ctx) =>
      proxyRequest(ctx, `${UP}/echo`, { clientAddress: '198.51.100.7' })
    );
  });

  afterAll(async () => {
    server.closeIdleConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('passes a GET through: status, headers, body, and content-length', async () => {
    const res = await request(app, '/api/echo');
    res.status.should.equal(200);
    res.headers.get('content-type')?.should.include('application/json');
    const text = await res.text();
    const echo = JSON.parse(text) as Echo;
    echo.method.should.equal('GET');
    echo.url.should.equal('/api/echo');
    (echo.acceptEncoding ?? '').should.equal('identity');
    // Pass-through only: the length the upstream set is what ships.
    res.headers.get('content-length')?.should.equal(String(text.length));
  });

  it('preserves the query string', async () => {
    const res = await request(app, '/api/echo?q=s200&n=2');
    const echo = (await res.json()) as Echo;
    echo.url.should.equal('/api/echo?q=s200&n=2');
  });

  it('rewrites the pathname when mounted with a rewrite', async () => {
    const res = await request(app, '/v2/echo');
    const echo = (await res.json()) as Echo;
    echo.url.should.equal('/echo');
  });

  it('streams a POST body through un-buffered (>64KB, gated by upstream ack)', async () => {
    const firstSeen = new Promise<void>((resolve) => {
      ackFirstChunk = resolve;
    });
    let phase = 0;
    const stream = new ReadableStream<Uint8Array>({
      // Chunk 2 is only produced after the upstream acknowledged chunk 1's
      // bytes — a proxy that buffered the request body would deadlock here.
      async pull(controller) {
        phase += 1;
        if (phase === 1) {
          controller.enqueue(new Uint8Array(70 * 1024).fill(97));
        } else if (phase === 2) {
          await firstSeen;
          controller.enqueue(new Uint8Array(10 * 1024).fill(98));
        } else {
          controller.close();
        }
      },
    });
    const res = await request(app, '/api/echo', {
      method: 'POST',
      body: stream,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    const echo = (await res.json()) as Echo;
    echo.method.should.equal('POST');
    echo.bodyLength.should.equal(80 * 1024);
    echo.chunks.should.be.greaterThan(1);
  });

  it('strips hop-by-hop request headers and connection-named tokens', async () => {
    const res = await request(app, '/api/echo', {
      headers: {
        connection: 'keep-alive, x-named',
        'keep-alive': 'timeout=5',
        te: 'trailers',
        trailer: 'x-t',
        upgrade: 'websocket',
        'proxy-authorization': 'Basic zz',
        'x-named': '1',
      },
    });
    const echo = (await res.json()) as Echo;
    (echo.keepAlive === null).should.be.true;
    (echo.te === null).should.be.true;
    (echo.trailer === null).should.be.true;
    (echo.upgrade === null).should.be.true;
    (echo.proxyAuthorization === null).should.be.true;
    // Named by connection → stripped with it.
    (echo.xNamed === null).should.be.true;
    echo.connection?.should.not.include('x-named');
  });

  it('appends x-forwarded-proto/host and appends to existing chains', async () => {
    const bare = (await (await request(app, '/api/echo')).json()) as Echo;
    (bare.xfp ?? '').should.equal('http');
    (bare.xfh ?? '').should.equal('s200.test');
    (bare.xff === null).should.be.true;

    const chained = (
      await (
        await request(app, '/api/echo', {
          headers: {
            'x-forwarded-proto': 'https',
            'x-forwarded-host': 'front.example',
            'x-forwarded-for': '203.0.113.9',
          },
        })
      ).json()
    ) as Echo;
    (chained.xfp ?? '').should.equal('https, http');
    (chained.xfh ?? '').should.equal('front.example, s200.test');
    // No client address this hop can claim → the chain passes untouched.
    (chained.xff ?? '').should.equal('203.0.113.9');
  });

  it('appends the clientAddress to x-forwarded-for (value and resolver forms)', async () => {
    const fixed = (
      await (
        await request(app, '/direct-addr', {
          headers: { 'x-forwarded-for': '203.0.113.9' },
        })
      ).json()
    ) as Echo;
    (fixed.xff ?? '').should.equal('203.0.113.9, 198.51.100.7');

    const resolved = (await (await request(app, '/addr/echo')).json()) as Echo;
    (resolved.xff ?? '').should.equal('192.0.2.9');
  });

  it('pins Host to the upstream authority in both preserveHost modes (fetch spec)', async () => {
    // undici enforces the fetch spec: Host is always the target URL's
    // authority, so preserveHost's forwarded header is overridden here —
    // the honest cross-runtime carrier of the original host is the
    // appended x-forwarded-host (asserted above).
    const dropped = (await (await request(app, '/api/echo')).json()) as Echo;
    (dropped.host ?? '').should.equal(upstreamAuthority);

    const preserved = (await (await request(app, '/direct-host')).json()) as Echo;
    (preserved.host ?? '').should.equal(upstreamAuthority);
    (preserved.xfh ?? '').should.equal('s200.test');
  });

  it('strips hop-by-hop response headers, keeps the rest byte-for-byte', async () => {
    const res = await request(app, '/api/hop');
    res.status.should.equal(200);
    (res.headers.get('connection') === null).should.be.true;
    (res.headers.get('keep-alive') === null).should.be.true;
    (res.headers.get('proxy-authenticate') === null).should.be.true;
    (res.headers.get('te') === null).should.be.true;
    (res.headers.get('transfer-encoding') === null).should.be.true;
    (res.headers.get('upgrade') === null).should.be.true;
    // Named by the upstream's connection header → stripped with it.
    (res.headers.get('x-hop-token') === null).should.be.true;
    res.headers.get('content-type')?.should.equal('text/plain');
    res.headers.getSetCookie().should.deep.equal(['a=1', 'b=2']);
    (await res.text()).should.equal('hello');
  });

  it('passes a bodyless 204 through without fabricating content-length', async () => {
    const res = await request(app, '/api/204');
    res.status.should.equal(204);
    (res.headers.get('content-length') === null).should.be.true;
  });

  it('answers 502 Bad Gateway when the upstream connection is refused', async () => {
    const dead = http.createServer();
    await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve));
    const deadPort = (dead.address() as AddressInfo).port;
    await new Promise<void>((resolve) => dead.close(() => resolve()));

    const refused = createApp();
    use(refused, createProxy({ upstream: `http://127.0.0.1:${String(deadPort)}` }));
    const res = await request(refused, '/anything');
    res.status.should.equal(502);
    (await res.json()).should.deep.equal({ error: 'Bad Gateway' });
  });

  it('maps an aborted request to 499 Client Closed Request', async () => {
    // ctx.signal is what the proxy links (via AbortSignal.any) — seeded
    // here the way an adapter seeds the client-disconnect signal.
    const controller = new AbortController();
    const pending = handle(app, new Request('http://s200.test/api/slow'), {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 30);
    const res = await pending;
    res.status.should.equal(499);
    (await res.json()).should.deep.equal({ error: 'Client Closed Request' });
  });

  it('rejects an upstream with its own query at setup, not silently dropping it', () => {
    (() => createProxy({ upstream: 'http://upstream.example/base?token=1' })).should.throw(
      /query/
    );
  });
});
