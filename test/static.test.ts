import type { Ctx } from '../src/types';
import type { ServeStaticOptions } from '../src/static';

import { describe, it } from 'vitest';

import { createApp, get, handle, use } from '../src/app';
import { text } from '../src/respond';
import { serveStatic } from '../src/static';

/** In-memory file store; records every lookup path for exact assertions. */
function makeApp(files: Record<string, string>, options: Omit<ServeStaticOptions, 'read'> = {}) {
  const reads: string[] = [];
  const read = (path: string): Promise<Uint8Array | null> => {
    reads.push(path);
    const content = files[path];
    return Promise.resolve(content === undefined ? null : new TextEncoder().encode(content));
  };
  const app = createApp();
  use(app, serveStatic({ ...options, read }));
  return { app, reads };
}

/**
 * Sentinel middleware: proves serveStatic called next() by responding after
 * it. Running at all proves the fall-through — a serving serveStatic never
 * calls next(). The overwrite is unconditional: after next() settles,
 * ctx.res is always set (handler response or the materialized fallback).
 */
function withSentinel(app: ReturnType<typeof createApp>, marker: string): void {
  use(app, async (ctx, next) => {
    await next();
    text(ctx, marker);
  });
}

describe('serveStatic hits', () => {
  it('serves a file with its content-type by extension', async () => {
    const { app, reads } = makeApp({ 'style.css': 'body{}', 'logo.svg': '<svg/>' });
    const res = await handle(app, new Request('http://localhost/style.css'));
    res.status.should.equal(200);
    res.headers.get('content-type')!.should.equal('text/css; charset=utf-8');
    (await res.text()).should.equal('body{}');
    reads.should.deep.equal(['style.css']);
  });

  it('defaults unknown extensions to application/octet-stream', async () => {
    const { app } = makeApp({ 'data.bin': 'x' });
    const res = await handle(app, new Request('http://localhost/data.bin'));
    res.status.should.equal(200);
    res.headers.get('content-type')!.should.equal('application/octet-stream');
  });

  it('serves HEAD hits with a stripped body but intact headers', async () => {
    const { app } = makeApp({ 'a.txt': 'A' });
    const res = await handle(app, new Request('http://localhost/a.txt', { method: 'HEAD' }));
    res.status.should.equal(200);
    (await res.text()).should.equal('');
    res.headers.get('content-type')!.should.equal('text/plain; charset=utf-8');
  });
});

describe('serveStatic path resolution', () => {
  it('appends the index to directory-style paths', async () => {
    const { app, reads } = makeApp({ 'index.html': '<h1>hi</h1>' });
    const res = await handle(app, new Request('http://localhost/'));
    res.status.should.equal(200);
    res.headers.get('content-type')!.should.equal('text/html; charset=utf-8');
    (await res.text()).should.equal('<h1>hi</h1>');
    reads.should.deep.equal(['index.html']);
  });

  it('honors a custom index name', async () => {
    const { app, reads } = makeApp({ 'home.html': 'x' }, { index: 'home.html' });
    const res = await handle(app, new Request('http://localhost/'));
    res.status.should.equal(200);
    reads.should.deep.equal(['home.html']);
  });

  it('joins the root directory into lookup paths', async () => {
    const { app, reads } = makeApp({ 'assets/app.js': 'x' }, { root: 'assets' });
    const res = await handle(app, new Request('http://localhost/app.js'));
    res.status.should.equal(200);
    reads.should.deep.equal(['assets/app.js']);
  });

  it('serves paths whose dot segments stay under the root', async () => {
    const { app, reads } = makeApp({ 'b.txt': 'B' });
    const res = await handle(app, new Request('http://localhost/a/%2e%2e/b.txt'));
    res.status.should.equal(200);
    (await res.text()).should.equal('B');
    reads.should.deep.equal(['b.txt']);
  });
});

