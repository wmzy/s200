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

import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, it, vi } from 'vitest';

import { createApp, get } from '../src/app';
import { isMainEntry, main, parseDevArgs, runDev, supportsTypeStripping } from '../src/cli';
import { text } from '../src/respond';

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

/** Everything the stub watcher captured from the runner. */
type Capture = {
  dirs: readonly string[] | undefined;
  hot: { app: App; reload(next: App): void } | undefined;
  load: (() => Promise<App>) | undefined;
  closes: () => number;
};

let captured: Capture = { dirs: undefined, hot: undefined, load: undefined, closes: () => 0 };

const stubWatch = (options: WatchOptions): WatchAndReloadHandle => {
  // Per-handle counter: a later runDev must not rewire an older handle's
  // close accounting.
  const handle = { closes: 0 };
  captured = {
    dirs: options.dirs,
    hot: options.hot,
    load: options.load,
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

describe('parseDevArgs', () => {
  it('defaults entry to ./app.ts and leaves port unset', () => {
    parseDevArgs([]).should.deep.equal({ entry: './app.ts', port: undefined });
  });

  it('takes one entry plus --port in both spellings', () => {
    parseDevArgs(['./src/api.ts']).should.deep.equal({ entry: './src/api.ts', port: undefined });
    parseDevArgs(['./src/api.ts', '--port', '4123']).should.deep.equal({
      entry: './src/api.ts',
      port: 4123,
    });
    parseDevArgs(['--port=4123', './src/api.ts']).should.deep.equal({
      entry: './src/api.ts',
      port: 4123,
    });
  });

  it('rejects unknown options, bad ports, and extra positionals', async () => {
    ((await rejectionOf(Promise.resolve().then(() => parseDevArgs(['--watch'])))) as Error).message.should.contain(
      'unknown option'
    );
    ((await rejectionOf(Promise.resolve().then(() => parseDevArgs(['--port', 'nope'])))) as Error).message.should.contain(
      'invalid port'
    );
    ((await rejectionOf(Promise.resolve().then(() => parseDevArgs(['a.ts', 'b.ts'])))) as Error).message.should.contain(
      'unexpected argument'
    );
  });
});

describe('main', () => {
  it('rejects unknown commands and bad flags with usage', async () => {
    ((await rejectionOf(main(['build']))) as Error).message.should.contain('unknown command');
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

