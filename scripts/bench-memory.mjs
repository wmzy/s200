#!/usr/bin/env node
/**
 * Memory & startup benchmark: s200 vs hono vs express vs fastify vs elysia,
 * on the axes the throughput bench (bench-http.mjs) never covered:
 *
 *   A. cold start — spawn a fresh child → poll GET / until the first 200.
 *      ms, median of COLD_RUNS children. Deliberately includes node boot +
 *      module loading + listen: that is what "time to first response" means
 *      for a freshly started process.
 *   B. steady-state RSS — same entry, driven through WARMUP keep-alive
 *      requests, then VmRSS read straight from /proc/<pid>/status (linux
 *      only — other platforms get an honest N/A row; /proc is the point:
 *      RSS as the kernel accounts it, no IPC round-trip).
 *   C. heap bytes per route — a child with --expose-gc builds the app,
 *      GCs twice, records heapUsed, registers N routes shaped /res<i>/:id,
 *      GCs twice again, reports (heapUsed delta)/N. Registration only,
 *      zero requests served.
 *
 *   node scripts/bench-memory.mjs
 *   ROUTES=1000 COLD_RUNS=9 node scripts/bench-memory.mjs
 *
 * Every measurement runs in its own generated child process (the same
 * isolation rule as bench-http: no framework shares a process with
 * another). The generated entry files live in a temp dir INSIDE the repo
 * so their bare imports ('hono', 'express', …) resolve against the repo's
 * node_modules. s200 children import the built core (dist/) — run
 * `pnpm build` first; this script checks for dist and exits with a hint
 * instead of building itself.
 *
 * Methodology caveats (docs/benchmarks.md carries the full list):
 *   - cold start includes module loading by design, plus ~2 ms of polling
 *     granularity from the readiness probe
 *   - heapUsed deltas are post-GC retained bytes, registration only: any
 *     work a framework defers past registration (route compilation at
 *     listen, schema finalization, first-request JIT) is outside this
 *     number
 *   - RSS is read once after the warmup drains; expect ± a few hundred kB
 *     of GC noise run to run. Snapshots, not guarantees.
 */
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distCoreUrl = new URL('../dist/index.mjs', import.meta.url).href;
const distNodeUrl = new URL('../dist/node.mjs', import.meta.url).href;
if (!existsSync(fileURLToPath(distCoreUrl)) || !existsSync(fileURLToPath(distNodeUrl))) {
  console.error(
    'dist/index.mjs / dist/node.mjs not found — run `pnpm build` first: ' +
      'this bench measures the built core, same rule as bench-http.mjs',
  );
  process.exit(1);
}

const FRAMEWORKS = ['s200', 'hono', 'express', 'fastify', 'elysia'];
const COLD_RUNS = Number(process.env.COLD_RUNS ?? 7);
const RSS_RUNS = Number(process.env.RSS_RUNS ?? 3);
const PER_ROUTE_RUNS = Number(process.env.PER_ROUTE_RUNS ?? 3);
const ROUTES = Number(process.env.ROUTES ?? 500);
const WARMUP = Number(process.env.WARMUP ?? 5000);
const WARMUP_CONCURRENCY = 8;

// ── generated entry files ──────────────────────────────────────────────────
//
// One entry per (framework, kind): kind 'serve' is the two-route listening
// app used by scenarios A and B (port passed via BENCH_PORT); kind 'routes'
// is the N-route registration-only app used by scenario C (no listen, no
// requests — the child GCs around the registration loop and prints a JSON
// row).

