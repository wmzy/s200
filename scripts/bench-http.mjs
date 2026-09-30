#!/usr/bin/env node
/**
 * End-to-end HTTP benchmark: s200 vs hono vs express on the same machine,
 * same client, same payloads. Measures whole-request throughput through
 * each framework's real server (not the router in isolation — see
 * bench-router.mjs for that).
 *
 *   pnpm bench:http
 *   CONCURRENCY=64 REQUESTS=50000 pnpm bench:http
 *   node scripts/bench-http.mjs --only mw   # measure one scenario
 *
 * Each framework runs in its OWN child process (this script re-execs
 * itself with BENCH_SERVER set): @hono/node-server's default patches the
 * global Request/Response, which would contaminate every other server in
 * the same process — separate processes keep each measurement clean.
 *
 * An extra variant, s200-deno, serves the same built core through
 * Deno.serve (core is plain Web Standard code): the script writes a tiny
 * entry file to the OS tmpdir and spawns `deno run` on it. It auto-skips
 * with one printed line when no deno binary is on PATH (never throws) —
 * see docs/benchmarks.md for how to enable it.
 *
 * Scenarios (all JSON, all keep-alive):
 *   hello        GET /            -> { "message": "hello" }
 *   param        GET /users/:id   -> { "id": "42", "name": "ada" }
 *   mw           GET /mw          -> { "message": "hello" } through a
 *                 5-deep middleware chain (see the mw builders below):
 *                 each link reads the `x-test` request header and sets its
 *                 own response header at unwind; one link also stores a
 *                 performance.now() delta into the per-request context.
 *                 The chain is scoped to /mw so hello/param keep measuring
 *                 the middleware-free floor.
 *
 * Methodology caveats (read docs/benchmarks.md before citing numbers):
 *   - single process per framework, one port, warmed up first
 *   - client is node:http with a keep-alive agent (identical for all)
 *   - results are this-machine snapshots, not a rigorous benchmark suite
 *     (TechEmpower-style contention/isolation is out of scope)
 */
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { execSync, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CONCURRENCY = Number(process.env.CONCURRENCY ?? 32);
const REQUESTS = Number(process.env.REQUESTS ?? 30_000);

// One row = one scenario: a path benched against every variant's server.
const SCENARIOS = [
  { name: 'hello', path: '/' },
  { name: 'param', path: '/users/42' },
  { name: 'mw', path: '/mw' },
];

// `--only <scenario>` narrows the run to one scenario (default: all). The
// parent re-execs children with the same flag so both modes stay in sync.
const onlyIndex = process.argv.indexOf('--only');
const only = onlyIndex === -1 ? undefined : process.argv[onlyIndex + 1];
if (only !== undefined && !SCENARIOS.some((s) => s.name === only)) {
  console.error(
    `unknown scenario '${only}' (known: ${SCENARIOS.map((s) => s.name).join(', ')})`,
  );
  process.exit(1);
}
const scenarios =
  only === undefined ? SCENARIOS : SCENARIOS.filter((s) => s.name === only);

const VARIANTS = ['s200', 's200-light', 'hono', 'hono-patched', 'express', 'fastify', 'elysia'];
// s200-deno is probed at scenario definition and only in parent mode (the
// child re-execs below carry BENCH_SERVER, so they dispatch on that instead
// of this list): one skip line, never an error.
if (process.env.BENCH_SERVER === undefined) {
  try {
    execSync('deno --version', { stdio: 'ignore' });
    VARIANTS.push('s200-deno');
  } catch {
    console.log('s200-deno  skipped (deno not installed — install deno >= 2.x to enable, see docs/benchmarks.md)');
  }
}

// ── client ─────────────────────────────────────────────────────────────────

function bench(url, path) {
  return new Promise((resolve, reject) => {
    const agent = new http.Agent({
      keepAlive: true,
      maxSockets: CONCURRENCY,
    });
    let sent = 0;
    let done = 0;
    let failed = 0;
    let inflight = 0;
    const t0 = performance.now();

    const fire = () => {
      while (inflight < CONCURRENCY && sent < REQUESTS) {
        sent += 1;
        inflight += 1;
        const req = http.get(`${url}${path}`, { agent }, (res) => {
          // Drain the body; a stalled response would skew throughput.
          res.resume();
          res.once('end', () => {
            if (res.statusCode !== 200) {
              failed += 1;
            }
            inflight -= 1;
            done += 1;
            if (done === REQUESTS) {
              const rps = Math.round((REQUESTS * 1000) / (performance.now() - t0));
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

// ── servers ────────────────────────────────────────────────────────────────

async function buildS200({ light }) {
  const { createApp, get, json, use } = await import('../dist/index.mjs');
  const { serve } = await import('../dist/node.mjs');
  const app = createApp();
  get(app, '/', (ctx) => json(ctx, { message: 'hello' }));
  get(app, '/users/:id', (ctx) => json(ctx, { id: ctx.params.id, name: 'ada' }));
  // mw scenario: five middlewares, each reading `x-test` on the way in and
  // setting its own response header after next() resolves (true unwind —
  // ctx.res exists per the chain contract). The third also stores a
  // performance.now() delta into ctx.state, the per-request state bag.
  // Prefix-scoped so / and /users/:id keep the middleware-free floor.
  const mwLink = (i) => (ctx, next) => {
    ctx.req.headers.get('x-test');
    return next().then(() => {
      ctx.res.headers.set(`x-mw-${i}`, String(i));
    });
  };
  use(
    app,
    '/mw',
    mwLink(1),
    mwLink(2),
    (ctx, next) => {
      ctx.req.headers.get('x-test');
      const t0 = performance.now();
      return next().then(() => {
        ctx.state.elapsed = performance.now() - t0;
        ctx.res.headers.set('x-mw-3', '3');
      });
    },
    mwLink(4),
    mwLink(5)
  );
  get(app, '/mw', (ctx) => json(ctx, { message: 'hello' }));
  return serve(app, { port: 0, host: '127.0.0.1', ...(light ? { light: true } : {}) });
}

async function buildHono({ patched }) {
  const { Hono } = await import('hono');
  const { serve } = await import('@hono/node-server');
  const app = new Hono();
  app.get('/', (c) => c.json({ message: 'hello' }));
  app.get('/users/:id', (c) => c.json({ id: c.req.param('id'), name: 'ada' }));
  // mw scenario: app.use chains, path-scoped to /mw so the other routes keep
  // the middleware-free floor. Each link reads `x-test`, awaits next(), then
  // writes its response header (true unwind); the third also stores a
  // performance.now() delta via c.set (hono's per-request context store).
  const mwLink = (i) =>
    app.use('/mw/*', async (c, next) => {
      c.req.header('x-test');
      await next();
      c.header(`x-mw-${i}`, String(i));
    });
  mwLink(1);
  mwLink(2);
  app.use('/mw/*', async (c, next) => {
    c.req.header('x-test');
    const t0 = performance.now();
    await next();
    c.header('x-mw-3', '3');
    c.set('elapsed', performance.now() - t0);
  });
  mwLink(4);
  mwLink(5);
  app.get('/mw', (c) => c.json({ message: 'hello' }));
  return serve({
    fetch: app.fetch,
    port: 0,
    hostname: '127.0.0.1',
    // patched = @hono/node-server's default: minimal global Request/Response.
    overrideGlobalObjects: patched,
  });
}

async function buildExpress() {
  const { default: express } = await import('express');
  const app = express();
  app.get('/', (_req, res) => res.json({ message: 'hello' }));
  app.get('/users/:id', (req, res) => res.json({ id: req.params.id, name: 'ada' }));
  // mw scenario: app.use chains mounted at /mw (path-scoped, so / and
  // /users/:id keep the middleware-free floor). Each link reads `x-test` and
  // sets its response header — express defers header serialization to unwind,
  // so setHeader here rides the same flush the handler's res.json triggers.
  // The third stores the performance.now() delta after next() returns
  // (express descends the rest of the chain synchronously, so that is the
  // unwind side of the handler).
  const mwLink = (i) => (req, res, next) => {
    req.headers['x-test'];
    res.setHeader(`x-mw-${i}`, String(i));
    next();
  };
  app.use('/mw', mwLink(1), mwLink(2));
  app.use('/mw', (req, res, next) => {
    req.headers['x-test'];
    const t0 = performance.now();
    res.setHeader('x-mw-3', '3');
    next();
    req.elapsed = performance.now() - t0;
  });
  app.use('/mw', mwLink(4), mwLink(5));
  app.get('/mw', (_req, res) => res.json({ message: 'hello' }));
  return app.listen(0, '127.0.0.1');
}

async function buildFastify() {
  const { fastify } = await import('fastify');
  const app = fastify();
  app.get('/', async () => ({ message: 'hello' }));
  app.get('/users/:id', async (req) => ({ id: req.params.id, name: 'ada' }));
  // mw scenario: fastify's middleware equivalent is lifecycle hooks. They
  // live in an encapsulated register scope so only /mw's route pays them —
  // fastify hooks are per-plugin, unlike app-level middleware elsewhere.
  // Each async onRequest hook reads `x-test` and writes reply.header(...)
  // (applied at onSend serialization = unwind-equivalent); the third stores
  // a performance.now() delta on the request context.
  await app.register(async (instance) => {
    for (let i = 1; i <= 5; i++) {
      if (i === 3) {
        instance.addHook('onRequest', async (request, reply) => {
          const t0 = performance.now();
          request.headers['x-test'];
          reply.header('x-mw-3', '3');
          request.elapsed = performance.now() - t0;
        });
      } else {
        instance.addHook('onRequest', async (request, reply) => {
          request.headers['x-test'];
          reply.header(`x-mw-${i}`, String(i));
        });
      }
    }
    instance.get('/mw', async () => ({ message: 'hello' }));
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  return app.server;
}

async function buildElysia() {
  const { Elysia } = await import('elysia');
  const { node } = await import('@elysiajs/node');
  // elysia is Bun-first; this runs it on node via @elysiajs/node (srvx),
  // same process isolation as every other variant. Port 0 reports late in
  // this adapter, so claim a free port first.
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const app = new Elysia({ adapter: node() })
    .get('/', () => ({ message: 'hello' }))
    .get('/users/:id', ({ params }) => ({ id: params.id, name: 'ada' }));
  // mw scenario: elysia's onRequest hooks cannot be scoped — they fire for
  // the whole instance no matter where they register (verified), which would
  // contaminate the hello/param floor. The scoped equivalent is
  // guard({ beforeHandle }): a five-link lifecycle chain applying only to the
  // routes declared inside it. Each link reads `x-test` and writes
  // set.headers[...], applied when the response is serialized
  // (unwind-equivalent); the third stores a performance.now() delta on the
  // request context.
  const mwLinks = {
    beforeHandle: [1, 2, 3, 4, 5].map((i) =>
      i === 3
        ? (ctx) => {
            const t0 = performance.now();
            ctx.request.headers.get('x-test');
            ctx.set.headers['x-mw-3'] = '3';
            ctx.elapsed = performance.now() - t0;
          }
        : (ctx) => {
            ctx.request.headers.get('x-test');
            ctx.set.headers[`x-mw-${i}`] = String(i);
          }
    ),
  };
  app.guard(mwLinks, (scoped) => scoped.get('/mw', () => ({ message: 'hello' })));
  const info = await new Promise((resolve) => {
    node().listen(app)({ port, hostname: '127.0.0.1' }, resolve);
  });
  const server = info.node?.server;
  if (server !== undefined && !server.listening) {
    await once(server, 'listening');
  }
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        if (server !== undefined) {
          server.close(() => resolve());
        } else {
          resolve();
        }
      }),
  };
}

async function buildS200Deno() {
  // The core is runtime-agnostic Web Standard code: the exact bundle the
  // node scenarios import (dist/index.mjs) also runs under Deno.serve.
  // Deno needs a real entry file, so write a tiny one to the tmpdir that
  // imports the built core by file URL and serves the same two handlers;
  // the child re-execs this script per variant, and this scenario adds a
  // deno grandchild so its runtime never touches the others' processes.
  const distUrl = new URL('../dist/index.mjs', import.meta.url).href;
  const dir = mkdtempSync(join(tmpdir(), 's200-deno-bench-'));
  const entry = join(dir, 'serve.mjs');
  writeFileSync(
    entry,
    `// Generated by scripts/bench-http.mjs (s200-deno scenario) — safe to delete.
import { createApp, get, json, use, handle } from ${JSON.stringify(distUrl)};

const app = createApp();
get(app, '/', (ctx) => json(ctx, { message: 'hello' }));
get(app, '/users/:id', (ctx) => json(ctx, { id: ctx.params.id, name: 'ada' }));
// Same mw chain as the node s200 scenario (scoped to /mw).
const mwLink = (i) => (ctx, next) => {
  ctx.req.headers.get('x-test');
  return next().then(() => {
    ctx.res.headers.set('x-mw-' + i, String(i));
  });
};
use(
  app,
  '/mw',
  mwLink(1),
  mwLink(2),
  (ctx, next) => {
    ctx.req.headers.get('x-test');
    const t0 = performance.now();
    return next().then(() => {
      ctx.state.elapsed = performance.now() - t0;
      ctx.res.headers.set('x-mw-3', '3');
    });
  },
  mwLink(4),
  mwLink(5)
);
get(app, '/mw', (ctx) => json(ctx, { message: 'hello' }));

const server = Deno.serve(
  { port: 0, hostname: '127.0.0.1', onListen: ({ port }) => console.log(port) },
  (request) => handle(app, request),
);
await server.finished;
`,
  );
  const child = spawn('deno', ['run', '--allow-net', entry], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  child.on('exit', cleanup);
  // The entry prints its bound port as the first stdout line once listening.
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`s200-deno: no port from deno within 30s\n${stderr}`)),
      30_000,
    );
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.stdout.setEncoding('utf8');
    child.stdout.once('data', (chunk) => {
      clearTimeout(timer);
      resolve(chunk.trim().split('\n').at(-1));
    });
  });
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        if (exited) {
          cleanup();
          return resolve();
        }
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      }),
  };
}

async function runServer(variant) {
  let server;
  switch (variant) {
    case 's200':
    case 's200-light':
      server = await buildS200({ light: variant === 's200-light' });
      break;
    case 'hono':
    case 'hono-patched':
      server = await buildHono({ patched: variant === 'hono-patched' });
      break;
    case 'express':
      server = await buildExpress();
      break;
    case 'fastify':
      server = await buildFastify();
      break;
    case 'elysia':
      // buildElysia already returns the { url, close } wrapper (it owns
      // its port discovery); skip the generic listen branch below.
      return await buildElysia();
    case 's200-deno':
      // Same: buildS200Deno owns the deno child process and tmp entry.
      return await buildS200Deno();
    default:
      throw new Error(`Unknown variant ${variant}`);
  }
  if (variant === 's200' || variant === 's200-light') {
    // s200's serve() returns a { server, url, close } wrapper (it force-
    // closes idle keep-alive sockets on close, unlike a bare Server.close).
    return { url: server.url, close: () => server.close() };
  }
  if (!server.listening) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
  }
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

// ── child mode: run one variant and print its row ──────────────────────────

if (process.env.BENCH_SERVER !== undefined) {
  const variant = process.env.BENCH_SERVER;
  const server = await runServer(variant);
  // Warm every scenario's route first (JIT + connection pool), then measure
  // them one by one so each row is a steady-state read of its own path.
  for (const s of scenarios) {
    await bench(server.url, s.path);
  }
  const row = { variant };
  let failed = 0;
  for (const s of scenarios) {
    const result = await bench(server.url, s.path);
    row[s.name] = result.rps;
    failed += result.failed;
  }
  row.failed = failed;
  console.log(JSON.stringify(row));
  await server.close();
  process.exit(0);
}

// ── parent mode: re-exec per variant, collect and print ────────────────────

const self = process.argv[1];
const rows = [];
for (const variant of VARIANTS) {
  const args = only === undefined ? [] : ['--only', only];
  const out = execFileSync(process.execPath, [self, ...args], {
    env: { ...process.env, BENCH_SERVER: variant },
    encoding: 'utf8',
  });
  rows.push(JSON.parse(out.trim().split('\n').pop()));
}

console.log(
  `node ${process.version} | concurrency=${CONCURRENCY} requests=${REQUESTS}/scenario${
    only === undefined ? '' : ` | only=${only}`
  }\n`,
);
const width = Math.max(...VARIANTS.map((v) => v.length));
for (const row of rows) {
  const name = row.variant.padEnd(width);
  const cells = scenarios
    .map((s) => `${s.name}  ${String(row[s.name]).padStart(7)} req/s`)
    .join('   ');
  const warn = row.failed > 0 ? `   (${row.failed} non-200!)` : '';
  console.log(`${name}  ${cells}${warn}`);
}
