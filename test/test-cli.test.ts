/**
 * s200 dev runner tests: the load fn and the watcher are injected — no
 * fs.watch, no server ports. The reload phase drives the same reporting
 * wrapper production wiring would, proving the route-table swap happens
 * on ONE server identity (same URL/port, no restart). The graph-reload
 * test alone writes real tmp modules (it must — it proves ESM cache
 * busting across an import edge).
 */
import type { App } from '../src/app';
import type { WatchOptions } from '../src/cli';
import type { WatchAndReloadHandle } from '../src/dev';

import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, it, vi } from 'vitest';

import { createApp, get, post } from '../src/app';
import {
  isMainEntry,
  main,
  parseCodegenArgs,
  parseDevArgs,
  parseRoutesArgs,
  runCodegen,
  runDev,
  runRoutes,
  stampGraphUrl,
  supportsTypeStripping,
} from '../src/cli';
import { html, text } from '../src/respond';
import { stream } from '../src/streaming';

// vitest's should chain has no rejectedWith; capture manually instead.
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined; // resolved — property assertions below will fail
}

const makeApp = (routes: Record<string, string>): App => {
  const app = createApp();
  for (const [pattern, body] of Object.entries(routes)) {
    get(app, pattern, (ctx) => text(ctx, body));
  }
  return app;
};

const appA = makeApp({ '/a': 'a' });
const appB = makeApp({ '/b': 'b' });

/** An app whose misses overlap enough for a hint (2 of 3 segments static). */
const hintsApp = (): App => makeApp({ '/a/b/c': 'x' });

/** One byte-backed HTML page and one streamed HTML page. */
const overlayApp = (): App => {
  const app = createApp();
  get(app, '/page', (ctx) => html(ctx, '<html><body>hello</body></html>'));
  get(
    app,
    '/streamed',
    (ctx) =>
      stream(
        ctx,
        async (writer) => {
          await writer.write('<html><body>stream');
          await writer.write('</body></html>');
        },
        { headers: { 'content-type': 'text/html' } }
      )
  );
  return app;
};

/** Everything the stub watcher captured from the runner. */
type Capture = {
  dirs: readonly string[] | undefined;
  hot: { app: App; reload(next: App): void } | undefined;
  load: (() => Promise<App>) | undefined;
  onError: ((error: unknown) => void) | undefined;
  closes: () => number;
};

let captured: Capture = {
  dirs: undefined,
  hot: undefined,
  load: undefined,
  onError: undefined,
  closes: () => 0,
};

const stubWatch = (options: WatchOptions): WatchAndReloadHandle => {
  // Per-handle counter: a later runDev must not rewire an older handle's
  // close accounting.
  const handle = { closes: 0 };
  captured = {
    dirs: options.dirs,
    hot: options.hot,
    load: options.load,
    onError: options.onError,
    closes: () => handle.closes,
  };
  return {
    close: async () => {
      handle.closes += 1;
    },
  };
};