function serveEntry(framework) {
  const portLine = 'Number(process.env.BENCH_PORT)';
  switch (framework) {
    case 's200':
      return `import { createApp, get, json } from ${JSON.stringify(distCoreUrl)};
import { serve } from ${JSON.stringify(distNodeUrl)};

const app = createApp();
get(app, '/', (ctx) => json(ctx, { message: 'hello' }));
get(app, '/users/:id', (ctx) => json(ctx, { id: ctx.params.id, name: 'ada' }));
serve(app, { port: ${portLine}, host: '127.0.0.1' });
`;
    case 'hono':
      // overrideGlobalObjects: false = real Request/Response, matching the
      // 'hono' variant of bench-http.mjs (the patched default is its own row
      // there and a throughput concern, not a memory one).
      return `import { Hono } from 'hono';
import { serve } from '@hono/node-server';

const app = new Hono();
app.get('/', (c) => c.json({ message: 'hello' }));
app.get('/users/:id', (c) => c.json({ id: c.req.param('id'), name: 'ada' }));
serve({ fetch: app.fetch, port: ${portLine}, hostname: '127.0.0.1', overrideGlobalObjects: false });
`;
    case 'express':
      return `import express from 'express';

const app = express();
app.get('/', (_req, res) => res.json({ message: 'hello' }));
app.get('/users/:id', (req, res) => res.json({ id: req.params.id, name: 'ada' }));
app.listen(${portLine}, '127.0.0.1');
`;
    case 'fastify':
      return `import { fastify } from 'fastify';

const app = fastify();
app.get('/', async () => ({ message: 'hello' }));
app.get('/users/:id', async (req) => ({ id: req.params.id, name: 'ada' }));
await app.listen({ port: ${portLine}, host: '127.0.0.1' });
`;
    case 'elysia':
      // elysia is Bun-first; on node it runs through @elysiajs/node (srvx),
      // exactly like the elysia variant of bench-http.mjs.
      return `import { Elysia } from 'elysia';
import { node } from '@elysiajs/node';

const app = new Elysia({ adapter: node() })
  .get('/', () => ({ message: 'hello' }))
  .get('/users/:id', ({ params }) => ({ id: params.id, name: 'ada' }));
node().listen(app)({ port: ${portLine}, hostname: '127.0.0.1' });
`;
    default:
      throw new Error(`unknown framework ${framework}`);
  }
}

function routesEntry(framework) {
  const head = '// Generated by scripts/bench-memory.mjs — safe to delete.\n';
  const gc = 'global.gc();\nglobal.gc();';
  const tail = `const N = Number(process.env.BENCH_ROUTES ?? 500);
%%APP%%
${gc}
const before = process.memoryUsage().heapUsed;
for (let i = 0; i < N; i++) {
  %%REGISTER%%
}
${gc}
const after = process.memoryUsage().heapUsed;
console.log(JSON.stringify({ bytesPerRoute: (after - before) / N }));
`;
  switch (framework) {
    case 's200':
      return head + tail.replace('%%APP%%', `import { createApp, get, json } from ${JSON.stringify(distCoreUrl)};

const app = createApp();`).replace(
        '%%REGISTER%%',
        "get(app, '/res' + i + '/:id', (ctx) => json(ctx, { id: ctx.params.id }));",
      );
    case 'hono':
      return head + tail.replace('%%APP%%', `import { Hono } from 'hono';

const app = new Hono();`).replace(
        '%%REGISTER%%',
        "app.get('/res' + i + '/:id', (c) => c.json({ id: c.req.param('id') }));",
      );
    case 'express':
      return head + tail.replace('%%APP%%', `import express from 'express';

const app = express();`).replace(
        '%%REGISTER%%',
        "app.get('/res' + i + '/:id', (req, res) => res.json({ id: req.params.id }));",
      );
    case 'fastify':
      return head + tail.replace('%%APP%%', `import { fastify } from 'fastify';

const app = fastify();`).replace(
        '%%REGISTER%%',
        "app.get('/res' + i + '/:id', async (req) => ({ id: req.params.id }));",
      );
    case 'elysia':
      // No adapter needed: scenario C never listens.
      return head + tail.replace('%%APP%%', `import { Elysia } from 'elysia';

let app = new Elysia();`).replace(
        '%%REGISTER%%',
        "app = app.get('/res' + i + '/:id', ({ params }) => ({ id: params.id }));",
      );
    default:
      throw new Error(`unknown framework ${framework}`);
  }
}

// ── child process plumbing ─────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Claim a free port up front so the parent can start polling it the moment
// the child spawns (cold start must not wait for the child to print
// anything). Same trick bench-http.mjs uses for elysia.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function childEnv(extra) {
  const env = { ...process.env, ...extra };
  // No loader hooks or preset flags leaking in: cold start must measure the
  // framework, not the parent's NODE_OPTIONS.
  delete env.NODE_OPTIONS;
  return env;
}

