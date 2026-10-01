import type { ShardSpec } from '../src/shard';
import type { Supervisor } from '../src/executor';


import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';

import { afterAll, afterEach, describe, it } from 'vitest';

import { createApp } from '../src/app';
import { runShards } from '../src/executor';

// Real network, real worker threads/processes: the entry modules the child
// realms import must be plain .mjs (loaded by raw node, not vitest), so
// they live in a tmpdir and import the library by absolute source URL —
// the resolve-hook fallback inside the child realms makes the
// extensionless source layout load under plain node.
const dir = mkdtempSync(join(tmpdir(), 's200-executor-'));
const SRC_ROOT = new URL('../src/', import.meta.url).href;

function writeEntry(name: string): { entry: string; marker: string } {
  const entry = join(dir, name + '.mjs');
  const marker = join(dir, name + '.marker');
  const source = [
    "import { appendFileSync } from 'node:fs';",
    "import { createApp, get, post } from '" + SRC_ROOT + "app.ts';",
    "import { json } from '" + SRC_ROOT + "respond.ts';",
    "appendFileSync('" + marker + "', 'spawn\\n');",
    'const app = createApp();',
    "get(app, '/heavy/ping', (ctx) => json(ctx, { pong: true }));",
    "post(app, '/heavy/echo', async (ctx) => json(ctx, { body: await ctx.req.text() }));",
    "post(app, '/heavy/die', (ctx) => { process.exit(1); return json(ctx, { dying: true }); });",
    'export { app };',
  ].join('\n');
  writeFileSync(entry, source);
  return { entry, marker };
}

// How many times a child realm actually evaluated the entry — the honest
// lazy-spawn witness: 0 after start(), 1 after the first request.
function spawnCount(marker: string): number {
  if (!existsSync(marker)) {
    return 0;
  }
  return readFileSync(marker, 'utf8')
    .split('\n')
    .filter((line) => line !== '').length;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('poll timeout: ' + what);
    }
    await sleep(20);
  }
}

// Recovery races the restart backoff — poll-fetch until the shard answers.
async function fetchOk(url: string, timeoutMs: number): Promise<Response> {
  const startedAt = Date.now();
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.status === 200) {
        return res;
      }
    } catch {
      // not up yet — keep polling
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('fetch timeout: ' + url);
    }
    await sleep(30);
  }
}