describe('runDev', () => {
  it('serves the loaded app, then hot-swaps tables on the same server', async () => {
    let loader: () => Promise<App> = async () => appA;
    const reloads: App[] = [];
    const dev = await runDev([], {
      load: () => loader(),
      port: 0,
      watch: stubWatch,
      onReload: (app) => reloads.push(app),
    });

    const href = dev.url.href; // ONE address for both phases
    (await fetch(`${href}a`)).status.should.equal(200);
    (await fetch(`${href}b`)).status.should.equal(404);

    // Swap the loader to app B and drive the reload exactly as the real
    // watcher would: reload(load()).
    loader = async () => appB;
    captured.hot!.should.not.equal(undefined);
    captured.load!.should.not.equal(undefined);
    captured.hot!.reload((await captured.load!()) as App);

    reloads.should.deep.equal([appB]);
    (await fetch(`${href}a`)).status.should.equal(404); // old table gone
    (await fetch(`${href}b`)).status.should.equal(200); // new table live
    dev.url.href.should.equal(href); // still the same server

    (await fetch(`${href}b`)).status.should.equal(200); // repeatable
    await dev.close();
    captured.closes().should.equal(1);
    const refused = (await rejectionOf(fetch(`${href}b`))) as Error; // port released
    refused.should.be.an.instanceOf(Error);
  });


  it("logs one 'reloaded (N routes)' line by default", async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const dev = await runDev([], { load: async () => appA, port: 0, watch: stubWatch });
      captured.hot?.reload(appB);
      log.mock.calls
        .map((call) => call.join(' '))
        .join('\n')
        .should.contain('reloaded (1 routes)');
      await dev.close();
    } finally {
      log.mockRestore();
    }
  });

  it('watches the entry directory plus watchDirs (default entry ./app.ts)', async () => {
    const devDefault = await runDev([], {
      load: async () => appA,
      port: 0,
      watch: stubWatch,
      watchDirs: ['lib'],
    });
    captured.dirs!.should.deep.equal([process.cwd(), 'lib']);
    await devDefault.close();

    const devExplicit = await runDev(['src/api.ts'], {
      load: async () => appA,
      port: 0,
      watch: stubWatch,
    });
    captured.dirs!.should.deep.equal([resolve('src')]);
    await devExplicit.close();
  });

  it('merges --watch dirs after watchDirs (the entry dir always first)', async () => {
    const dev = await runDev(['--watch', 'lib', '--watch=pkgs'], {
      load: async () => appA,
      port: 0,
      watch: stubWatch,
      watchDirs: ['opt-dir'],
    });
    captured.dirs!.should.deep.equal([process.cwd(), 'opt-dir', 'lib', 'pkgs']);
    await dev.close();
  });

  it('loads --env-file before the first load, with the ambient environment winning', async () => {
    const dir = await mkdtemp(join(tmpdir(), 's200-env-'));
    const keys = [
      'S200_ENV_TEST_A',
      'S200_ENV_TEST_B',
      'S200_ENV_TEST_C',
      'S200_ENV_TEST_D',
      'S200_ENV_TEST_E',
      'S200_ENV_TEST_F',
    ];
    try {
      await writeFile(
        join(dir, '.env'),
        [
          '# a comment',
          '',
          'S200_ENV_TEST_A=from-file',
          'S200_ENV_TEST_B="double quoted"',
          "S200_ENV_TEST_C='single quoted'",
          '  S200_ENV_TEST_D = spaced  ',
          'no-equals-line',
          // The shared parser (config's parseEnv, lenient) reads these
          // where the old cli-only one ignored them.
          'export S200_ENV_TEST_E=exported',
          'S200_ENV_TEST_F=kept # trailing comment',
          'S200_ENV_TEST_G="unterminated',
        ].join('\n')
      );
      process.env.S200_ENV_TEST_A = 'preexisting'; // node --env-file parity: the environment wins
      let seen: NodeJS.ProcessEnv = {};
      const dev = await runDev(['--env-file', join(dir, '.env')], {
        load: async () => {
          seen = { ...process.env }; // captured where the entry graph would read it
          return appA;
        },
        port: 0,
        watch: stubWatch,
      });
      seen.S200_ENV_TEST_A!.should.equal('preexisting');
      seen.S200_ENV_TEST_B!.should.equal('double quoted');
      seen.S200_ENV_TEST_C!.should.equal('single quoted');
      seen.S200_ENV_TEST_D!.should.equal('spaced');
      seen.S200_ENV_TEST_E!.should.equal('exported');
      seen.S200_ENV_TEST_F!.should.equal('kept');
      // Lenient parse: the unterminated-quote line is dropped, not fatal.
      (seen.S200_ENV_TEST_G === undefined).should.equal(true);
      await dev.close();
    } finally {
      for (const key of keys) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- process.env has no setter-based removal
        delete process.env[key];
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('errors naming the path when --env-file is missing', async () => {
    const missing = join(tmpdir(), 's200-no-such.env');
    const error = (await rejectionOf(
      runDev(['--env-file', missing], { load: async () => appA, port: 0, watch: stubWatch })
    )) as Error;
    error.message.should.contain(missing);
  });

  it('rejects ports above 65535 from opts and $PORT with the usage error', async () => {
    // Without the shared ceiling, a 70000 sails past the checks and dies
    // inside server.listen on Node's opaque ERR_SOCKET_BAD_PORT instead.
    const viaOpts = (await rejectionOf(
      runDev([], { load: async () => appA, port: 70000, watch: stubWatch })
    )) as Error;
    viaOpts.message.should.contain('invalid port');
    viaOpts.message.should.contain('70000');

    const previous = process.env.PORT;
    process.env.PORT = '70000';
    try {
      const viaEnv = (await rejectionOf(
        runDev([], { load: async () => appA, watch: stubWatch })
      )) as Error;
      viaEnv.message.should.contain('invalid port');
    } finally {
      if (previous === undefined) {
        delete process.env.PORT;
      } else {
        process.env.PORT = previous;
      }
    }
  });

  it('forwards --host to serve: loopback serves, unresolvable host rejects', async () => {
    // A fresh app: earlier tests hot-swap the shared appA's table in place
    // (the createHotApp contract), so it no longer serves '/a'.
    const dev = await runDev(['--host', '127.0.0.1'], {
      load: async () => makeApp({ '/a': 'a' }),
      port: 0,
      watch: stubWatch,
    });
    (await fetch(`${dev.url.href}a`)).status.should.equal(200);
    await dev.close();

    // The flag reaches server.listen itself: an unresolvable host makes
    // the listen fail instead of binding everywhere.
    const error = (await rejectionOf(
      runDev(['--host', 'no-such-host.s200.invalid'], {
        load: async () => appA,
        port: 0,
        watch: stubWatch,
      })
    )) as Error;
    error.message.should.contain('no-such-host.s200.invalid');
  });

  it('boots from a real entry via importFresh + the default-export convention', async () => {
    const dir = await mkdtemp(join(tmpdir(), 's200-cli-'));
    try {
      // A scratch entry that builds a real app from the workspace source;
      // exporting it as default exercises the loader's first convention.
      const appSrc = fileURLToPath(new URL('../src/app.ts', import.meta.url));
      const respondSrc = fileURLToPath(new URL('../src/respond.ts', import.meta.url));
      await writeFile(
        join(dir, 'entry.mjs'),
        `import { createApp, get } from ${JSON.stringify(pathToFileURL(appSrc).href)};\n` +
          `import { text } from ${JSON.stringify(pathToFileURL(respondSrc).href)};\n` +
          'const app = createApp();\n' +
          "get(app, '/', (ctx) => text(ctx, 'fresh'));\n" +
          'export default app;\n'
      );
      const dev = await runDev([join(dir, 'entry.mjs')], { port: 0, watch: stubWatch });
      const res = await fetch(dev.url.href);
      res.status.should.equal(200);
      (await res.text()).should.equal('fresh');
      await dev.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects with the export convention when the entry exports no app', async () => {
    const dir = await mkdtemp(join(tmpdir(), 's200-cli-'));
    try {
      await writeFile(join(dir, 'noapp.mjs'), 'export const other = 1;\n');
      const error = (await rejectionOf(
        runDev([join(dir, 'noapp.mjs')], { port: 0, watch: stubWatch })
      )) as Error;
      error.message.should.contain('exports no app');
      error.message.should.contain('default');
      error.message.should.contain('"app"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('runDev startup report', () => {
  it('prints the aligned route table on first load (registration order)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const app = createApp();
      get(app, '/a', (ctx) => text(ctx, 'a'));
      post(app, '/a/b', (ctx) => text(ctx, 'ab'));
      const dev = await runDev([], { load: async () => app, port: 0, watch: stubWatch });
      const out = log.mock.calls.map((call) => call.join(' ')).join('\n');
      out.should.contain('s200 dev: 2 routes');
      out.should.contain('GET   /a'); // method column padded to POST's width
      out.should.contain('POST  /a/b');
      await dev.close();
    } finally {
      log.mockRestore();
    }
  });

  it('prints the count line only when the table is empty', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const dev = await runDev([], { load: async () => createApp(), port: 0, watch: stubWatch });
      log.mock.calls.map((call) => call.join(' ')).join('\n').should.contain('s200 dev: 0 routes');
      await dev.close();
    } finally {
      log.mockRestore();
    }
  });
});

describe('runDev route hints', () => {
  it('decorates default 404s by default — across reloads, without touching the user app', async () => {
    const dev = await runDev([], { load: async () => hintsApp(), port: 0, watch: stubWatch });
    const href = dev.url.href;
    const miss = await fetch(`${href}a/b/x`); // 2 of 3 segments overlap
    miss.status.should.equal(404);
    (await miss.json()).should.deep.equal({
      error: 'Not Found',
      hint: 'did you mean GET /a/b/c?',
    });

    // Reload through the same seam the real watcher uses; the reloaded
    // table gets hints too, and the user's app object stays pristine.
    const next = makeApp({ '/x/y/z': 'y' });
    captured.hot!.reload(next);
    next.middlewares.should.have.length(0);
    next.routes.should.have.length(1);
    (await (await fetch(`${href}x/y/w`)).json()).should.deep.equal({
      error: 'Not Found',
      hint: 'did you mean GET /x/y/z?',
    });
    await dev.close();
  });

  it('leaves the default 404 body untouched with --no-hints', async () => {
    const dev = await runDev(['--no-hints'], {
      load: async () => hintsApp(),
      port: 0,
      watch: stubWatch,
    });
    const miss = await fetch(`${dev.url.href}a/b/x`);
    miss.status.should.equal(404);
    (await miss.text()).should.equal('{"error":"Not Found"}');
    await dev.close();
  });

  it('never clobbers a custom 404 body even with hints on', async () => {
    const app = createApp({
      onNotFound: (ctx) => {
        text(ctx, 'custom miss', { status: 404 });
      },
    });
    get(app, '/a/b/c', (ctx) => text(ctx, 'x'));
    const dev = await runDev([], { load: async () => app, port: 0, watch: stubWatch });
    const miss = await fetch(`${dev.url.href}a/b/x`);
    (await miss.text()).should.equal('custom miss');
    await dev.close();
  });
});

describe('runDev error overlay (--overlay)', () => {
  it('is off by default: no script, no /__s200/dev-events route', async () => {
    const dev = await runDev([], { load: async () => overlayApp(), port: 0, watch: stubWatch });
    const href = dev.url.href;
    (await (await fetch(`${href}page`)).text()).should.not.contain('__s200');
    (await fetch(`${href}__s200/dev-events`)).status.should.equal(404);
    await dev.close();
  });

  it('injects the inline script before </body> with an honest content-length', async () => {
    const dev = await runDev(['--overlay'], {
      load: async () => overlayApp(),
      port: 0,
      watch: stubWatch,
    });
    const res = await fetch(`${dev.url.href}page`);
    res.headers.get('content-type')?.should.contain('text/html');
    const body = await res.text();
    body.should.contain('/__s200/dev-events'); // the script's EventSource
    (body.lastIndexOf('<script>')! < body.lastIndexOf('</body>')!).should.be.true;
    res.headers.get('content-length')?.should.equal(String(body.length)); // ASCII body
    await dev.close();
  });

  it('skips streamed HTML (no content-length — buffering would defeat streaming)', async () => {
    const dev = await runDev(['--overlay'], {
      load: async () => overlayApp(),
      port: 0,
      watch: stubWatch,
    });
    const body = await (await fetch(`${dev.url.href}streamed`)).text();
    body.should.contain('</body>');
    body.should.not.contain('__s200');
    await dev.close();
  });

  it('streams reload|error events over /__s200/dev-events', async () => {
    const dev = await runDev(['--overlay'], {
      load: async () => appA,
      port: 0,
      watch: stubWatch,
    });
    const res = await fetch(`${dev.url.href}__s200/dev-events`);
    res.status.should.equal(200);
    res.headers.get('content-type')?.should.contain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let seen = '';
    const readUntil = async (what: string): Promise<void> => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && !seen.includes(what)) {
        const { value, done } = await reader.read();
        seen += decoder.decode(value ?? new Uint8Array());
        if (done) {
          break;
        }
      }
      seen.should.contain(what);
    };
    try {
      await readUntil('event: ready'); // opens the stream
      captured.hot!.reload(appB); // exactly what the real watcher drives
      await readUntil('event: reload');
      captured.onError!(new Error('compile failed')); // load failure path
      await readUntil('compile failed');
      seen.should.contain('event: error');
    } finally {
      await reader.cancel();
      await dev.close();
    }
  });
});

