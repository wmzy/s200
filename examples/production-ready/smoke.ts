/**
 * Smoke test for production-ready — two layers:
 *
 *   1. In-process (s200/test `request`): routes, probe bodies, request-id
 *      correlation, and the readiness gate flipping 503 while tripped.
 *   2. Real process (`node app.ts` spawned, same workspace-src resolve
 *      hook preloaded via --import): a SIGTERM mid-request drains — the
 *      in-flight /slow request completes with its body intact, the
 *      process exits 0, and both onShutdown hooks log their cleanup to
 *      stderr in registration order. A second child boots with a bad
 *      config and must die with the aggregated issue list.
 *
 * Run: node smoke.ts — exits 0 when every check passes.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import '../ts-resolve.mjs';

// Config is validated at app.ts import time — set the env it reads first.
process.env.TITLE = 'ops-demo';

const here = dirname(fileURLToPath(import.meta.url));

const { app, gate } = await import('./app.ts');
const { request } = await import('s200/test');

let failures = 0;
const check = (name: string, ok: boolean, detail?: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${detail ?? ''}`}`);
  if (!ok) failures += 1;
};

// ---- Layer 1: in-process dispatch (s200/test request) ----

const home = await request(app, '/');
const homeBody = (await home.json()) as { title?: string; requestId?: string };
check('GET / → 200', home.status === 200);
check('GET / carries the configured title', homeBody.title === 'ops-demo');
check(
  'request id generated and echoed',
  typeof homeBody.requestId === 'string' && homeBody.requestId !== ''
);
check(
  'response stamped with the same x-request-id',
  home.headers.get('x-request-id') !== null && home.headers.get('x-request-id') === homeBody.requestId
);

const traced = await request(app, '/', { headers: { 'x-request-id': 'fixed-42' } });
const tracedBody = (await traced.json()) as { requestId?: string };
check(
  'incoming x-request-id honored end to end',
  traced.headers.get('x-request-id') === 'fixed-42' && tracedBody.requestId === 'fixed-42'
);

const live = await request(app, '/healthz');
check(
  'GET /healthz → 200 {"status":"ok"}',
  live.status === 200 && ((await live.json()) as { status?: string }).status === 'ok'
);

const ready = await request(app, '/readyz');
const readyBody = (await ready.json()) as { status?: string; checks?: Record<string, string> };
check(
  'GET /readyz → 200 while the gate is open',
  ready.status === 200 && readyBody.status === 'ok' && readyBody.checks?.['drain'] === 'ok'
);

// The drain's FIRST step flips this gate — probes answer 503 before any
// socket closes. Tripped deterministically here: over TCP after a real
// SIGTERM the listener is already gone, which is exactly why the gate
// flips first.
gate.close('draining');
const draining = await request(app, '/readyz');
const drainingBody = (await draining.json()) as { status?: string; checks?: Record<string, string> };
check(
  'GET /readyz → 503 while the gate is tripped',
  draining.status === 503 &&
    drainingBody.status === 'fail' &&
    drainingBody.checks?.['drain'] === 'draining'
);
gate.open();
check('gate.open() restores readiness', (await request(app, '/readyz')).status === 200);

// ---- Layer 2: the real process, driven over TCP ----

/** Resolves a currently-free TCP port (bind 0, read it, release). */
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => {
        resolve(typeof address === 'object' && address !== null ? address.port : 0);
      });
    });
  });

type ChildRun = {
  readonly child: ChildProcess;
  readonly exit: Promise<number | null>;
  stdout(): string;
  stderr(): string;
};

// No orphans: if this smoke dies mid-scenario, take the children down.
const children = new Set<ChildProcess>();
process.on('exit', () => {
  for (const child of children) {
    child.kill('SIGKILL');
  }
});

/** Spawns `node app.ts` (workspace src/ via the same resolve hook,
 * preloaded with --import) under the given env overrides. */
const runApp = (env: Record<string, string>): ChildRun => {
  const child = spawn(process.execPath, ['--import', '../ts-resolve.mjs', 'app.ts'], {
    cwd: here,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.once('close', () => {
    children.delete(child);
  });
  let out = '';
  let err = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    out += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    err += chunk;
  });
  return {
    child,
    exit: new Promise((resolve) => {
      child.once('close', (code) => resolve(code));
    }),
    stdout: () => out,
    stderr: () => err,
  };
};

/** Polls /healthz until it answers 200, or fails after `budgetMs`. */
const waitReady = async (base: string, budgetMs: number): Promise<void> => {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      if ((await fetch(`${base}/healthz`)).status === 200) {
        return;
      }
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      throw new Error(`server at ${base} not ready within ${String(budgetMs)}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const port = await freePort();
const base = `http://127.0.0.1:${String(port)}`;
const server = runApp({
  PORT: String(port),
  TITLE: 'drain-demo',
  SLOW_MS: '1500',
  SWEEP_MS: '150',
  DRAIN_MS: '8000',
});
await waitReady(base, 15_000);

const readyTcp = await fetch(`${base}/readyz`);
const readyTcpBody = (await readyTcp.json()) as { checks?: Record<string, string> };
check(
  'spawned server /readyz → 200 with drain: ok',
  readyTcp.status === 200 && readyTcpBody.checks?.['drain'] === 'ok'
);
check(
  'spawned server / serves its configured title',
  ((await (await fetch(`${base}/`)).json()) as { title?: string }).title === 'drain-demo'
);

// One request deliberately in flight when SIGTERM lands: the drain must
// let it finish (its socket is busy, only idle ones are reaped).
const slow = fetch(`${base}/slow`);
await new Promise((resolve) => setTimeout(resolve, 150));
server.child.kill('SIGTERM');

const slowRes = await slow;
const slowBody = (await slowRes.json()) as { tookMs?: number };
check('in-flight /slow completed during the drain', slowRes.status === 200);
check(
  'slow response body intact (tookMs covers the configured delay)',
  typeof slowBody.tookMs === 'number' && slowBody.tookMs >= 1500
);

const code = await server.exit;
check('SIGTERM → exit code 0', code === 0, `exit ${String(code)}`);
check('logger wrote request lines', server.stdout().includes('GET /slow 200'));
const sweeps = server.stderr().match(/\[shutdown\] scheduler stopped after (\d+) sweeps/u);
check(
  'onShutdown stopped the scheduler (after ≥1 sweep)',
  sweeps !== null && Number(sweeps[1] ?? '0') >= 1
);
const stopAt = server.stderr().indexOf('[shutdown] scheduler stopped');
const clearAt = server.stderr().indexOf('[shutdown] lastSeen registry cleared');
check(
  'onShutdown hooks logged in registration order',
  stopAt !== -1 && clearAt !== -1 && stopAt < clearAt
);

// A bad config must die at boot with the FULL issue list, not the first.
const bad = runApp({ PORT: 'not-a-port', TITLE: '   ' });
const badCode = await bad.exit;
check('bad config dies at boot (non-zero exit)', (badCode ?? 1) !== 0, `exit ${String(badCode)}`);
check(
  'bad config reports every issue',
  bad.stderr().includes('config invalid') &&
    bad.stderr().includes('PORT') &&
    bad.stderr().includes('TITLE')
);

process.exit(failures === 0 ? 0 : 1);