describe('serveStatic traversal guard', () => {
  /**
   * http(s) URLs fold '..' (literal or %2e-encoded) during parsing, so a
   * real Request can never carry one into the middleware. Ctx is plain
   * data though — a hand-built ctx with an opaque-path URL (never
   * normalized by the URL parser) is the one shape that does, and is what
   * the guard exists for.
   */
  function guardCtx(url: string): Ctx {
    // Parsed as a NON-special-scheme URL, the path stays dot-unfolded and
    // percent-encoded — exactly the crafted, never-normalized shape the
    // guard exists for (a real http(s) Request folds '..' during parsing).
    return {
      req: { url, method: 'GET', headers: new Headers() } as unknown as Request,
      url: new URL(url),
      params: {},
      query: new URLSearchParams(),
      state: {},
      res: undefined,
    };
  }

  function drive(url: string, files: Record<string, string>) {
    const reads: string[] = [];
    const middleware = serveStatic({
      read: (path) => {
        reads.push(path);
        const content = files[path];
        return Promise.resolve(content === undefined ? null : new TextEncoder().encode(content));
      },
    });
    const ctx = guardCtx(url);
    let nextCalls = 0;
    const run = middleware(ctx, () => {
      nextCalls += 1;
      return Promise.resolve();
    });
    return { run, ctx, reads, nextCalls: () => nextCalls };
  }

  it('calls next() without reading when .. climbs out of the root', async () => {
    const { run, ctx, reads, nextCalls } = drive('custom:a/../../secret.txt', { 'secret.txt': 'S' });
    await run;
    nextCalls().should.equal(1);
    (ctx.res === undefined).should.be.true;
    reads.should.deep.equal([]);
  });

  it('calls next() without reading when .. climbs out of a nested lookup', async () => {
    const { run, ctx, reads, nextCalls } = drive('custom:docs/%2e%2e/%2e%2e/secret.txt', {
      'secret.txt': 'S',
    });
    await run;
    nextCalls().should.equal(1);
    (ctx.res === undefined).should.be.true;
    reads.should.deep.equal([]);
  });

  it('serves lookups whose .. segments stay inside the root', async () => {
    const { run, ctx, reads, nextCalls } = drive('custom:a/../b.txt', { 'b.txt': 'B' });
    await run;
    nextCalls().should.equal(0);
    reads.should.deep.equal(['b.txt']);
    (await ctx.res!.text()).should.equal('B');
  });

  it('folds encoded traversal at the URL layer, never reading outside the tree', async () => {
    const { app, reads } = makeApp({ 'secret.txt': 'S' });
    const res = await handle(app, new Request('http://localhost/%2e%2e/%2e%2e/secret.txt'));
    res.status.should.equal(200);
    (await res.text()).should.equal('S');
    reads.should.deep.equal(['secret.txt']);
  });
});

describe('serveStatic prefix mounting', () => {
  it('strips a matching prefix and lets other paths reach routes', async () => {
    const app = createApp();
    use(
      app,
      serveStatic({
        prefix: '/static',
        read: (path) =>
          Promise.resolve(
            path === 'a.txt' ? new TextEncoder().encode('A') : null,
          ),
      }),
    );
    get(app, '/a.txt', (ctx) => {
      text(ctx, 'route');
    });

    const served = await handle(app, new Request('http://localhost/static/a.txt'));
    served.status.should.equal(200);
    (await served.text()).should.equal('A');

    const routed = await handle(app, new Request('http://localhost/a.txt'));
    routed.status.should.equal(200);
    (await routed.text()).should.equal('route');
  });

  it('serves the index under the mount point', async () => {
    const app = createApp();
    use(
      app,
      serveStatic({
        prefix: '/static',
        read: (path) =>
          Promise.resolve(path === 'index.html' ? new TextEncoder().encode('I') : null),
      }),
    );
    const res = await handle(app, new Request('http://localhost/static/'));
    res.status.should.equal(200);
    res.headers.get('content-type')!.should.equal('text/html; charset=utf-8');
  });

  it('does not treat a longer path as a prefix match', async () => {
    const { app, reads } = makeApp({ 'a.txt': 'A' }, { prefix: '/static' });
    const res = await handle(app, new Request('http://localhost/staticfoo/a.txt'));
    res.status.should.equal(404);
    reads.should.deep.equal([]);
  });
});

