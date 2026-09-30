import type { App } from '../src/app';
import type { NodeServer } from '../src/node';
import type { Ctx, Middleware } from '../src/types';

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, it } from 'vitest';

import { createApp, get, post, use } from '../src/app';
import { readForm, readJson, readStream, readText } from '../src/body';
import { compress } from '../src/compress';
import { etag } from '../src/etag';
import { isLightRequest } from '../src/light';
import { createFileRangeReader, createFileReader, createFileStat, serve } from '../src/node';
import { json, text } from '../src/respond';
import { serveStatic } from '../src/static';
import { stream, streamSSE } from '../src/streaming';

const servers: NodeServer[] = [];

afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

/** Middleware that records which adapter path served the request, so every
 * scenario proves its asserted wire behavior came from the mode it names
 * (and that `light: true` really engaged the light pipeline). */
function modeMarker(): Middleware {
  return async (ctx: Ctx, next) => {
    await next();
    ctx.res?.headers.append(
      'x-s200-mode',
      isLightRequest(ctx.req) ? 'light' : 'normal'
    );
  };
}

/** Serves the same app shape once per mode — each scenario then runs
 * against both and asserts parity where the contract is mode-free. */
async function serveBoth(
  build: () => App
): Promise<{ normal: string; light: string }> {
  const normal = await serve(build(), { port: 0 });
  const light = await serve(build(), { port: 0, light: true });
  servers.push(normal, light);
  return { normal: normal.url, light: light.url };
}

/** Runs one scenario against each mode's base URL, in order. */
async function inBoth<T>(
  urls: { normal: string; light: string },
  run: (url: string) => Promise<T>
): Promise<{ normal: T; light: T }> {
  return { normal: await run(urls.normal), light: await run(urls.light) };
}

describe('etag battery over real http (both modes)', () => {
  let urls: { normal: string; light: string };

  beforeAll(async () => {
    urls = await serveBoth(() => {
      const app = createApp();
      use(app, modeMarker());
      use(app, etag());
      get(app, '/', (ctx) => json(ctx, { hello: 'etag', pad: 'x'.repeat(64) }));
      return app;
    });
  });

  it('stamps the same weak etag on a 200 in both modes', async () => {
    const seen = await inBoth(urls, async (url) => {
      const res = await fetch(`${url}/`);
      return {
        mode: res.headers.get('x-s200-mode'),
        status: res.status,
        etag: res.headers.get('etag'),
        contentType: res.headers.get('content-type'),
        body: await res.json(),
      };
    });
    seen.normal.mode?.should.equal('normal');
    seen.light.mode?.should.equal('light');
    seen.normal.status.should.equal(200);
    seen.light.status.should.equal(200);
    seen.normal.etag?.should.match(/^W\/"[0-9a-f]{40}"$/);
    // Parity: identical body bytes hash to an identical validator.
    seen.light.etag?.should.equal(seen.normal.etag);
    seen.light.contentType?.should.equal(seen.normal.contentType);
    seen.light.body.should.deep.equal(seen.normal.body);
  });

  it('answers If-None-Match hits with a bodyless 304 in both modes', async () => {
    const seen = await inBoth(urls, async (url) => {
      const first = await fetch(`${url}/`);
      const tag = first.headers.get('etag');
      await first.text(); // release the keep-alive socket
      const res = await fetch(`${url}/`, {
        headers: { 'if-none-match': tag ?? '' },
      });
      return {
        status: res.status,
        etag: res.headers.get('etag'),
        body: await res.text(),
      };
    });
    seen.normal.status.should.equal(304);
    seen.light.status.should.equal(304);
    seen.normal.body.should.equal('');
    seen.light.body.should.equal('');
    seen.normal.etag?.should.match(/^W\/"[0-9a-f]{40}"$/);
    seen.light.etag?.should.equal(seen.normal.etag);
  });
});

