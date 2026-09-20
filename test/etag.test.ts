import { describe, it } from 'vitest';

import { createApp, get, handle, use } from '../src/app';
import { etag } from '../src/etag';
import { json, text } from '../src/respond';

describe('etag', () => {
  it('stamps a weak etag on byte-backed helper responses', async () => {
    const app = createApp();
    use(app, etag());
    get(app, '/', (ctx) => json(ctx, { ok: true }));
    const res = await handle(app, new Request('http://localhost/'));
    res.status.should.equal(200);
    res.headers.get('etag')!.should.match(/^W\/"[0-9a-f]{40}"$/);
    (await res.json()).should.deep.equal({ ok: true });
  });

  it('answers If-None-Match hits with a bodyless 304', async () => {
    const app = createApp();
    use(app, etag());
    get(app, '/', (ctx) => json(ctx, { ok: true }));
    const first = await handle(app, new Request('http://localhost/'));
    const tag = first.headers.get('etag')!;
    const res = await handle(
      app,
      new Request('http://localhost/', { headers: { 'if-none-match': tag } })
    );
    res.status.should.equal(304);
    (await res.text()).should.equal('');
    res.headers.get('etag')!.should.equal(tag);
  });

  it('matches a tag inside an If-None-Match list, weakly', async () => {
    const app = createApp();
    use(app, etag({ strong: true }));
    get(app, '/', (ctx) => text(ctx, 'same'));
    const first = await handle(app, new Request('http://localhost/'));
    const tag = first.headers.get('etag')!;
    tag.should.match(/^"[0-9a-f]{40}"$/);
    // The W/ prefix is insignificant on both sides (RFC 9110 §8.8.3).
    const res = await handle(
      app,
      new Request('http://localhost/', {
        headers: { 'if-none-match': `"other", ${tag}` },
      })
    );
    res.status.should.equal(304);
  });

  it('emits a strong tag when asked', async () => {
    const app = createApp();
    use(app, etag({ strong: true }));
    get(app, '/', (ctx) => text(ctx, 'x'));
    const res = await handle(app, new Request('http://localhost/'));
    res.headers.get('etag')!.should.match(/^"[0-9a-f]{40}"$/);
  });

  it('skips responses without a content-length (streamed bodies)', async () => {
    const app = createApp();
    use(app, etag());
    get(app, '/', () => new Response(new ReadableStream()));
    const res = await handle(app, new Request('http://localhost/'));
    res.headers.has('etag').should.be.false;
  });

  it('never overwrites an existing etag', async () => {
    const app = createApp();
    use(app, etag());
    get(app, '/', () =>
      new Response('x', { headers: { etag: '"mine"', 'content-length': '1' } })
    );
    const res = await handle(app, new Request('http://localhost/'));
    res.headers.get('etag')!.should.equal('"mine"');
  });

  it('skips range responses — they manage their own validators', async () => {
    const app = createApp();
    use(app, etag());
    get(app, '/', () =>
      new Response('abc', {
        status: 206,
        headers: { 'content-range': 'bytes 0-2/3', 'content-length': '3' },
      })
    );
    const res = await handle(app, new Request('http://localhost/'));
    res.headers.has('etag').should.be.false;
  });

  it('leaves fallback 404s unstamped — no content-length there', async () => {
    const app = createApp();
    use(app, etag());
    const res = await handle(app, new Request('http://localhost/nope'));
    res.status.should.equal(404);
    res.headers.has('etag').should.be.false;
  });
});