describe('serveStatic fallthrough and spa', () => {
  it('falls through to next() on a miss', async () => {
    const app = createApp();
    use(app, serveStatic({ read: () => Promise.resolve(null) }));
    withSentinel(app, 'fell-through');
    const res = await handle(app, new Request('http://localhost/nope.txt'));
    res.status.should.equal(200);
    (await res.text()).should.equal('fell-through');
  });

  it('ignores non-GET/HEAD methods entirely', async () => {
    const { app, reads } = makeApp({ 'a.txt': 'A' });
    const res = await handle(app, new Request('http://localhost/a.txt', { method: 'POST' }));
    res.status.should.equal(404);
    reads.should.deep.equal([]);
  });

  it('serves the SPA shell for html navigation misses', async () => {
    const { app, reads } = makeApp(
      { 'index.html': '<html>spa</html>' },
      { spa: true },
    );
    const res = await handle(
      app,
      new Request('http://localhost/some/route', { headers: { accept: 'text/html' } }),
    );
    res.status.should.equal(200);
    res.headers.get('content-type')!.should.equal('text/html; charset=utf-8');
    (await res.text()).should.equal('<html>spa</html>');
    // miss → directory-redirect probe → spa shell
    reads.should.deep.equal(['some/route', 'some/route/index.html', 'index.html']);
  });

  it('supports a custom spa file under the root', async () => {
    const { app, reads } = makeApp(
      { 'public/app.html': 'shell' },
      { root: 'public', spa: 'app.html' },
    );
    const res = await handle(
      app,
      new Request('http://localhost/x', { headers: { accept: 'text/html' } }),
    );
    res.status.should.equal(200);
    (await res.text()).should.equal('shell');
    reads.should.deep.equal(['public/x', 'public/x/index.html', 'public/app.html']);
  });

  it('skips the SPA shell when the client does not accept html', async () => {
    const app = createApp();
    use(app, serveStatic({ read: () => Promise.resolve(null), spa: true }));
    withSentinel(app, 'fell-through');
    const res = await handle(
      app,
      new Request('http://localhost/some/route', { headers: { accept: 'application/json' } }),
    );
    (await res.text()).should.equal('fell-through');
  });

  it('skips the SPA shell for HEAD requests', async () => {
    const { app, reads } = makeApp({ 'index.html': 'x' }, { spa: true });
    const res = await handle(
      app,
      new Request('http://localhost/some/route', {
        method: 'HEAD',
        headers: { accept: 'text/html' },
      }),
    );
    res.status.should.equal(404);
    reads.should.deep.equal(['some/route', 'some/route/index.html']);
  });
});

describe('serveStatic dotfiles', () => {
  it('refuses dotfile paths by default, even percent-encoded ones', async () => {
    const { app, reads } = makeApp({ '.env': 'SECRET=x', '.git/config': 'g' });
    for (const path of ['/.env', '/.git/config', '/%2eenv']) {
      const res = await handle(app, new Request(`http://localhost${path}`));
      res.status.should.equal(404);
    }
    reads.should.deep.equal([]);
  });

  it("serves dotfiles when configured with dotfiles: 'allow'", async () => {
    const { app } = makeApp({ '.env': 'SECRET=x' }, { dotfiles: 'allow' });
    const res = await handle(app, new Request('http://localhost/.env'));
    res.status.should.equal(200);
    (await res.text()).should.equal('SECRET=x');
  });

  it('still falls through to a later route that answers the dotfile path', async () => {
    const app = createApp();
    use(app, serveStatic({ read: () => Promise.resolve(null) }));
    get(app, '/.well-known/health', () => new Response('ok'));
    // Denied by the dotfile policy before the route... middleware order:
    // serveStatic runs first and falls through, so the route answers.
    const res = await handle(app, new Request('http://localhost/.well-known/health'));
    res.status.should.equal(200);
    (await res.text()).should.equal('ok');
  });
});