describe('compress battery over real http (both modes)', () => {
  let urls: { normal: string; light: string };

  beforeAll(async () => {
    urls = await serveBoth(() => {
      const app = createApp();
      use(app, modeMarker());
      use(app, compress({ minBytes: 32 }));
      get(app, '/big', (ctx) => text(ctx, 'x'.repeat(2048)));
      get(app, '/small', (ctx) => text(ctx, 'tiny'));
      return app;
    });
  });

  it('gzips byte-backed bodies over minBytes and decodes back to the original', async () => {
    const payload = 'x'.repeat(2048);
    const seen = await inBoth(urls, async (url) => {
      const res = await fetch(`${url}/big`, {
        headers: { 'accept-encoding': 'gzip' },
      });
      return {
        mode: res.headers.get('x-s200-mode'),
        status: res.status,
        encoding: res.headers.get('content-encoding'),
        vary: res.headers.get('vary'),
        contentLength: res.headers.get('content-length'),
        body: await res.text(),
      };
    });
    seen.normal.mode?.should.equal('normal');
    seen.light.mode?.should.equal('light');
    seen.normal.status.should.equal(200);
    seen.light.status.should.equal(200);
    // Both paths compressed on the wire — undici decodes gzip
    // transparently, so a surviving payload proves real round trips.
    seen.normal.encoding?.should.equal('gzip');
    seen.light.encoding?.should.equal('gzip');
    (seen.normal.vary ?? '').should.contain('accept-encoding');
    seen.light.vary?.should.equal(seen.normal.vary);
    // The stale uncompressed length is dropped in both modes.
    (seen.normal.contentLength === null).should.be.true;
    (seen.light.contentLength === null).should.be.true;
    seen.normal.body.should.equal(payload);
    seen.light.body.should.equal(payload);
  });

  it('skips bodies under minBytes — no encoding, no Vary rewrite', async () => {
    const seen = await inBoth(urls, async (url) => {
      const res = await fetch(`${url}/small`, {
        headers: { 'accept-encoding': 'gzip' },
      });
      return {
        encoding: res.headers.get('content-encoding'),
        vary: res.headers.get('vary'),
        body: await res.text(),
      };
    });
    (seen.normal.encoding === null).should.be.true;
    (seen.light.encoding === null).should.be.true;
    (seen.normal.vary === null).should.be.true;
    (seen.light.vary === null).should.be.true;
    seen.normal.body.should.equal('tiny');
    seen.light.body.should.equal('tiny');
  });
});

describe('streamSSE battery over real http (both modes)', () => {
  let urls: { normal: string; light: string };

  beforeAll(async () => {
    urls = await serveBoth(() => {
      const app = createApp();
      use(app, modeMarker());
      get(app, '/events', (ctx) =>
        streamSSE(ctx, async (writer) => {
          await writer.writeSSE({ data: 'hello' });
          await writer.heartbeat();
          await writer.writeSSE({
            id: '1',
            event: 'update',
            data: { n: 1 },
            retry: 5000,
          });
        }),
      );
      return app;
    });
  });

  it('delivers two events and a heartbeat through the raw body stream', async () => {
    const expected =
      'data: hello\n\n' +
      ': heartbeat\n\n' +
      'id: 1\nevent: update\ndata: {"n":1}\nretry: 5000\n\n';
    const seen = await inBoth(urls, async (url) => {
      const res = await fetch(`${url}/events`);
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let body = '';
      if (reader !== undefined) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          body += decoder.decode(value, { stream: true });
        }
      }
      body += decoder.decode();
      return {
        mode: res.headers.get('x-s200-mode'),
        status: res.status,
        contentType: res.headers.get('content-type'),
        cacheControl: res.headers.get('cache-control'),
        body,
      };
    });
    seen.normal.mode?.should.equal('normal');
    seen.light.mode?.should.equal('light');
    seen.normal.status.should.equal(200);
    seen.light.status.should.equal(200);
    seen.normal.contentType?.should.equal('text/event-stream');
    seen.light.contentType?.should.equal(seen.normal.contentType);
    seen.normal.cacheControl?.should.equal('no-cache');
    seen.light.cacheControl?.should.equal(seen.normal.cacheControl);
    seen.normal.body.should.equal(expected);
    seen.light.body.should.equal(expected);
  });
});