function spawnServeChild(entry, port) {
  const child = spawn(process.execPath, [entry], {
    env: childEnv({ BENCH_PORT: String(port) }),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  let dead = false;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.once('exit', () => {
    dead = true;
  });
  return {
    child,
    isDead: () => dead,
    exited,
    stderrOf: () => stderr,
  };
}

async function stopServeChild(proc) {
  const { child, exited } = proc;
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const timer = sleep(3000).then(() => child.kill('SIGKILL'));
  await Promise.race([exited, timer]);
}

// Poll GET / until the first 200; the caller passes the spawn-time t0 so the
// measured span covers process boot + module load + listen + first response.
async function pollFirst200(url, t0, label, proc) {
  for (;;) {
    if (proc.isDead()) {
      throw new Error(`${label}: child exited before serving\n${proc.stderrOf()}`);
    }
    try {
      const res = await fetch(url);
      await res.arrayBuffer();
      if (res.status === 200) return performance.now() - t0;
    } catch {
      // ECONNREFUSED until the listener is up — keep polling.
    }
    if (performance.now() - t0 > 30_000) {
      throw new Error(`${label}: no 200 within 30s\n${proc.stderrOf()}`);
    }
    await sleep(2);
  }
}

// Keep-alive load driver, same shape as bench-http.mjs's client.
function drive(url, path, requests, concurrency) {
  return new Promise((resolve, reject) => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency });
    let sent = 0;
    let done = 0;
    let failed = 0;
    let inflight = 0;
    const t0 = performance.now();
    const fire = () => {
      while (inflight < concurrency && sent < requests) {
        sent += 1;
        inflight += 1;
        const req = http.get(`${url}${path}`, { agent }, (res) => {
          res.resume();
          res.once('end', () => {
            if (res.statusCode !== 200) failed += 1;
            inflight -= 1;
            done += 1;
            if (done === requests) {
              const rps = Math.round((requests * 1000) / (performance.now() - t0));
              agent.destroy();
              resolve({ rps, failed });
            } else {
              fire();
            }
          });
        });
        req.once('error', (error) => {
          agent.destroy();
          reject(error);
        });
      }
    };
    fire();
  });
}

function readVmRssKb(pid) {
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
  if (match === null) throw new Error(`no VmRSS line in /proc/${pid}/status`);
  return Number(match[1]);
}

// ── scenarios ──────────────────────────────────────────────────────────────

async function coldStartMs(framework, entry) {
  const port = await freePort();
  const t0 = performance.now();
  const proc = spawnServeChild(entry, port);
  try {
    return await pollFirst200(`http://127.0.0.1:${port}/`, t0, framework, proc);
  } finally {
    // A failed boot/timeout must not leak the child or its bound port for
    // the scenarios that follow.
    await stopServeChild(proc);
  }
}

async function steadyRss(framework, entry) {
  const port = await freePort();
  const proc = spawnServeChild(entry, port);
  try {
    const url = `http://127.0.0.1:${port}`;
    // Readiness probe (not measured): wait for the first 200 before driving.
    await pollFirst200(`${url}/`, performance.now(), framework, proc);
    const { rps, failed } = await drive(url, '/', WARMUP, WARMUP_CONCURRENCY);
    if (failed > 0) throw new Error(`${framework}: ${failed}/${WARMUP} non-200 during warmup`);
    // Let the last responses quiesce (event-loop drain) before asking the
    // kernel what the process actually holds.
    await sleep(200);
    const rssKb = readVmRssKb(proc.child.pid);
    return { rssKb, rps };
  } finally {
    // Every exit path (warmup failure, timeout, RSS read) stops the child
    // so a failed scenario cannot leave a server and its port running.
    await stopServeChild(proc);
  }
}