function portClosed(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.on('error', () => resolve(true));
    socket.on('connect', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

const heavySpec: ShardSpec = {
  id: 'heavy',
  prefix: '/heavy',
  routes: [
    { method: 'GET', pattern: '/heavy/ping', params: [], middlewareCount: 0 },
    { method: 'POST', pattern: '/heavy/echo', params: [], middlewareCount: 0 },
  ],
  policy: {},
};

const randomPort = (): number => 32000 + Math.floor(Math.random() * 10000);

const active: Supervisor[] = [];
afterEach(async () => {
  for (const supervisor of active.splice(0)) {
    await supervisor.stop();
  }
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('executor: thread shards', () => {
  it(
    'spawns lazily: port bound with no worker, first request spawns and serves, stop closes the port',
    { timeout: 20000 },
    async () => {
      const { entry, marker } = writeEntry('thread-lazy');
      const port = randomPort();
      const supervisor = runShards([{ spec: heavySpec, executor: { kind: 'thread', entry }, port }]);
      active.push(supervisor);

      await supervisor.start();
      const before = supervisor.units()[0]!;
      before.state.should.equal('spawning');
      (before.port === port).should.equal(true);
      before.restarts.should.equal(0);
      // No worker exists yet — the entry has never been evaluated.
      spawnCount(marker).should.equal(0);

      // First request: TCP connect queues the paused socket, spawns the
      // worker, and the response still arrives — via server+socket
      // transfer (node ≥ 26) or a byte relay to the worker's private
      // port (older runtimes, same lazy contract).
      const first = await fetch('http://127.0.0.1:' + port + '/heavy/ping');
      first.status.should.equal(200);
      (await first.json()).should.deep.equal({ pong: true });
      spawnCount(marker).should.equal(1);
      await until(() => supervisor.units()[0]!.state === 'ready', 5000, 'unit becomes ready');

      // Subsequent requests reuse the keep-alive connection the worker
      // now owns (transferred or relayed — never re-parsed by us).
      const echo = await fetch('http://127.0.0.1:' + port + '/heavy/echo', {
        method: 'POST',
        body: 'hello shard',
      });
      echo.status.should.equal(200);
      (await echo.json()).should.deep.equal({ body: 'hello shard' });
      // Exactly one worker for all of the above traffic.
      spawnCount(marker).should.equal(1);

      await supervisor.stop();
      supervisor.units()[0]!.state.should.equal('stopped');
      (await portClosed(port)).should.equal(true);
    }
  );

  it(
    'restarts after an unexpected worker exit and serves the next request',
    { timeout: 20000 },
    async () => {
      const { entry, marker } = writeEntry('thread-restart');
      const port = randomPort();
      const supervisor = runShards([{ spec: heavySpec, executor: { kind: 'thread', entry }, port }]);
      active.push(supervisor);

      await supervisor.start();
      const ping = 'http://127.0.0.1:' + port + '/heavy/ping';
      (await (await fetchOk(ping, 8000)).json()).should.deep.equal({ pong: true });
      spawnCount(marker).should.equal(1);

      // The worker exits mid-request (POST is never retried by the client).
      let crashed = false;
      try {
        await fetch('http://127.0.0.1:' + port + '/heavy/die', { method: 'POST' });
      } catch {
        crashed = true;
      }
      crashed.should.equal(true);
      await until(() => supervisor.units()[0]!.restarts === 1, 8000, 'restart counted');

      // Backoff (100ms first) elapses, the port keeps answering, the next
      // request spawns a fresh worker and gets served.
      const recovered = await fetchOk(ping, 8000);
      (await recovered.json()).should.deep.equal({ pong: true });
      spawnCount(marker).should.be.greaterThan(1);
      await until(() => supervisor.units()[0]!.state === 'ready', 8000, 'unit ready again');

      await supervisor.stop();
      supervisor.units()[0]!.state.should.equal('stopped');
    }
  );

  it('surfaces a broken entry as a failed unit with the boot error, and stops cleanly', { timeout: 20000 }, async () => {
    const broken = join(dir, 'thread-broken.mjs');
    writeFileSync(broken, "throw new Error('entry exploded');\n");
    const port = randomPort();
    const supervisor = runShards([
      { spec: heavySpec, executor: { kind: 'thread', entry: 'file://' + broken }, port },
    ]);
    active.push(supervisor);

    await supervisor.start();
    // Lazy units only boot on traffic: one request parks a socket, the
    // worker spawns, the entry throws during import, the parked socket is
    // destroyed (client sees ECONNRESET), the exit is counted.
    let rejected = false;
    try {
      await fetch('http://127.0.0.1:' + port + '/heavy/ping');
    } catch {
      rejected = true;
    }
    rejected.should.equal(true);
    await until(() => supervisor.units()[0]!.restarts >= 1, 8000, 'restart counted');
    const failed = supervisor.units()[0]!;
    String(failed.lastError ?? '').includes('entry exploded').should.equal(true);
    (failed.state === 'failed' || failed.state === 'spawning').should.equal(true);

    await supervisor.stop();
    supervisor.units()[0]!.state.should.equal('stopped');
    (await portClosed(port)).should.equal(true);
  });
});

describe('executor: process shards', () => {
  it('forks the shim, serves over real HTTP, drains on stop', { timeout: 20000 }, async () => {
    const { entry, marker } = writeEntry('process-serve');
    const port = randomPort();
    const supervisor = runShards([{ spec: heavySpec, executor: { kind: 'process', entry }, port }]);
    active.push(supervisor);

    await supervisor.start();
    // start() awaits the fork's first 'ready' IPC message — the contract
    // mirrors the lazy thread path's pre-bound port: a returned supervisor
    // never refuses its first request.
    supervisor.units()[0]!.state.should.equal('ready');

    const ping = 'http://127.0.0.1:' + port + '/heavy/ping';
    const res = await fetchOk(ping, 10000);
    (await res.json()).should.deep.equal({ pong: true });
    spawnCount(marker).should.equal(1);
    await until(() => supervisor.units()[0]!.state === 'ready', 5000, 'process unit ready');

    const echo = await fetch('http://127.0.0.1:' + port + '/heavy/echo', {
      method: 'POST',
      body: 'from process',
    });
    (await echo.json()).should.deep.equal({ body: 'from process' });

    await supervisor.stop();
    supervisor.units()[0]!.state.should.equal('stopped');
    (await portClosed(port)).should.equal(true);
  });
});

describe('executor: passive units', () => {
  it('reports inline as ready-to-dispatch and external as foreign', async () => {
    const supervisor = runShards([
      { spec: { ...heavySpec, id: 'ui' }, executor: { kind: 'inline', app: createApp() } },
      {
        spec: { ...heavySpec, id: 'legacy' },
        executor: { kind: 'external', address: 'http://10.255.255.1:8080' },
      },
    ]);
    active.push(supervisor);

    await supervisor.start();
    const statuses = supervisor.units();
    statuses.map((status) => [status.id, status.state]).should.deep.equal([
      ['ui', 'ready'],
      ['legacy', 'external'],
    ]);
    statuses[1]!.restarts.should.equal(0);
    (statuses[1]!.port === undefined).should.equal(true);

    await supervisor.stop();
    supervisor.units()[0]!.state.should.equal('stopped');
    // External units are not ours — they keep reporting 'external'.
    supervisor.units()[1]!.state.should.equal('external');
  });
});