describe('light headers duck type over real http (both modes)', () => {
  let urls: { normal: string; light: string };

  beforeAll(async () => {
    urls = await serveBoth(() => {
      const app = createApp();
      use(app, async (ctx, next) => {
        // Request-side mutation (the request-id pattern): set through the
        // same object the handler later reads.
        ctx.req.headers.set('x-s200-mutated', 'set-by-middleware');
        await next();
        // Unwind: observe the final response headers through forEach and
        // stamp the observations as wire headers the client asserts on.
        const names: string[] = [];
        ctx.res?.headers.forEach((_value, name) => names.push(name));
        ctx.res?.headers.append('x-s200-order', names.join('|'));
        ctx.res?.headers.append(
          'x-s200-deleted',
          String(ctx.res?.headers.has('x-s200-doomed') === false)
        );
      });
      get(app, '/headers', (ctx) => {
        const res = json(ctx, {
          readLower: ctx.req.headers.get('X-S200-PROBE'),
          readUpper: ctx.req.headers.get('x-s200-probe'),
          hasGone: ctx.req.headers.has('x-s200-gone'),
          mutated: ctx.req.headers.get('x-s200-mutated'),
        });
        // json() materialized ctx.res synchronously — mutate it now.
        ctx.res?.headers.append('x-s200-multi', 'one');
        ctx.res?.headers.append('X-S200-Multi', 'two');
        ctx.res?.headers.append('x-s200-doomed', 'bye');
        ctx.res?.headers.delete('x-s200-doomed');
        return res;
      });
      get(app, '/cookies', (ctx) => {
        const res = text(ctx, 'ok');
        ctx.res?.headers.append('set-cookie', 'a=1; Path=/');
        ctx.res?.headers.append('set-cookie', 'b=2; Path=/');
        return res;
      });
      return app;
    });
  });

  it('reads request headers case-insensitively and mutates in place', async () => {
    const seen = await inBoth(urls, async (url) => {
      const res = await fetch(`${url}/headers`, {
        headers: { 'X-S200-Probe': 'probe-value' },
      });
      return await res.json();
    });
    for (const mode of ['normal', 'light'] as const) {
      seen[mode].readLower.should.equal('probe-value');
      seen[mode].readUpper.should.equal('probe-value');
      seen[mode].hasGone.should.be.false;
      seen[mode].mutated.should.equal('set-by-middleware');
    }
  });

  it('exposes the full header set; the light duck keeps insertion order', async () => {
    const seen = await inBoth(urls, async (url) => {
      const res = await fetch(`${url}/headers`, {
        headers: { 'X-S200-Probe': 'probe-value' },
      });
      return {
        order: res.headers.get('x-s200-order'),
        deleted: res.headers.get('x-s200-deleted'),
      };
    });
    // Same set on both sides (the doomed name never survives its delete).
    const sorted = (order: string | null): string[] =>
      (order ?? '').split('|').sort();
    sorted(seen.normal.order).should.deep.equal([
      'content-length',
      'content-type',
      'x-s200-multi',
    ]);
    sorted(seen.light.order).should.deep.equal(sorted(seen.normal.order));
    // Iteration order is the one deliberate divergence: undici's platform
    // Headers iterate alphabetically, the light duck preserves arrival
    // order (content-type set first by json(), then content-length, then
    // the handler's append) — the wire set is identical either way.
    seen.light.order?.should.equal('content-type|content-length|x-s200-multi');
    seen.normal.deleted?.should.equal('true');
    seen.light.deleted?.should.equal('true');
  });

  it('keeps each appended set-cookie a separate wire header', async () => {
    const seen = await inBoth(urls, async (url) => {
      const res = await fetch(`${url}/cookies`);
      return {
        cookies: res.headers.getSetCookie(),
        combined: res.headers.get('set-cookie'),
      };
    });
    for (const mode of ['normal', 'light'] as const) {
      seen[mode].cookies.should.deep.equal(['a=1; Path=/', 'b=2; Path=/']);
      // set-cookie stays separate per value on the wire and in
      // getSetCookie; only a plain get() sees the comma-joined form.
      (seen[mode].combined ?? '').should.equal('a=1; Path=/, b=2; Path=/');
    }
  });

  it('combines duplicated non-cookie values with ", " like the platform', async () => {
    const seen = await inBoth(urls, async (url) =>
      fetch(`${url}/headers`, {
        headers: { 'X-S200-Probe': 'probe-value' },
      }).then((res) => res.headers.get('x-s200-multi')),
    );
    (seen.normal ?? '').should.equal('one, two');
    (seen.light ?? '').should.equal('one, two');
  });
});