describe('s200 routes', () => {
  /** Writes a real entry exporting an app with GET /a and POST /a/b. */
  const writeEntry = async (dir: string, body?: string): Promise<string> => {
    const appSrc = fileURLToPath(new URL('../src/app.ts', import.meta.url));
    await writeFile(
      join(dir, 'entry.mjs'),
      `import { createApp, get, post } from ${JSON.stringify(pathToFileURL(appSrc).href)};\n` +
        `const app = createApp();\n` +
        (body ?? "get(app, '/a', () => new Response('a'));\npost(app, '/a/b', () => new Response('ab'));\n") +
        'export default app;\n'
    );
    return join(dir, 'entry.mjs');
  };

  it('prints the aligned table in registration order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 's200-cli-routes-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const entry = await writeEntry(dir);
      await main(['routes', entry]);
      const out = log.mock.calls.map((call) => call.join(' ')).join('\n');
      out.should.contain('GET   /a');
      out.should.contain('POST  /a/b');
    } finally {
      log.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('prints the full serializable table with --json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 's200-cli-routes-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const entry = await writeEntry(dir);
      await main(['routes', entry, '--json']);
      const table = JSON.parse(log.mock.calls.map((call) => call.join(' ')).join('\n')) as {
        routes: { method: string; pattern: string; params: string[]; middlewareCount: number }[];
      };
      table.routes.should.deep.equal([
        { method: 'GET', pattern: '/a', params: [], middlewareCount: 0 },
        { method: 'POST', pattern: '/a/b', params: [], middlewareCount: 0 },
      ]);
    } finally {
      log.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('prints (no routes) for an empty app and rejects bad argv', async () => {
    const dir = await mkdtemp(join(tmpdir(), 's200-cli-routes-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const entry = await writeEntry(dir, '');
      await runRoutes([entry]);
      log.mock.calls.map((call) => call.join(' ')).join('\n').should.contain('(no routes)');
      parseRoutesArgs([]).should.deep.equal({ entry: './app.ts', json: false });
      parseRoutesArgs(['--json', 'api.mjs']).should.deep.equal({
        entry: 'api.mjs',
        json: true,
      });
      ((await rejectionOf(Promise.resolve().then(() => runRoutes(['--jsonx'])))) as Error).message.should.contain(
        'unknown option'
      );
      ((await rejectionOf(Promise.resolve().then(() => runRoutes(['a.mjs', 'b.mjs'])))) as Error).message.should.contain(
        'unexpected argument'
      );
    } finally {
      log.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('s200 codegen', () => {
  const writeEntry = async (dir: string): Promise<string> => {
    const appSrc = fileURLToPath(new URL('../src/app.ts', import.meta.url));
    await writeFile(
      join(dir, 'entry.mjs'),
      `import { createApp, get } from ${JSON.stringify(pathToFileURL(appSrc).href)};\n` +
        `const app = createApp();\n` +
        "get(app, '/users/:id', () => new Response('u'));\n" +
        'export default app;\n'
    );
    return join(dir, 'entry.mjs');
  };

  it('prints the generateClient module to stdout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 's200-cli-codegen-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const entry = await writeEntry(dir);
      await main(['codegen', entry]);
      const out = log.mock.calls.map((call) => call.join(' ')).join('\n');
      out.should.contain('export function createClient(baseUrl: string, fetcher: typeof fetch = fetch)');
      out.should.contain('getUsersId');
    } finally {
      log.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('bakes --name/--base-url and writes --out with a trailing newline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 's200-cli-codegen-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const entry = await writeEntry(dir);
      const out = join(dir, 'client.ts');
      await main(['codegen', entry, '--name', 'makeApi', '--base-url', 'https://api.test', '--out', out]);
      const file = await readFile(out, 'utf8');
      file.should.contain("export function makeApi(baseUrl: string = 'https://api.test'");
      file.endsWith('\n').should.be.true;
      log.mock.calls.map((call) => call.join(' ')).join('\n').should.contain('wrote');
      parseCodegenArgs([]).should.deep.equal({
        entry: './app.ts',
        out: undefined,
        name: undefined,
        baseUrl: undefined,
      });
      parseCodegenArgs(['--name=X', '--base-url=http://x', '--out=y.ts', 'api.mjs']).should.deep.equal({
        entry: 'api.mjs',
        out: 'y.ts',
        name: 'X',
        baseUrl: 'http://x',
      });
      ((await rejectionOf(Promise.resolve().then(() => runCodegen(['--name'])))) as Error).message.should.contain(
        'requires a value'
      );
      ((await rejectionOf(Promise.resolve().then(() => runCodegen(['--nope'])))) as Error).message.should.contain(
        'unknown option'
      );
    } finally {
      log.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('parseDevArgs', () => {
  it('defaults entry to ./app.ts and leaves port/hints/overlay/host unset', () => {
    parseDevArgs([]).should.deep.equal({
      entry: './app.ts',
      port: undefined,
      hints: undefined,
      overlay: undefined,
      host: undefined,
      watch: [],
      envFiles: [],
    });
  });

  it('takes one entry plus --port in both spellings', () => {
    parseDevArgs(['./src/api.ts']).should.deep.equal({
      entry: './src/api.ts',
      port: undefined,
      hints: undefined,
      overlay: undefined,
      host: undefined,
      watch: [],
      envFiles: [],
    });
    parseDevArgs(['./src/api.ts', '--port', '4123']).should.deep.equal({
      entry: './src/api.ts',
      port: 4123,
      hints: undefined,
      overlay: undefined,
      host: undefined,
      watch: [],
      envFiles: [],
    });
    parseDevArgs(['--port=4123', './src/api.ts']).should.deep.equal({
      entry: './src/api.ts',
      port: 4123,
      hints: undefined,
      overlay: undefined,
      host: undefined,
      watch: [],
      envFiles: [],
    });
  });

  it('parses --no-hints and --overlay in either order', () => {
    parseDevArgs(['--overlay', '--no-hints']).should.deep.equal({
      entry: './app.ts',
      port: undefined,
      hints: false,
      overlay: true,
      host: undefined,
      watch: [],
      envFiles: [],
    });
    parseDevArgs(['entry.mjs', '--no-hints']).should.deep.equal({
      entry: 'entry.mjs',
      port: undefined,
      hints: false,
      overlay: undefined,
      host: undefined,
      watch: [],
      envFiles: [],
    });
  });

  it('parses --host, and repeatable --watch/--env-file, in both spellings', () => {
    parseDevArgs(['--host', '127.0.0.1']).should.deep.equal({
      entry: './app.ts',
      port: undefined,
      hints: undefined,
      overlay: undefined,
      host: '127.0.0.1',
      watch: [],
      envFiles: [],
    });
    parseDevArgs([
      'api.ts',
      '--host=localhost',
      '--watch',
      'lib',
      '--watch=src',
      '--env-file',
      '.env',
      '--env-file=.env.local',
    ]).should.deep.equal({
      entry: 'api.ts',
      port: undefined,
      hints: undefined,
      overlay: undefined,
      host: 'localhost',
      watch: ['lib', 'src'],
      envFiles: ['.env', '.env.local'],
    });
  });

  it('rejects unknown options, bad ports, extra positionals, and missing values', async () => {
    ((await rejectionOf(Promise.resolve().then(() => parseDevArgs(['--nope'])))) as Error).message.should.contain(
      'unknown option'
    );
    ((await rejectionOf(Promise.resolve().then(() => parseDevArgs(['--port', 'nope'])))) as Error).message.should.contain(
      'invalid port'
    );
    ((await rejectionOf(Promise.resolve().then(() => parseDevArgs(['a.ts', 'b.ts'])))) as Error).message.should.contain(
      'unexpected argument'
    );
    ((await rejectionOf(Promise.resolve().then(() => parseDevArgs(['--watch'])))) as Error).message.should.contain(
      'requires a value'
    );
    ((await rejectionOf(Promise.resolve().then(() => parseDevArgs(['--env-file'])))) as Error).message.should.contain(
      'requires a value'
    );
  });
});

describe('main', () => {
  it('rejects unknown commands with usage and the full command list', async () => {
    const error = (await rejectionOf(main(['build']))) as Error;
    error.message.should.contain('unknown command');
    error.message.should.contain('dev, routes, codegen');
    ((await rejectionOf(main(['dev', '--nope']))) as Error).message.should.contain('usage:');
  });
});

describe('isMainEntry (bin self-run guard)', () => {
  it('matches only when argv[1] realpaths to the running module', async () => {
    const dir = await mkdtemp(join(tmpdir(), 's200-cli-guard-'));
    try {
      const real = join(dir, 'real-cli.mjs');
      await writeFile(real, '', 'utf8');
      const link = join(dir, 'bin-link.mjs');
      await symlink(real, link);
      const selfUrl = pathToFileURL(real).href;
      // Direct path, symlinked bin path (npm exposes bins through symlinks):
      isMainEntry(real, selfUrl).should.be.true;
      isMainEntry(link, selfUrl).should.be.true;
      // Not this module, missing file, no argv[1] at all:
      isMainEntry(join(dir, 'other.mjs'), selfUrl).should.be.false;
      isMainEntry(join(dir, 'missing.mjs'), selfUrl).should.be.false;
      isMainEntry(undefined, selfUrl).should.be.false;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is false when this test file is imported (vitest is the entry)', () => {
    isMainEntry(process.argv[1], pathToFileURL(fileURLToPath(import.meta.url)).href).should.be.false;
  });
});

describe('stampGraphUrl (whole-graph reload stamping)', () => {
  it('stamps project modules only — never node_modules', () => {
    const root = pathToFileURL(`${resolve('proj')}/`).href;
    const stamped = stampGraphUrl(`${root}src/app.ts`, [root]);
    stamped!.should.contain('s200epoch=');
    // Already stamped: re-stamping would duplicate the query.
    (stampGraphUrl(stamped!, [root]) === undefined).should.be.true;
    // The watcher ignores node_modules, so the epoch must too — stamping
    // would re-evaluate and re-instantiate every dependency per reload.
    (stampGraphUrl(`${root}node_modules/dep/index.js`, [root]) === undefined).should.be.true;
    // Outside every watched root / not a file URL: untouched.
    (stampGraphUrl(`${root}src/app.ts`, []) === undefined).should.be.true;
    (stampGraphUrl('node:fs', [root]) === undefined).should.be.true;
  });
});

describe('supportsTypeStripping (TypeScript entry floor)', () => {
  it('tracks the unflagged floors (22.18 / 23.6) and the flag window (22.6+)', () => {
    supportsTypeStripping('v20.3.0').should.be.false;
    supportsTypeStripping('v22.5.0', ['--experimental-strip-types']).should.be.false;
    supportsTypeStripping('v22.6.0', ['--experimental-strip-types']).should.be.true;
    supportsTypeStripping('v22.17.0').should.be.false;
    supportsTypeStripping('v22.17.0', [], '--experimental-strip-types').should.be.true;
    supportsTypeStripping('v22.18.0').should.be.true;
    supportsTypeStripping('v23.5.0').should.be.false;
    supportsTypeStripping('v23.6.0').should.be.true;
    supportsTypeStripping('v26.10.0').should.be.true;
    // Unparseable/future versions pass — Node's own error is clearer.
    supportsTypeStripping('nightly').should.be.true;
  });

  it('rejects a .ts entry on Nodes without type stripping, remedy included', async () => {
    const described = Object.getOwnPropertyDescriptor(process, 'version');
    Object.defineProperty(process, 'version', { value: 'v20.3.0', configurable: true });
    try {
      const error = (await rejectionOf(runDev(['/tmp/nope/app.ts']))) as Error;
      (error?.message ?? '').should.contain("can't import .ts");
      (error?.message ?? '').should.contain('22.18');
    } finally {
      Object.defineProperty(process, 'version', {
        value: described?.value,
        configurable: true,
      });
    }
  });

  it('lets a missing .ts entry fail on module resolution instead of the floor', async () => {
    const error = (await rejectionOf(runDev(['/tmp/definitely-missing/app.ts']))) as Error;
    (error?.message ?? '').should.not.contain("can't import .ts");
  });
});

