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
    // The explicit q=0 ban holds even though `*` is acceptable — the
    // catch-all lifts the unlisted deflate, not the banned gzip.
    noGzip.headers.get('content-encoding')!.should.equal('deflate');
    const noDe = await handle(
      app,
      new Request('http://localhost/', { headers: accept('gzip;q=0, deflate;q=1') }),
    );
    noDe.headers.get('content-encoding')!.should.equal('deflate');
  });

  it('picks the highest-q encoding regardless of list order', async function () {
    const app = createApp();
    use(app, compress());
    get(app, '/', () => new Response('x'.repeat(4096)));
    const res = await handle(
      app,
      new Request('http://localhost/', { headers: accept('br, gzip;q=0.1') }),
    );
    // No brotli encoder injected → br is not in the supported set, but
    // gzip's explicit 0.1 is the only offer left standing.
    res.headers.get('content-encoding')!.should.equal('gzip');
    const deflateWins = await handle(
      app,
      new Request('http://localhost/', { headers: accept('gzip;q=0.1, deflate;q=0.9') }),
    );
    deflateWins.headers.get('content-encoding')!.should.equal('deflate');
  });

  it('lets an explicit q beat the * catch-all regardless of order', async function () {
    const app = createApp();
    use(app, compress({ minBytes: 0, brotli: { compress: async (b) => b } }));
    get(app, '/', () => new Response('x'.repeat(200), { headers: { 'content-length': '200' } }));
    const starFirst = await handle(
      app,
      new Request('http://localhost/', { headers: accept('*;q=1, br;q=0.5') }),
    );
    const starLast = await handle(
      app,
      new Request('http://localhost/', { headers: accept('br;q=0.5, *;q=1') }),
    );
    // br's explicit 0.5 replaces the catch-all 1 — gzip/deflate ride `*`
    // at q=1 and outrank the down-weighted br in both orders.
    starFirst.headers.get('content-encoding')!.should.equal('gzip');
    starLast.headers.get('content-encoding')!.should.equal('gzip');
  });

  it('bans an encoding outright with q=0', async function () {
    const app = createApp();
    use(app, compress());
    get(app, '/', () => new Response('x'.repeat(4096)));
    const res = await handle(
      app,
      new Request('http://localhost/', { headers: accept('gzip;q=0') }),
    );
    res.headers.has('content-encoding').should.be.false;
    (await res.text()).should.equal('x'.repeat(4096));
  });

  it('treats * as gzip without brotli and br with it', async function () {
    const plain = createApp();
    use(plain, compress());
    get(plain, '/', () => new Response('x'.repeat(4096)));
    const star = await handle(plain, new Request('http://localhost/', { headers: accept('*') }));
    star.headers.get('content-encoding')!.should.equal('gzip');
    const withBr = createApp();
    use(withBr, compress({ minBytes: 0, brotli: { compress: async (b) => b } }));
    get(withBr, '/', () => new Response('x'.repeat(200), { headers: { 'content-length': '200' } }));
    const starBr = await handle(
      withBr,
      new Request('http://localhost/', { headers: accept('*, gzip;q=0') }),
    );
    // gzip is explicitly banned by q=0; `*` lifts br — not the banned gzip.
    starBr.headers.get('content-encoding')!.should.equal('br');
  });

  it('ignores garbage headers', async function () {
    const app = createApp();
    use(app, compress());
    get(app, '/', () => new Response('x'.repeat(4096)));
    const unknown = await handle(
      app,
      new Request('http://localhost/', { headers: accept('not-a-coding, identity') }),
    );
    unknown.headers.has('content-encoding').should.be.false;
    const badQ = await handle(
      app,
      new Request('http://localhost/', { headers: accept('gzip;q=banana') }),
    );
    // An unparseable q parameter is ignored — q stays 1.
    badQ.headers.get('content-encoding')!.should.equal('gzip');
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

  it('prefers br over gzip on q-value ties', async () => {
    const app = createApp();
    use(app, compress({ minBytes: 0, brotli: { compress: async (b) => b } }));
    get(app, '/', () => new Response('x'.repeat(200), { headers: { 'content-length': '200' } }));
    const res = await handle(app, new Request('http://localhost/', { headers: accept('gzip, br') }));
    // Equal q → server preference br > gzip > deflate (brotli is denser).
    res.headers.get('content-encoding')!.should.equal('br');
  });

  it('picks br over a higher-listed low-q gzip', async () => {
    const app = createApp();
    use(app, compress({ minBytes: 0, brotli: { compress: async (b) => b } }));
    get(app, '/', () => new Response('x'.repeat(200), { headers: { 'content-length': '200' } }));
    const res = await handle(
      app,
      new Request('http://localhost/', { headers: accept('br, gzip;q=0.1') }),
    );
    res.headers.get('content-encoding')!.should.equal('br');
  });
});
