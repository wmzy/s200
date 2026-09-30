import type { App } from '../src/app';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createApp, get, handle, use } from '../src/app';
import { createHotApp, importFresh, watchAndReload } from '../src/dev';
import { serve } from '../src/node';
import { json, text } from '../src/respond';

const req = (path: string): Request => new Request(`http://localhost${path}`);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const body = async (app: App, path: string): Promise<string> =>
  (await handle(app, req(path))).text();
const status = async (app: App, path: string): Promise<number> =>
  (await handle(app, req(path))).status;

describe('createHotApp', () => {
  it('keeps one app identity while swapping routes, middlewares and policies', async () => {
    const v1 = createApp();
    use(v1, async (ctx, next) => {
      await next();
      ctx.res?.headers.set('x-mw', 'one');
    });
    get(v1, '/old', (ctx) => text(ctx, 'old'));
    const v2 = createApp();
    use(v2, async (ctx, next) => {
      await next();
      ctx.res?.headers.set('x-mw', 'two');
    });
    get(v2, '/new', (ctx) => text(ctx, 'new'));

    const hot = createHotApp(v1);
    hot.app.should.equal(v1);
    const before = await handle(hot.app, req('/old'));
    before.status.should.equal(200);
    before.headers.get('x-mw')?.should.equal('one');

    hot.reload(v2);
    hot.app.should.equal(v1); // identity survives the swap
    (await status(hot.app, '/old')).should.equal(404); // old route gone
    const after = await handle(hot.app, req('/new'));
    after.status.should.equal(200);
    (await after.text()).should.equal('new');
    after.headers.get('x-mw')?.should.equal('two'); // middleware chain replaced
  });

  it('replaces onError and onNotFound policies', async () => {
    const v1 = createApp({
      onError: (ctx) => {
        text(ctx, 'e1', { status: 500 });
      },
      onNotFound: (ctx) => {
        text(ctx, 'nope-1', { status: 404 });
      },
    });
    get(v1, '/boom', () => {
      throw new Error('boom');
    });
    const v2 = createApp({
      onError: (ctx) => {
        text(ctx, 'e2', { status: 500 });
      },
      onNotFound: (ctx) => {
        text(ctx, 'nope-2', { status: 404 });
      },
    });
    get(v2, '/boom', () => {
      throw new Error('boom');
    });

    const hot = createHotApp(v1);
    (await body(hot.app, '/boom')).should.equal('e1');
    (await body(hot.app, '/missing')).should.equal('nope-1');

    hot.reload(v2);
    (await body(hot.app, '/boom')).should.equal('e2');
    (await body(hot.app, '/missing')).should.equal('nope-2');
  });

  it('replaces the matcher (strict → trailing-slash tolerant)', async () => {
    const strict = createApp(); // default matcher: strict trailing slash
    get(strict, '/x', (ctx) => text(ctx, 'x'));
    const loose = createApp({ strict: false });
    get(loose, '/x', (ctx) => text(ctx, 'x'));

    const hot = createHotApp(strict);
    (await status(hot.app, '/x/')).should.equal(404);
    hot.reload(loose);
    (await status(hot.app, '/x/')).should.equal(200);
  });

  it('replaces the logError sink used for unexpected errors', async () => {
    const seen: string[] = [];
    const v1 = createApp({ logError: () => seen.push('old') });
    get(v1, '/boom', () => {
      throw new Error('boom');
    });
    const v2 = createApp({ logError: () => seen.push('new') });
    get(v2, '/boom', () => {
      throw new Error('boom');
    });

    const hot = createHotApp(v1);
    await handle(hot.app, req('/boom'));
    hot.reload(v2);
    await handle(hot.app, req('/boom'));
    seen.should.deep.equal(['old', 'new']);
  });

  it('leaves in-flight requests on the old table', async () => {
    const v1 = createApp();
    get(v1, '/slow', async (ctx) => {
      await sleep(60);
      json(ctx, { v: 'old' });
    });
    const v2 = createApp();
    get(v2, '/slow', async (ctx) => json(ctx, { v: 'new' }));

    const hot = createHotApp(v1);
    const pending = handle(hot.app, req('/slow'));
    await sleep(15); // dispatch has bound the old chain; handler still running
    hot.reload(v2);
    const res = await pending;
    (await res.json()).should.deep.equal({ v: 'old' });
  });

  it('is an idempotent no-op when reload passes identical references', async () => {
    const app = createApp();
    use(app, async (ctx, next) => {
      await next();
      ctx.res?.headers.set('x-mw', 'one');
    });
    get(app, '/x', (ctx) => text(ctx, 'x'));
    const hot = createHotApp(app);
    (await body(hot.app, '/x')).should.equal('x');

    hot.reload(app); // same object: every field self-assigned, no new arrays
    hot.app.routes.should.equal(app.routes);
    hot.app.middlewares.should.equal(app.middlewares);
    const res = await handle(hot.app, req('/x'));
    (await res.text()).should.equal('x');
    res.headers.get('x-mw')?.should.equal('one');
  });
});