describe('serveStatic range requests', () => {
  it('serves a single byte range with 206 and Content-Range', async () => {
    const { app } = makeApp({ 'file.txt': '0123456789' });
    const res = await handle(
      app,
      new Request('http://localhost/file.txt', { headers: { range: 'bytes=2-5' } }),
    );
    res.status.should.equal(206);
    (res.headers.get('content-range') ?? '').should.equal('bytes 2-5/10');
    (res.headers.get('accept-ranges') ?? '').should.equal('bytes');
    (await res.text()).should.equal('2345');
  });

  it('clamps an open-ended and an over-long end to the representation', async () => {
    const { app } = makeApp({ 'file.txt': '0123456789' });
    const open = await handle(
      app,
      new Request('http://localhost/file.txt', { headers: { range: 'bytes=7-' } }),
    );
    open.status.should.equal(206);
    (await open.text()).should.equal('789');
    const over = await handle(
      app,
      new Request('http://localhost/file.txt', { headers: { range: 'bytes=8-999' } }),
    );
    over.status.should.equal(206);
    (over.headers.get('content-range') ?? '').should.equal('bytes 8-9/10');
    (await over.text()).should.equal('89');
  });

  it('serves suffix ranges as the last N bytes', async () => {
    const { app } = makeApp({ 'file.txt': '0123456789' });
    const res = await handle(
      app,
      new Request('http://localhost/file.txt', { headers: { range: 'bytes=-3' } }),
    );
    res.status.should.equal(206);
    (res.headers.get('content-range') ?? '').should.equal('bytes 7-9/10');
    (await res.text()).should.equal('789');
  });

  it('answers unsatisfiable ranges with 416 and bytes */length', async () => {
    const { app } = makeApp({ 'file.txt': '0123456789' });
    const res = await handle(
      app,
      new Request('http://localhost/file.txt', { headers: { range: 'bytes=99-' } }),
    );
    res.status.should.equal(416);
    (res.headers.get('content-range') ?? '').should.equal('bytes */10');
    (res.body === null).should.be.true;
  });

  it('ignores malformed and multi-range headers, serving the full body', async () => {
    const { app } = makeApp({ 'file.txt': '0123456789' });
    for (const range of ['bytes=abc', 'bytes=5-2', 'bytes=0-1,3-4', 'items=0-1']) {
      const res = await handle(
        app,
        new Request('http://localhost/file.txt', { headers: { range } }),
      );
      res.status.should.equal(200);
      (await res.text()).should.equal('0123456789');
    }
  });

  it('ignores Range on HEAD requests', async () => {
    const { app } = makeApp({ 'file.txt': '0123456789' });
    const res = await handle(
      app,
      new Request('http://localhost/file.txt', {
        method: 'HEAD',
        headers: { range: 'bytes=0-1' },
      }),
    );
    res.status.should.equal(200);
    (res.headers.get('content-range') === null).should.be.true;
    (res.body === null).should.be.true;
  });
});