describe('stream battery over real http (both modes)', () => {
  let urls: { normal: string; light: string };

  beforeAll(async () => {
    urls = await serveBoth(() => {
      const app = createApp();
      use(app, modeMarker());
      get(app, '/chunks', (ctx) =>
        stream(ctx, async (writer) => {
          await writer.write('chunk-a');
          await writer.write(new TextEncoder().encode('|chunk-b'));
        }),
      );
      get(app, '/custom', (ctx) =>
        stream(
          ctx,
          async (writer) => {
            await writer.write('payload');
          },
          { headers: { 'content-type': 'application/custom' } },
        ),
      );
      return app;
    });
  });

  it('delivers string and Uint8Array chunks through the raw body stream', async () => {
    const seen = await inBoth(urls, async (url) => {
      const res = await fetch(`${url}/chunks`);
      return {
        mode: res.headers.get('x-s200-mode'),
        status: res.status,
        contentType: res.headers.get('content-type'),
        body: await res.text(),
      };
    });
    seen.normal.mode?.should.equal('normal');
    seen.light.mode?.should.equal('light');
    seen.normal.status.should.equal(200);
    seen.light.status.should.equal(200);
    seen.normal.contentType?.should.equal('application/octet-stream');
    seen.light.contentType?.should.equal(seen.normal.contentType);
    seen.normal.body.should.equal('chunk-a|chunk-b');
    seen.light.body.should.equal('chunk-a|chunk-b');
  });

  it('honors a custom content-type init on the streamed response', async () => {
    const seen = await inBoth(urls, async (url) => {
      const res = await fetch(`${url}/custom`);
      return {
        contentType: res.headers.get('content-type'),
        body: await res.text(),
      };
    });
    seen.normal.contentType?.should.equal('application/custom');
    seen.light.contentType?.should.equal('application/custom');
    seen.normal.body.should.equal('payload');
    seen.light.body.should.equal('payload');
  });
});

describe('compress battery over streamed light bodies (both modes)', () => {
  let urls: { normal: string; light: string };

  beforeAll(async () => {
    urls = await serveBoth(() => {
      const app = createApp();
      use(app, modeMarker());
      use(app, compress({ minBytes: 32 }));
      get(app, '/streamed', (ctx) =>
        stream(ctx, async (writer) => {
          // No content-length on a streamed response — compress applies
          // regardless of minBytes, like a proxy would.
          await writer.write('s'.repeat(48));
          await writer.write('t'.repeat(48));
        }),
      );
      return app;
    });
  });

  it('pipes a streamed body through CompressionStream and decodes back', async () => {
    const payload = 's'.repeat(48) + 't'.repeat(48);
    const seen = await inBoth(urls, async (url) => {
      const res = await fetch(`${url}/streamed`, {
        headers: { 'accept-encoding': 'gzip' },
      });
      return {
        mode: res.headers.get('x-s200-mode'),
        status: res.status,
        encoding: res.headers.get('content-encoding'),
        vary: res.headers.get('vary'),
        contentLength: res.headers.get('content-length'),
        body: await res.text(),
      };
    });
    seen.normal.mode?.should.equal('normal');
    seen.light.mode?.should.equal('light');
    seen.normal.status.should.equal(200);
    seen.light.status.should.equal(200);
    // The light path's pipeThrough branch: bytesSync() is null for a stream
    // source, so the rebuilt light response stays streamed end to end.
    seen.normal.encoding?.should.equal('gzip');
    seen.light.encoding?.should.equal('gzip');
    (seen.normal.vary ?? '').should.contain('accept-encoding');
    seen.light.vary?.should.equal(seen.normal.vary);
    (seen.normal.contentLength === null).should.be.true;
    (seen.light.contentLength === null).should.be.true;
    seen.normal.body.should.equal(payload);
    seen.light.body.should.equal(payload);
  });
});