async function heapPerRouteBytes(framework, entry) {
  const child = spawn(process.execPath, ['--expose-gc', entry], {
    env: childEnv({ BENCH_ROUTES: String(ROUTES) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    out += chunk;
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    err += chunk;
  });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  if (code !== 0) throw new Error(`${framework}: routes child exited ${code}\n${err}`);
  const row = JSON.parse(out.trim().split('\n').at(-1));
  return row.bytesPerRoute;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Run `fn` `runs` times, reducing to either a single value or the first
// error (a framework that cannot run a scenario here gets an honest N/A row
// with its reason, never a silently skewed number). `pick` reduces the
// collected values — `median` by default; multi-field results reduce each
// field separately so a median never has to sort objects.
async function measure(framework, axis, runs, fn, pick = median) {
  const values = [];
  for (let i = 0; i < runs; i++) {
    try {
      values.push(await fn());
    } catch (error) {
      return { error: `${framework} (${axis}): ${error.message.split('\n')[0]}` };
    }
  }
  return { value: pick(values) };
}

// ── parent mode ────────────────────────────────────────────────────────────

const tmpDir = mkdtempSync(join(repoRoot, '.bench-memory-'));
try {
  const entries = {};
  for (const framework of FRAMEWORKS) {
    const serve = join(tmpDir, `${framework}-serve.mjs`);
    const routes = join(tmpDir, `${framework}-routes.mjs`);
    writeFileSync(serve, serveEntry(framework));
    writeFileSync(routes, routesEntry(framework));
    entries[framework] = { serve, routes };
  }

  const results = {};
  for (const framework of FRAMEWORKS) {
    results[framework] = {
      cold: await measure(framework, 'cold', COLD_RUNS, () =>
        coldStartMs(framework, entries[framework].serve),
      ),
      rss:
        os.platform() === 'linux'
          ? await measure(
              framework,
              'rss',
              RSS_RUNS,
              () => steadyRss(framework, entries[framework].serve),
              (vals) => ({
                rssKb: median(vals.map((v) => v.rssKb)),
                rps: median(vals.map((v) => v.rps)),
              }),
            )
          : { error: 'scenario B needs /proc/<pid>/status — linux only, skipped' },
      perRoute: await measure(framework, 'per-route', PER_ROUTE_RUNS, () =>
        heapPerRouteBytes(framework, entries[framework].routes),
      ),
    };
  }

  const cpu = os.cpus()[0]?.model?.trim() ?? 'unknown cpu';
  const today = new Date().toISOString().slice(0, 10);
  const notes = [];
  const na = (framework, axis, result) => {
    notes.push(result.error);
    return 'N/A';
  };

  console.log(`# memory & startup — ${cpu} | ${os.platform()} ${os.release()} | node ${process.version} | ${today}`);
  console.log(
    `runs: cold ×${COLD_RUNS}, rss ×${RSS_RUNS}, per-route ×${PER_ROUTE_RUNS} (medians) | routes=${ROUTES} | warmup=${WARMUP} req @ concurrency ${WARMUP_CONCURRENCY}`,
  );
  console.log('entry: two routes (GET /, GET /users/:id), port from parent, fresh child per run\n');

  console.log('## A · cold start — ms from spawn to first 200 on GET /');
  console.log('includes node boot + module load + listen + first response\n');
  console.log('| framework | ms |');
  console.log('| --------- | --: |');
  for (const framework of FRAMEWORKS) {
    const r = results[framework].cold;
    console.log(`| ${framework} | ${r.error === undefined ? r.value.toFixed(1) : na(framework, 'cold', r)} |`);
  }

  console.log('\n## B · steady-state RSS — VmRSS after the warmup load');
  console.log('read from /proc/<pid>/status after the last response drains\n');
  console.log('| framework | RSS (MB) | warmup (req/s) |');
  console.log('| --------- | -------: | -------------: |');
  for (const framework of FRAMEWORKS) {
    const r = results[framework].rss;
    console.log(
      r.error === undefined
        ? `| ${framework} | ${(r.value.rssKb / 1024).toFixed(1)} | ${r.value.rps} |`
        : `| ${framework} | ${na(framework, 'rss', r)} | N/A |`,
    );
  }

  console.log(`\n## C · heap per route — B/route retained after registering ${ROUTES} routes`);
  console.log('--expose-gc child, heapUsed delta around the registration loop, no requests\n');
  console.log('| framework | B/route |');
  console.log('| --------- | ------: |');
  for (const framework of FRAMEWORKS) {
    const r = results[framework].perRoute;
    console.log(`| ${framework} | ${r.error === undefined ? r.value.toFixed(1) : na(framework, 'per-route', r)} |`);
  }

  if (notes.length > 0) {
    console.log('\nN/A reasons:');
    for (const note of notes) console.log(`- ${note}`);
  }
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