describe('serveStatic conditional requests', () => {
  const files: Record<string, string> = { 'page.txt': 'content' };
  const stat = (path: string) =>
    Promise.resolve(
      files[path] === undefined ? null : { size: files[path]!.length, mtimeMs: 1_700_000_000_000 },
    );

  it('answers 304 with validators when If-None-Match matches', async () => {
    const reads: string[] = [];
    const app = createApp();
    use(app, serveStatic({ read: (p) => (reads.push(p), Promise.resolve(files[p] === undefined ? null : new TextEncoder().encode(files[p]))), stat }));
    const first = await handle(app, new Request('http://localhost/page.txt'));
    first.status.should.equal(200);
    const etag = first.headers.get('etag')!;
    const second = await handle(app, new Request('http://localhost/page.txt', { headers: { 'if-none-match': etag } }));
    second.status.should.equal(304);
    (second.body === null).should.be.true;
    second.headers.get('etag')!.should.equal(etag);
  });

  it('weak-compares etags and honors If-Modified-Since', async () => {
    const app = createApp();
    use(app, serveStatic({
      read: (p) => Promise.resolve(files[p] === undefined ? null : new TextEncoder().encode(files[p])),
      stat,
    }));
    const first = await handle(app, new Request('http://localhost/page.txt'));
    const etag = first.headers.get('etag')!; // W/"7-18bcf3e6080" shape
    // A strong client tag (no W/) still matches our weak validator.
    const strong = await handle(app, new Request('http://localhost/page.txt', {
      headers: { 'if-none-match': etag.slice(2) },
    }));
    strong.status.should.equal(304);
    const miss = await handle(app, new Request('http://localhost/page.txt', {
      headers: { 'if-none-match': '"7-0000000000000"' },
    }));
    miss.status.should.equal(200);
    const ims = await handle(app, new Request('http://localhost/page.txt', {
      headers: { 'if-modified-since': 'Wed, 20 Sep 2026 00:00:00 GMT' },
    }));
    ims.status.should.equal(304);
  });

  it('ignores If-Modified-Since when If-None-Match is present and misses', async () => {
    const app = createApp();
    use(app, serveStatic({
      read: (p) => Promise.resolve(files[p] === undefined ? null : new TextEncoder().encode(files[p])),
      stat,
    }));
    const res = await handle(app, new Request('http://localhost/page.txt', {
      headers: {
        'if-none-match': '"definitely-not-it"',
        'if-modified-since': 'Wed, 20 Sep 2026 00:00:00 GMT',
      },
    }));
    res.status.should.equal(200);
  });
});

describe('serveStatic streaming and ranges', () => {
  it('serves a streamed read with content-length from stat', async () => {
    const app = createApp();
    use(app, serveStatic({
      read: (p) =>
        Promise.resolve(
          p === 'big.bin' ? new Blob(['streamed-bytes']).stream() : null,
        ),
      stat: (p) =>
        Promise.resolve(p === 'big.bin' ? { size: 14, mtimeMs: 1_700_000_000_000 } : null),
    }));
    const res = await handle(app, new Request('http://localhost/big.bin'));
    res.status.should.equal(200);
    res.headers.get('content-length')!.should.equal('14');
    (await res.text()).should.equal('streamed-bytes');
  });

  it('serves single ranges through readRange without buffering', async () => {
    const app = createApp();
    const rangeReads: [string, number, number][] = [];
    use(app, serveStatic({
      read: () => Promise.resolve(null),
      stat: (p) => Promise.resolve(p === 'video.mp4' ? { size: 1000, mtimeMs: 1_700_000_000_000 } : null),
      readRange: (path, start, end) => {
        rangeReads.push([path, start, end]);
        const bytes = new TextEncoder().encode('0123456789');
        return Promise.resolve(new Blob([bytes.slice(start, end + 1)]).stream());
      },
    }));
    const res = await handle(app, new Request('http://localhost/video.mp4', { headers: { range: 'bytes=2-5' } }));
    res.status.should.equal(206);
    res.headers.get('content-range')!.should.equal('bytes 2-5/1000');
    res.headers.get('content-length')!.should.equal('4');
    rangeReads.should.deep.equal([['video.mp4', 2, 5]]);
  });

  it('answers 416 for unsatisfiable ranges against a known size', async () => {
    const app = createApp();
    use(app, serveStatic({
      read: () => Promise.resolve(null),
      stat: (p) => Promise.resolve(p === 'v' ? { size: 10, mtimeMs: 1 } : null),
      readRange: () => Promise.resolve(null),
    }));
    const res = await handle(app, new Request('http://localhost/v', { headers: { range: 'bytes=100-200' } }));
    res.status.should.equal(416);
  });
});

