import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, it } from 'vitest';

import {
  createFileRangeReader as createBunFileRangeReader,
  createFileStat as createBunFileStat,
  createRealPathGuard as createBunRealPathGuard,
} from '../src/bun';
import { all, createApp, get, handle, text, use } from '../src/index';
import {
  createFileRangeReader,
  createFileReader,
  createFileStat,
  createRealPathGuard,
} from '../src/node';
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

  describe('symlink containment (on by default)', () => {
    it('rejects a symlink escaping the root, serves one staying inside', async () => {
      await symlink('/etc/passwd', join(publicDir, 'passwd'));
      await symlink('ok.txt', join(publicDir, 'link.txt'));
      const app = makeFsApp();
      const escapee = await handle(app, new Request('http://localhost/passwd'));
      escapee.status.should.equal(200);
      (await escapee.text()).should.equal('fell-through');
      const inside = await handle(app, new Request('http://localhost/link.txt'));
      inside.status.should.equal(200);
      (await inside.text()).should.equal('public ok\n');
    });

    it('serves the escapee again with realPath: false (opt-out)', async () => {
      await symlink('/etc/passwd', join(publicDir, 'passwd'));
      const app = createApp();
      use(
        app,
        serveStatic({
          read: createFileReader(publicDir, { realPath: false }),
        }),
      );
      all(app, '/*rest', (ctx) => text(ctx, 'fell-through'));
      const res = await handle(app, new Request('http://localhost/passwd'));
      res.status.should.equal(200);
      (await res.text()).should.match(/^root:/);
    });

    it('refuses a Range read through an escaping symlink', async () => {
      await symlink(join(dir, 'secret.txt'), join(publicDir, 'leak.txt'));
      await symlink('ok.txt', join(publicDir, 'inside.txt'));
      // No catch-all route: an escaping lookup must answer 404 here.
      const app = createApp();
      use(
        app,
        serveStatic({
          read: createFileReader(publicDir),
          stat: createFileStat(publicDir),
          readRange: createFileRangeReader(publicDir),
        }),
      );
      const plain = await handle(app, new Request('http://localhost/leak.txt'));
      plain.status.should.equal(404);
      const ranged = await handle(
        app,
        new Request('http://localhost/leak.txt', {
          headers: { range: 'bytes=0-2' },
        }),
      );
      ranged.status.should.equal(404);
      (await ranged.text()).should.not.contain('TOP');
      // The same composition still serves an in-root symlink by range.
      const inside = await handle(
        app,
        new Request('http://localhost/inside.txt', {
          headers: { range: 'bytes=0-2' },
        }),
      );
      inside.status.should.equal(206);
      (await inside.text()).should.equal('pub');
    });
  });

  describe('bun adapter containment parity', () => {
    it('shares the guard contract with the node adapter', async () => {
      const guard = createBunRealPathGuard(publicDir);
      (await guard('ok.txt') === null).should.be.false;
      // A plain miss is not an escape (the SPA fallback relies on it).
      (await guard('missing.txt') === null).should.be.false;
      await symlink(join(dir, 'secret.txt'), join(publicDir, 'leak.txt'));
      (await guard('leak.txt') === null).should.be.true;
      // A missing file under an escaping symlinked directory still escapes.
      await symlink(join(dir), join(publicDir, 'out-dir'));
      (await guard('out-dir/missing.txt') === null).should.be.true;
    });

    it('guards stat and range reads and rejects directories', async () => {
      await mkdir(join(publicDir, 'docs'));
      await symlink(join(dir, 'secret.txt'), join(publicDir, 'leak.txt'));
      const statFile = createBunFileStat(publicDir);
      const readRange = createBunFileRangeReader(publicDir);
      // Escaping symlinks are refused on both non-read paths.
      (await statFile('leak.txt') === null).should.be.true;
      (await readRange('leak.txt', 0, 2) === null).should.be.true;
      // Directories miss before a Bun.file body can start and fail.
      (await statFile('docs') === null).should.be.true;
      (await readRange('docs', 0, 1) === null).should.be.true;
    });
  });

  describe('SPA fallback with an injected realPath guard', () => {
    function makeSpaApp(): ReturnType<typeof createApp> {
      const app = createApp();
      use(
        app,
        serveStatic({
          read: createFileReader(publicDir),
          stat: createFileStat(publicDir),
          readRange: createFileRangeReader(publicDir),
          realPath: createRealPathGuard(publicDir),
          spa: true,
        }),
      );
      return app;
    }

    it('serves the index shell for a missing in-root navigation', async () => {
      await writeFile(join(publicDir, 'index.html'), '<html>shell</html>');
      const app = makeSpaApp();
      const res = await handle(
        app,
        new Request('http://localhost/some/route', {
          headers: { accept: 'text/html' },
        }),
      );
      res.status.should.equal(200);
      (await res.text()).should.equal('<html>shell</html>');
    });

    it('does not serve the shell for an escaping path', async () => {
      await writeFile(join(publicDir, 'index.html'), '<html>shell</html>');
      await symlink(join(dir, 'secret.txt'), join(publicDir, 'leak.txt'));
      const app = makeSpaApp();
      const res = await handle(
        app,
        new Request('http://localhost/leak.txt', {
          headers: { accept: 'text/html' },
        }),
      );
      res.status.should.equal(404);
      (await res.text()).should.not.contain('shell');
    });
  });

  describe('stream threshold (default 16 MiB)', () => {
    const MIB = 1024 * 1024;
    const SIZE = 17 * MIB; // one MiB past the default threshold
    let huge: Buffer;
    let app: ReturnType<typeof createApp>;
    let reads: string[];

    beforeEach(async () => {
      huge = Buffer.alloc(SIZE);
      for (let i = 0; i < huge.length; i += 1) huge[i] = i & 0xff;
      await writeFile(join(publicDir, 'huge.bin'), huge);
      // Spy on what the adapter reader returns — 'bytes' (buffered) vs
      // 'stream' — by wrapping it without changing its behavior.
      reads = [];
      const inner = createFileReader(publicDir);
      const read = (path: string) =>
        inner(path).then((result) => {
          reads.push(
            result === null ? 'null' : result instanceof Uint8Array ? 'bytes' : 'stream'
          );
          return result;
        });
      app = createApp();
      use(
        app,
        serveStatic({
          read,
          stat: createFileStat(publicDir),
          readRange: createFileRangeReader(publicDir),
        }),
      );
      all(app, '/*rest', (ctx) => text(ctx, 'fell-through'));
    });

    it('serves a 17 MiB file streamed with stat-derived length and validators', async () => {
      const res = await handle(app, new Request('http://localhost/huge.bin'));
      res.status.should.equal(200);
      res.headers.get('content-length')!.should.equal(String(SIZE));
      res.headers.get('etag')!.should.match(/^W\/"/);
      const digest = createHash('sha256')
        .update(Buffer.from(await res.arrayBuffer()))
        .digest('hex');
      digest.should.equal(createHash('sha256').update(huge).digest('hex'));
      // Streamed, not buffered — and a small sibling still takes the
      // byte-for-byte buffered path.
      reads.should.deep.equal(['stream']);
      const small = await handle(app, new Request('http://localhost/ok.txt'));
      (await small.text()).should.equal('public ok\n');
      reads.should.deep.equal(['stream', 'bytes']);
    });

    it('answers 206/416 for ranges on the big file via the streamed range reader', async () => {
      const partial = await handle(
        app,
        new Request('http://localhost/huge.bin', { headers: { range: 'bytes=100-199' } })
      );
      partial.status.should.equal(206);
      partial.headers.get('content-length')!.should.equal('100');
      partial.headers
        .get('content-range')!
        .should.equal(`bytes 100-199/${SIZE}`);
      Buffer.from(await partial.arrayBuffer())
        .equals(huge.subarray(100, 200))
        .should.equal(true);
      const unsatisfiable = await handle(
        app,
        new Request('http://localhost/huge.bin', {
          headers: { range: `bytes=${SIZE}-` },
        })
      );
      unsatisfiable.status.should.equal(416);
      unsatisfiable.headers
        .get('content-range')!
        .should.equal(`bytes */${SIZE}`);
    });

    it('advertises the size on HEAD without reading the body', async () => {
      const res = await handle(app, new Request('http://localhost/huge.bin', { method: 'HEAD' }));
      res.status.should.equal(200);
      res.headers.get('content-length')!.should.equal(String(SIZE));
      (await res.text()).should.equal('');
    });

    it('honors an explicit streamThreshold for small files', async () => {
      await writeFile(join(publicDir, 'tiny.txt'), 'a');
      const read = createFileReader(publicDir, { streamThreshold: 8 });
      const ten = await read('ok.txt'); // 10 bytes > 8 → streams
      (ten instanceof ReadableStream).should.equal(true);
      const one = await read('tiny.txt'); // 1 byte ≤ 8 → buffers
      (one instanceof Uint8Array).should.equal(true);
      // The threshold never bypasses containment: an escaping symlink is
      // still a miss (`.should` lives on Object.prototype — spell the
      // null check out).
      await symlink('/etc/passwd', join(publicDir, 'passwd'));
      ((await read('passwd')) === null).should.equal(true);
    });
  });
});
