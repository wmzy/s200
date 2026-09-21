#!/usr/bin/env node
/**
 * End-to-end HTTP benchmark: s200 vs hono vs express on the same machine,
 * same client, same payloads. Measures whole-request throughput through
 * each framework's real server (not the router in isolation — see
 * bench-router.mjs for that).
 *
 *   pnpm bench:http
 *   CONCURRENCY=64 REQUESTS=50000 pnpm bench:http
 *
 * Each framework runs in its OWN child process (this script re-execs
 * itself with BENCH_SERVER set): @hono/node-server's default patches the
 * global Request/Response, which would contaminate every other server in
 * the same process — separate processes keep each measurement clean.
 *
 * Scenarios (all JSON, all keep-alive):
 *   hello        GET /            -> { "message": "hello" }
 *   param        GET /users/:id   -> { "id": "42", "name": "ada" }
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
import { execFileSync } from 'node:child_process';

const CONCURRENCY = Number(process.env.CONCURRENCY ?? 32);
const REQUESTS = Number(process.env.REQUESTS ?? 30_000);

const VARIANTS = ['s200', 'hono', 'hono-patched', 'express', 'fastify', 'elysia'];

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

async function buildS200() {
  const { createApp, get, json } = await import('../dist/index.mjs');
  const { serve } = await import('../dist/node.mjs');
  const app = createApp();
  get(app, '/', (ctx) => json(ctx, { message: 'hello' }));
  get(app, '/users/:id', (ctx) => json(ctx, { id: ctx.params.id, name: 'ada' }));
  return serve(app, { port: 0, host: '127.0.0.1' });
}

async function buildHono({ patched }) {
  const { Hono } = await import('hono');
  const { serve } = await import('@hono/node-server');
  const app = new Hono();
  app.get('/', (c) => c.json({ message: 'hello' }));
  app.get('/users/:id', (c) => c.json({ id: c.req.param('id'), name: 'ada' }));
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
  return app.listen(0, '127.0.0.1');
}

async function buildFastify() {
  const { fastify } = await import('fastify');
  const app = fastify();
  app.get('/', async () => ({ message: 'hello' }));
  app.get('/users/:id', async (req) => ({ id: req.params.id, name: 'ada' }));
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

async function runServer(variant) {
  let server;
  switch (variant) {
    case 's200':
      server = await buildS200();
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
    default:
      throw new Error(`Unknown variant ${variant}`);
  }
  if (variant === 's200') {
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
  // Warm both routes (JIT + connection pool).
  await bench(server.url, '/');
  await bench(server.url, '/users/42');
  const hello = await bench(server.url, '/');
  const param = await bench(server.url, '/users/42');
  console.log(
    JSON.stringify({
      variant,
      hello: hello.rps,
      param: param.rps,
      failed: hello.failed + param.failed,
    }),
  );
  await server.close();
  process.exit(0);
}

// ── parent mode: re-exec per variant, collect and print ────────────────────

const self = process.argv[1];
const rows = [];
for (const variant of VARIANTS) {
  const out = execFileSync(process.execPath, [self], {
    env: { ...process.env, BENCH_SERVER: variant },
    encoding: 'utf8',
  });
  rows.push(JSON.parse(out.trim().split('\n').pop()));
}

console.log(
  `node ${process.version} | concurrency=${CONCURRENCY} requests=${REQUESTS}/scenario\n`,
);
const width = Math.max(...VARIANTS.map((v) => v.length));
for (const row of rows) {
  const name = row.variant.padEnd(width);
  const warn = row.failed > 0 ? `   (${row.failed} non-200!)` : '';
  console.log(
    `${name}  hello  ${String(row.hello).padStart(7)} req/s   param  ${String(row.param).padStart(7)} req/s${warn}`,
  );
}
