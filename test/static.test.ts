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
    return {
      req: { url, method: 'GET', headers: new Headers() } as unknown as Request,
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
    reads.should.deep.equal(['some/route', 'index.html']);
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
    reads.should.deep.equal(['public/x', 'public/app.html']);
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
    reads.should.deep.equal(['some/route']);
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