describe('importFresh', () => {
  it('returns distinct module instances (ESM cache bypassed)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 's200-dev-fresh-'));
    try {
      const file = join(dir, 'counter.mjs');
      await writeFile(file, 'export let n = 0;\nexport const bump = () => { n += 1; };\n');

      const a = (await importFresh(file)) as { n: number; bump: () => void };
      a.bump();
      a.n.should.equal(1);

      // A cwd-relative specifier resolves to the same file on disk but is a
      // separate fresh evaluation: its counter starts at zero again.
      const rel = relative(process.cwd(), file);
      const b = (await importFresh(rel)) as { n: number; bump: () => void };
      b.n.should.equal(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('watchAndReload', () => {
  it('reloads the hot app when watched files change', async () => {
    const dir = await mkdtemp(join(tmpdir(), 's200-dev-watch-'));
    try {
      const v1 = createApp();
      get(v1, '/v', (ctx) => text(ctx, 'one'));
      const v2 = createApp();
      get(v2, '/v', (ctx) => text(ctx, 'two'));
      const hot = createHotApp(v1);
      (await body(hot.app, '/v')).should.equal('one');

      const w = watchAndReload({
        dirs: [dir],
        load: () => Promise.resolve(v2),
        hot,
        debounceMs: 20,
      });
      await writeFile(join(dir, 'trigger.txt'), 'x');
      await vi.waitFor(async () => {
        (await body(hot.app, '/v')).should.equal('two');
      });
      await w.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('collapses a burst of events into one debounced load', async () => {
    const dir = await mkdtemp(join(tmpdir(), 's200-dev-debounce-'));
    try {
      const v1 = createApp();
      get(v1, '/v', (ctx) => text(ctx, 'one'));
      const v2 = createApp();
      get(v2, '/v', (ctx) => text(ctx, 'two'));
      const hot = createHotApp(v1);
      let loads = 0;
      const w = watchAndReload({
        dirs: [dir],
        load: () => {
          loads += 1;
          return Promise.resolve(v2);
        },
        hot,
        debounceMs: 50,
      });
      await Promise.all([
        writeFile(join(dir, 'a.txt'), '1'),
        writeFile(join(dir, 'b.txt'), '2'),
      ]);
      await vi.waitFor(async () => {
        (await body(hot.app, '/v')).should.equal('two');
      });
      loads.should.equal(1);
      await w.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the previous table and reports when load fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 's200-dev-broken-'));
    try {
      const v1 = createApp();
      get(v1, '/v', (ctx) => text(ctx, 'one'));
      const hot = createHotApp(v1);
      const errors: unknown[] = [];
      const w = watchAndReload({
        dirs: [dir],
        load: () => Promise.reject(new Error('compile failed')),
        hot,
        debounceMs: 20,
        onError: (error) => errors.push(error),
      });
      await writeFile(join(dir, 'broken.ts'), '???');
      await vi.waitFor(() => {
        expect(errors).toHaveLength(1);
      });
      (errors[0] as Error).message.should.equal('compile failed');
      (await body(hot.app, '/v')).should.equal('one'); // old table still live
      await w.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('stops triggering after close()', async () => {
    const dir = await mkdtemp(join(tmpdir(), 's200-dev-close-'));
    try {
      const v1 = createApp();
      get(v1, '/v', (ctx) => text(ctx, 'one'));
      const v2 = createApp();
      get(v2, '/v', (ctx) => text(ctx, 'two'));
      const v3 = createApp();
      get(v3, '/v', (ctx) => text(ctx, 'three'));
      const hot = createHotApp(v1);
      let current = v2;
      let loads = 0;
      const w = watchAndReload({
        dirs: [dir],
        load: () => {
          loads += 1;
          return Promise.resolve(current);
        },
        hot,
        debounceMs: 20,
      });
      await writeFile(join(dir, 'first.txt'), '1');
      await vi.waitFor(async () => {
        (await body(hot.app, '/v')).should.equal('two');
      });
      loads.should.equal(1);

      await w.close();
      current = v3;
      await writeFile(join(dir, 'second.txt'), '2');
      await sleep(200); // well past the debounce window
      loads.should.equal(1); // no further load ran
      (await body(hot.app, '/v')).should.equal('two'); // table unchanged
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('hot reload over a real server', () => {
  it('swaps the table under serve(hot.app) without restarting', async () => {
    const v1 = createApp();
    get(v1, '/hello', (ctx) => json(ctx, { v: 1 }));
    get(v1, '/old', (ctx) => text(ctx, 'old'));
    const hot = createHotApp(v1);
    const server = await serve(hot.app, { port: 0 });
    try {
      const first = await fetch(`${server.url}/hello`);
      first.status.should.equal(200);
      (await first.json()).should.deep.equal({ v: 1 });

      const v2 = createApp();
      get(v2, '/hello', (ctx) => json(ctx, { v: 2 }));
      hot.reload(v2); // live swap; the server object never restarted

      const second = await fetch(`${server.url}/hello`);
      second.status.should.equal(200);
      (await second.json()).should.deep.equal({ v: 2 });
      const gone = await fetch(`${server.url}/old`);
      gone.status.should.equal(404);
    } finally {
      await server.close();
    }
  });
});