describe('serveStatic byte bodies over real http (both modes)', () => {
  let urls: { normal: string; light: string };
  let dir: string;
  const bigBytes = new Uint8Array(256).map((_, i) => i & 0xff);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 's200-light-static-'));
    await writeFile(join(dir, 'ok.txt'), 'public ok\n');
    await writeFile(join(dir, 'big.bin'), bigBytes);
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'sub', 'index.html'), '<html>index</html>');
    urls = await serveBoth(() => {
      const app = createApp();
      use(app, modeMarker());
      use(
        app,
        serveStatic({
          read: createFileReader(dir),
          stat: createFileStat(dir),
          readRange: createFileRangeReader(dir),
          cacheControl: 'no-cache',
        }),
      );
      return app;
    });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('serves a whole file as byte-backed body with validators and length', async () => {
    const seen = await inBoth(urls, async (url) => {
      const res = await fetch(`${url}/ok.txt`);
      return {
        mode: res.headers.get('x-s200-mode'),
        status: res.status,
        contentType: res.headers.get('content-type'),
        etag: res.headers.get('etag'),
        lastModified: res.headers.get('last-modified'),
        cacheControl: res.headers.get('cache-control'),
        contentLength: res.headers.get('content-length'),
        body: await res.text(),
      };
    });
    seen.normal.mode?.should.equal('normal');
    seen.light.mode?.should.equal('light');
    seen.normal.status.should.equal(200);
    seen.light.status.should.equal(200);
    seen.normal.contentType?.should.equal('text/plain; charset=utf-8');
    seen.light.contentType?.should.equal(seen.normal.contentType);
    seen.normal.etag?.should.match(/^W\/"/);
    seen.light.etag?.should.equal(seen.normal.etag);
    seen.light.lastModified?.should.equal(seen.normal.lastModified);
    seen.normal.cacheControl?.should.equal('no-cache');
    seen.light.cacheControl?.should.equal('no-cache');
    seen.normal.contentLength?.should.equal('public ok\n'.length.toString());
    seen.light.contentLength?.should.equal(seen.normal.contentLength);
    seen.normal.body.should.equal('public ok\n');
    seen.light.body.should.equal('public ok\n');
  });

  it('answers HEAD bodylessly with the GET size advertised', async () => {
    const seen = await inBoth(urls, async (url) => {
      const res = await fetch(`${url}/ok.txt`, { method: 'HEAD' });
      return {
        status: res.status,
        contentLength: res.headers.get('content-length'),
        body: await res.text(),
      };
    });
    seen.normal.status.should.equal(200);
    seen.light.status.should.equal(200);
    seen.normal.contentLength?.should.equal('public ok\n'.length.toString());
    seen.light.contentLength?.should.equal(seen.normal.contentLength);
    seen.normal.body.should.equal('');
    seen.light.body.should.equal('');
  });

  it('answers a conditional hit with a bodyless 304', async () => {
    const seen = await inBoth(urls, async (url) => {
      const first = await fetch(`${url}/ok.txt`);
      const tag = first.headers.get('etag');
      await first.text();
      const res = await fetch(`${url}/ok.txt`, {
        headers: { 'if-none-match': tag ?? '' },
      });
      return { status: res.status, body: await res.text() };
    });
    seen.normal.status.should.equal(304);
    seen.light.status.should.equal(304);
    seen.normal.body.should.equal('');
    seen.light.body.should.equal('');
  });

  it('slices a single byte-range out of the buffered bytes (206)', async () => {
    const seen = await inBoth(urls, async (url) => {
      const res = await fetch(`${url}/big.bin`, {
        headers: { range: 'bytes=4-7' },
      });
      return {
        status: res.status,
        contentRange: res.headers.get('content-range'),
        contentLength: res.headers.get('content-length'),
        bytes: Array.from(new Uint8Array(await res.arrayBuffer())),
      };
    });
    for (const mode of ['normal', 'light'] as const) {
      seen[mode].status.should.equal(206);
      seen[mode].contentRange?.should.equal('bytes 4-7/256');
      seen[mode].contentLength?.should.equal('4');
      seen[mode].bytes.should.deep.equal([4, 5, 6, 7]);
    }
  });

  it('streams a readRange slice for the same window (206 parity)', async () => {
    const seen = await inBoth(urls, async (url) => {
      const res = await fetch(`${url}/big.bin`, {
        headers: { range: 'bytes=250-' },
      });
      return {
        status: res.status,
        contentRange: res.headers.get('content-range'),
        bytes: Array.from(new Uint8Array(await res.arrayBuffer())),
      };
    });
    for (const mode of ['normal', 'light'] as const) {
      seen[mode].status.should.equal(206);
      seen[mode].contentRange?.should.equal('bytes 250-255/256');
      seen[mode].bytes.should.deep.equal([250, 251, 252, 253, 254, 255]);
    }
  });

  it('answers an unsatisfiable range with 416 and the total size', async () => {
    const seen = await inBoth(urls, async (url) => {
      const res = await fetch(`${url}/big.bin`, {
        headers: { range: 'bytes=99999-' },
      });
      return {
        status: res.status,
        contentRange: res.headers.get('content-range'),
        body: await res.text(),
      };
    });
    for (const mode of ['normal', 'light'] as const) {
      seen[mode].status.should.equal(416);
      seen[mode].contentRange?.should.equal('bytes */256');
      seen[mode].body.should.equal('');
    }
  });

  it('redirects a slashless directory request to its index (301)', async () => {
    const seen = await inBoth(urls, async (url) => {
      const res = await fetch(`${url}/sub`, { redirect: 'manual' });
      return {
        status: res.status,
        location: res.headers.get('location'),
        body: await res.text(),
      };
    });
    for (const mode of ['normal', 'light'] as const) {
      seen[mode].status.should.equal(301);
      seen[mode].location?.should.match(/\/sub\/$/);
      seen[mode].body.should.equal('');
    }
  });
});

