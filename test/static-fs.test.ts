import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, it } from 'vitest';

import { all, createApp, get, handle, text, use } from '../src/index';
import { createFileReader, createFileStat, createFileRangeReader } from '../src/node';
import { serveStatic } from '../src/static';

/**
 * serveStatic over the real filesystem — the only place the reader's
 * path.join normalization exists, so the packed-%2F traversal regression
 * (test/static.test.ts guards the lookup path) is proven end-to-end here.
 * Also pins the README's documented configuration: rooted readers with no
 * `root` option (a `root: 'public'` + `createFileReader('public')` combo
 * would double the prefix and never find a file).
 */
describe('serveStatic over the real filesystem', () => {
  let dir: string;
  let publicDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 's200-static-'));
    publicDir = join(dir, 'public');
    await mkdir(publicDir);
    await writeFile(join(publicDir, 'ok.txt'), 'public ok\n');
    await writeFile(join(dir, 'secret.txt'), 'TOP SECRET\n');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeFsApp(): ReturnType<typeof createApp> {
    const app = createApp();
    // README configuration: readers rooted at the served directory, no
    // `root` option.
    use(
      app,
      serveStatic({
        read: createFileReader(publicDir),
        stat: createFileStat(publicDir),
        readRange: createFileRangeReader(publicDir),
      }),
    );
    all(app, '/*rest', (ctx) => text(ctx, 'fell-through'));
    return app;
  }

  it('serves files from the rooted reader (README configuration)', async () => {
    const app = makeFsApp();
    const res = await handle(app, new Request('http://localhost/ok.txt'));
    res.status.should.equal(200);
    (await res.text()).should.equal('public ok\n');
    res.headers.get('etag')!.should.match(/^W\/"/);
    res.headers.get('last-modified')!.should.be.a('string');
  });

  it('never reads outside the root through packed %2F traversal', async () => {
    const app = makeFsApp();
    const res = await handle(app, new Request('http://localhost/x%2F..%2F..%2Fsecret.txt'));
    res.status.should.equal(200);
    (await res.text()).should.equal('fell-through');
  });

  it('never reads outside the root through packed %5C traversal', async () => {
    const app = makeFsApp();
    const res = await handle(app, new Request('http://localhost/x%5C..%5C..%5Csecret.txt'));
    res.status.should.equal(200);
    (await res.text()).should.equal('fell-through');
  });

  it('folds packed .. that stays inside the root', async () => {
    const app = makeFsApp();
    const res = await handle(app, new Request('http://localhost/x%2F..%2Fok.txt'));
    res.status.should.equal(200);
    (await res.text()).should.equal('public ok\n');
  });

  it('serves dotfiles only when the policy allows them', async () => {
    await writeFile(join(publicDir, '.env'), 'SECRET=x');
    const denied = createApp();
    use(
      denied,
      serveStatic({
        read: createFileReader(publicDir),
      }),
    );
    all(denied, '/*rest', (ctx) => text(ctx, 'fell-through'));
    const blocked = await handle(denied, new Request('http://localhost/x%2F..%2F.env'));
    (await blocked.text()).should.equal('fell-through');

    const allowed = createApp();
    use(
      allowed,
      serveStatic({
        read: createFileReader(publicDir),
        dotfiles: 'allow',
      }),
    );
    all(allowed, '/*rest', (ctx) => text(ctx, 'fell-through'));
    const served = await handle(allowed, new Request('http://localhost/.env'));
    served.status.should.equal(200);
    (await served.text()).should.equal('SECRET=x');
  });

  it('answers a route registered after serveStatic when the file is missing', async () => {
    const app = createApp();
    use(
      app,
      serveStatic({
        read: createFileReader(publicDir),
      }),
    );
    get(app, '/other', (ctx) => text(ctx, 'route'));
    const res = await handle(app, new Request('http://localhost/other'));
    (await res.text()).should.equal('route');
  });
});