describe('serveStatic directory redirect and cache control', () => {
  it('redirects a directory path without the trailing slash to the slash form', async () => {
    const { app } = makeApp({ 'docs/index.html': 'D' });
    const res = await handle(app, new Request('http://localhost/docs', { redirect: 'manual' }));
    res.status.should.equal(301);
    res.headers.get('location')!.should.equal('http://localhost/docs/');
  });

  it('falls through when no directory index exists', async () => {
    const app = createApp();
    use(app, serveStatic({ read: () => Promise.resolve(null) }));
    withSentinel(app, 'fell-through');
    const res = await handle(app, new Request('http://localhost/docs'));
    (await res.text()).should.equal('fell-through');
  });

  it('opts out of redirects with redirectToSlash: false', async () => {
    const app = createApp();
    use(app, serveStatic({ read: () => Promise.resolve(null), redirectToSlash: false }));
    withSentinel(app, 'fell-through');
    const res = await handle(app, new Request('http://localhost/docs'));
    (await res.text()).should.equal('fell-through');
  });

  it('stamps cache-control on hits and 304s when configured', async () => {
    const app = createApp();
    use(app, serveStatic({
      read: (p) => Promise.resolve(p === 'a.txt' ? new TextEncoder().encode('A') : null),
      stat: (p) => Promise.resolve(p === 'a.txt' ? { size: 1, mtimeMs: 1_700_000_000_000 } : null),
      cacheControl: 'public, max-age=3600',
    }));
    const first = await handle(app, new Request('http://localhost/a.txt'));
    first.headers.get('cache-control')!.should.equal('public, max-age=3600');
    const second = await handle(app, new Request('http://localhost/a.txt', {
      headers: { 'if-none-match': first.headers.get('etag')! },
    }));
    second.status.should.equal(304);
    second.headers.get('cache-control')!.should.equal('public, max-age=3600');
  });
});

describe('serveStatic realPath guard', () => {
  it('serves when the guard approves — reads happen only after approval', async () => {
    const approved: string[] = [];
    const { app, reads } = makeApp(
      { 'a.txt': 'A' },
      { realPath: async (path) => { approved.push(path); return path; } }
    );
    const res = await handle(app, new Request('http://localhost/a.txt'));
    res.status.should.equal(200);
    (await res.text()).should.equal('A');
    approved.should.deep.equal(['a.txt']);
    reads.should.deep.equal(['a.txt']);
  });

  it('falls through to next() when the guard returns null (symlink escape)', async () => {
    const { app } = makeApp(
      { 'a.txt': 'A' },
      { realPath: () => Promise.resolve(null) }
    );
    withSentinel(app, 'blocked');
    const res = await handle(app, new Request('http://localhost/a.txt'));
    res.status.should.equal(200);
    (await res.text()).should.equal('blocked');
  });

  it('guards directory lookups by their index path', async () => {
    const approved: string[] = [];
    const { app } = makeApp(
      { 'docs/index.html': 'D' },
      { realPath: async (path) => { approved.push(path); return path; } }
    );
    const res = await handle(app, new Request('http://localhost/docs/'));
    res.status.should.equal(200);
    approved.should.deep.equal(['docs/index.html']);
  });

  it('a guard null on the redirect probe falls through instead of 301', async () => {
    const app = createApp();
    use(app, serveStatic({
      read: () => Promise.resolve(null),
      realPath: () => Promise.resolve(null),
    }));
    withSentinel(app, 'fell-through');
    const res = await handle(app, new Request('http://localhost/docs'));
    (await res.text()).should.equal('fell-through');
  });
});