describe('serveStatic streamed files over real http (both modes)', () => {
  let urls: { normal: string; light: string };
  let dir: string;
  const fileBytes = new Uint8Array(512).map((_, i) => (i * 7) & 0xff);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 's200-light-stream-'));
    await writeFile(join(dir, 'lorem.bin'), fileBytes);
    urls = await serveBoth(() => {
      const app = createApp();
      use(app, modeMarker());
      use(
        app,
        serveStatic({
          read: createFileReader(dir, { stream: true }),
          stat: createFileStat(dir),
          readRange: createFileRangeReader(dir),
        }),
      );
      return app;
    });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('streams the whole file with stat-derived length and validators', async () => {
    const seen = await inBoth(urls, async (url) => {
      const res = await fetch(`${url}/lorem.bin`);
      return {
        mode: res.headers.get('x-s200-mode'),
        status: res.status,
        etag: res.headers.get('etag'),
        contentLength: res.headers.get('content-length'),
        bytes: Array.from(new Uint8Array(await res.arrayBuffer())),
      };
    });
    seen.normal.mode?.should.equal('normal');
    seen.light.mode?.should.equal('light');
    for (const mode of ['normal', 'light'] as const) {
      seen[mode].status.should.equal(200);
      seen[mode].etag?.should.match(/^W\/"/);
      seen[mode].contentLength?.should.equal('512');
      seen[mode].bytes.should.deep.equal(Array.from(fileBytes));
    }
    seen.light.etag?.should.equal(seen.normal.etag);
  });

  it('streams a readRange window as 206 with content-range framing', async () => {
    const seen = await inBoth(urls, async (url) => {
      const res = await fetch(`${url}/lorem.bin`, {
        headers: { range: 'bytes=100-199' },
      });
      return {
        status: res.status,
        contentRange: res.headers.get('content-range'),
        contentLength: res.headers.get('content-length'),
        bytes: Array.from(new Uint8Array(await res.arrayBuffer())),
      };
    });
    for (const mode of ['normal', 'light'] as const) {
      seen[mode].status.should.equal(206);
      seen[mode].contentRange?.should.equal('bytes 100-199/512');
      seen[mode].contentLength?.should.equal('100');
      seen[mode].bytes.should.deep.equal(Array.from(fileBytes.subarray(100, 200)));
    }
  });

  it('answers HEAD over the stream reader bodylessly with the size', async () => {
    const seen = await inBoth(urls, async (url) => {
      const res = await fetch(`${url}/lorem.bin`, { method: 'HEAD' });
      return {
        status: res.status,
        contentLength: res.headers.get('content-length'),
        body: await res.text(),
      };
    });
    for (const mode of ['normal', 'light'] as const) {
      seen[mode].status.should.equal(200);
      seen[mode].contentLength?.should.equal('512');
      seen[mode].body.should.equal('');
    }
  });
});

