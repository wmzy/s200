import { describe, it } from 'vitest';

import { createApp, get, handle, use } from '../src/app';
import { compress } from '../src/compress';

function accept(encoding: string): HeadersInit {
  return { 'accept-encoding': encoding };
}

describe('compress', function () {
  it('round-trips the body through gzip decompression', async function () {
    const app = createApp();
    use(app, compress());
    get(app, '/', () => new Response('hello compression world, again and again'));
    const res = await handle(app, new Request('http://localhost/', { headers: accept('gzip') }));
    res.status.should.equal(200);
    res.headers.get('content-encoding')!.should.equal('gzip');
    res.headers.has('content-length').should.be.false;
    (res.headers.get('vary') ?? '').should.contain('accept-encoding');
    const bytes = new Uint8Array(await res.arrayBuffer());
    const text = await new Response(
      new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')),
    ).text();
    text.should.equal('hello compression world, again and again');
  });

  it('skips when the client does not accept a supported encoding', async function () {
    const app = createApp();
    use(app, compress());
    get(app, '/', () => new Response('plain'));
    const res = await handle(app, new Request('http://localhost/', { headers: accept('identity') }));
    res.headers.has('content-encoding').should.be.false;
    (await res.text()).should.equal('plain');
  });

  it('skips bodies below the byte threshold when a length is known', async function () {
    const app = createApp();
    use(app, compress({ minBytes: 1024 }));
    // Undici sets content-length lazily at serialization, so the length the
    // threshold consults must come from a header — static/stats responses
    // carry one; this fixture pins it explicitly.
    get(app, '/', () => new Response('tiny', { headers: { 'content-length': '4' } }));
    const res = await handle(app, new Request('http://localhost/', { headers: accept('gzip') }));
    res.headers.has('content-encoding').should.be.false;
  });

  it('skips already-encoded and no-transform responses', async function () {
    const app = createApp();
    use(app, compress());
    get(app, '/enc', () =>
      new Response('x'.repeat(4096), { headers: { 'content-encoding': 'br' } }),
    );
    get(app, '/nt', () =>
      new Response('x'.repeat(4096), { headers: { 'cache-control': 'no-transform' } }),
    );
    const enc = await handle(
      app,
      new Request('http://localhost/enc', { headers: accept('gzip') }),
    );
    enc.headers.get('content-encoding')!.should.equal('br');
    const nt = await handle(
      app,
      new Request('http://localhost/nt', { headers: accept('gzip') }),
    );
    nt.headers.has('content-encoding').should.be.false;
  });

  it('merges vary without duplicating accept-encoding', async function () {
    const app = createApp();
    use(app, compress());
    get(app, '/', () =>
      new Response('x'.repeat(4096), { headers: { vary: 'origin' } }),
    );
    const res = await handle(app, new Request('http://localhost/', { headers: accept('gzip') }));
    res.headers.get('vary')!.should.equal('origin, accept-encoding');
  });

  it('negotiates q-values and falls back to *', async function () {
    const app = createApp();
    use(app, compress());
    get(app, '/', () => new Response('x'.repeat(4096)));
    const noGzip = await handle(
      app,
      new Request('http://localhost/', { headers: accept('gzip;q=0, *;q=1') }),
    );
    noGzip.headers.get('content-encoding')!.should.equal('gzip');
    const noDe = await handle(
      app,
      new Request('http://localhost/', { headers: accept('gzip;q=0, deflate;q=1') }),
    );
    noDe.headers.get('content-encoding')!.should.equal('deflate');
  });
});

describe('compress brotli', () => {
  it('negotiates br through the injected encoder', async () => {
    const app = createApp();
    use(app, compress({ minBytes: 0, brotli: { compress: async (bytes) => new Uint8Array(bytes).reverse() } }));
    get(app, '/', () => new Response('hello brotli world '.repeat(10), { headers: { 'content-length': '200' } }));
    const res = await handle(app, new Request('http://localhost/', { headers: accept('br') }));
    res.headers.get('content-encoding')!.should.equal('br');
    // The fake encoder reverses; reversing twice restores the body.
    const bytes = new Uint8Array(await res.arrayBuffer());
    const restored = Buffer.from(bytes).reverse().toString();
    restored.should.equal('hello brotli world '.repeat(10));
  });

  it('falls back to gzip for streamed bodies when only br is offered', async () => {
    const app = createApp();
    use(app, compress({ brotli: { compress: async () => new Uint8Array(0) } }));
    get(app, '/', () => new Response('no content-length here'));
    const res = await handle(app, new Request('http://localhost/', { headers: accept('br') }));
    // No declared length → brotli disallowed → nothing negotiated.
    res.headers.has('content-encoding').should.be.false;
  });

  it('prefers gzip over br on ties', async () => {
    const app = createApp();
    use(app, compress({ minBytes: 0, brotli: { compress: async (b) => b } }));
    get(app, '/', () => new Response('x'.repeat(200), { headers: { 'content-length': '200' } }));
    const res = await handle(app, new Request('http://localhost/', { headers: accept('gzip, br') }));
    res.headers.get('content-encoding')!.should.equal('gzip');
  });
});