describe('request body readers over real http (both modes)', () => {
  let urls: { normal: string; light: string };
  const boundary = 's200lightboundary';

  beforeAll(async () => {
    urls = await serveBoth(() => {
      const app = createApp();
      use(app, modeMarker());
      post(app, '/json', async (ctx) => json(ctx, await readJson<{ n: number }>(ctx)));
      post(app, '/text', async (ctx) => text(ctx, await readText(ctx)));
      post(app, '/form', async (ctx) => {
        const form = await readForm(ctx);
        const file = form.get('file');
        return json(ctx, {
          field: form.get('field'),
          fileName: file instanceof File ? file.name : null,
          fileText: file instanceof File ? await file.text() : null,
        });
      });
      post(app, '/stream', async (ctx) => {
        const reader = readStream(ctx).getReader();
        const decoder = new TextDecoder();
        let body = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          body += decoder.decode(value, { stream: true });
        }
        return json(ctx, { body });
      });
      post(app, '/limited', async (ctx) =>
        json(ctx, await readJson(ctx, { limit: 8 })),
      );
      return app;
    });
  });

  it('readJson parses a POSTed JSON body', async () => {
    const seen = await inBoth(urls, async (url) => {
      const res = await fetch(`${url}/json`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ n: 42 }),
      });
      return {
        mode: res.headers.get('x-s200-mode'),
        status: res.status,
        body: await res.json(),
      };
    });
    seen.normal.mode?.should.equal('normal');
    seen.light.mode?.should.equal('light');
    for (const mode of ['normal', 'light'] as const) {
      seen[mode].status.should.equal(200);
      (seen[mode].body as { n: number }).n.should.equal(42);
    }
  });

  it('readText returns the raw POSTed text byte-exactly', async () => {
    const seen = await inBoth(urls, async (url) => {
      const res = await fetch(`${url}/text`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'héllo light path',
      });
      return { status: res.status, body: await res.text() };
    });
    for (const mode of ['normal', 'light'] as const) {
      seen[mode].status.should.equal(200);
      seen[mode].body.should.equal('héllo light path');
    }
  });

  it('readForm parses urlencoded and multipart bodies', async () => {
    const seen = await inBoth(urls, async (url) => {
      const urlencoded = await fetch(`${url}/form`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'field=urlencoded',
      });
      const multipart = await fetch(`${url}/form`, {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        body: new TextEncoder().encode(
          `--${boundary}\r\n` +
            'Content-Disposition: form-data; name="field"\r\n' +
            '\r\n' +
            'multipart value\r\n' +
            `--${boundary}\r\n` +
            'Content-Disposition: form-data; name="file"; filename="f.txt"\r\n' +
            'Content-Type: text/plain\r\n' +
            '\r\n' +
            'file content\r\n' +
            `--${boundary}--\r\n`,
        ),
      });
      return {
        urlencoded: (await urlencoded.json()) as {
          field: string;
          fileName: string | null;
        },
        multipart: (await multipart.json()) as {
          field: string;
          fileName: string | null;
          fileText: string | null;
        },
      };
    });
    for (const mode of ['normal', 'light'] as const) {
      seen[mode].urlencoded.field.should.equal('urlencoded');
      (seen[mode].urlencoded.fileName === null).should.be.true;
      seen[mode].multipart.field.should.equal('multipart value');
      (seen[mode].multipart.fileName ?? '').should.equal('f.txt');
      (seen[mode].multipart.fileText ?? '').should.equal('file content');
    }
  });

  it('readStream forwards the upload chunk by chunk without buffering', async () => {
    const seen = await inBoth(urls, async (url) => {
      const res = await fetch(`${url}/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: 'streamed-upload-body',
      });
      return { status: res.status, body: await res.json() };
    });
    for (const mode of ['normal', 'light'] as const) {
      seen[mode].status.should.equal(200);
      (seen[mode].body as { body: string }).body.should.equal('streamed-upload-body');
    }
  });

  it('enforces the byte budget with a 413 on the light request too', async () => {
    const seen = await inBoth(urls, async (url) => {
      const res = await fetch(`${url}/limited`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pad: 'x'.repeat(64) }),
      });
      return {
        status: res.status,
        body: (await res.json()) as { error?: string },
      };
    });
    for (const mode of ['normal', 'light'] as const) {
      seen[mode].status.should.equal(413);
      (seen[mode].body.error ?? '').should.contain('too large');
    }
  });
});
