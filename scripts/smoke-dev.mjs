#!/usr/bin/env node
/**
 * `s200` CLI end-to-end smoke — exercises the built bin (dist/cli.mjs)
 * against a real project directory:
 *
 *   1. `s200 dev` serves the entry, prints the startup route table, and
 *      decorates default 404s with route hints (on by default),
 *   2. re-evaluates the WHOLE module graph on reload (editing a module
 *      the entry imports — not the entry itself — must reach the wire),
 *      and tells the overlay's SSE subscribers about it,
 *   3. `--overlay` injects the inline script into byte-backed text/html
 *      and serves /__s200/dev-events (off by default: no route, no script),
 *   4. ignores watch events for non-source files (writing a log inside
 *      the watched directory must not trigger a reload),
 *   5. `s200 routes` prints the aligned table, `s200 codegen` prints a
 *      client module, an unknown command exits non-zero listing commands,
 *   6. fails fast with the remedy when a .ts entry meets a Node without
 *      type stripping (floors asserted through the exported pure helper).
 *
 * Runs as a plain node child of the bin; exits 0 when every check passes.
 * Lives outside vitest on purpose: vitest's module runner intercepts
 * dynamic imports, which hides exactly the ESM-cache behavior under test.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { supportsTypeStripping } from '../dist/cli.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const BIN = join(ROOT, 'dist', 'cli.mjs');
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok' : 'FAIL'}  ${name}${ok || detail === '' ? '' : ` — ${detail}`}`);
  if (!ok) {
    failures.push(name);
  }
};

const dir = await mkdtemp(join(tmpdir(), 's200-smoke-dev-'));
const port = 32190 + (process.pid % 500);
const base = `http://127.0.0.1:${port}`;

const getJson = async (path) => {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json() };
};

// One-shot CLI invocation: collects output until the child exits (or the
// deadline kills it) — used by the routes/codegen/unknown-command checks.
const runOnce = async (args, timeoutMs = 15000) => {
  const child = spawn(process.execPath, [BIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => {
    out += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    err += chunk.toString();
  });
  const code = await new Promise((settled) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settled('timeout');
    }, timeoutMs);
    child.once('exit', (exitCode) => {
      clearTimeout(timer);
      settled(exitCode);
    });
  });
  return { code, out, err };
};

// The project: entry imports a dependency — the reload must reach it. The
// /v/x route gives a miss (/v/y) that overlaps it, so the default route
// hints have something honest to say; /page is byte-backed HTML for the
// overlay's script injection.
await writeFile(join(dir, 'dep.mjs'), 'export const v = "v1";\n');
await writeFile(
  join(dir, 'app.mjs'),
  `import { v } from './dep.mjs';\n` +
    `import { createApp, get, html } from ${JSON.stringify(join(ROOT, 'dist', 'index.mjs'))};\n` +
    `const app = createApp();\n` +
    `get(app, '/v', (ctx) => Response.json({ v }));\n` +
    `get(app, '/v/x', () => new Response('vx'));\n` +
    `get(app, '/page', (ctx) => html(ctx, '<html><body>page</body></html>'));\n` +
    `export default app;\n`
);
const entry = join(dir, 'app.mjs');

const child = spawn(
  process.execPath,
  [BIN, 'dev', entry, '--port', String(port), '--overlay'],
  { stdio: ['ignore', 'pipe', 'pipe'] }
);
let output = '';
let reloaded = 0;
child.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  output += text;
  reloaded += (text.match(/reloaded/g) ?? []).length;
});
child.stderr.on('data', (chunk) => {
  output += chunk.toString();
});
const waitFor = async (predicate, what, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
};

try {
  const listening = await waitFor(() => output.includes('listening'), 'server listening');
  check('dev server reports listening', listening, output);
  check(
    'startup prints the aligned route table',
    /GET {2}\/v\b/.test(output) && output.includes('/v/x') && output.includes('/page'),
    output
  );

  const first = await getJson('/v');
  check('serves the entry app', first.status === 200 && first.body.v === 'v1', JSON.stringify(first));

  // 1) Default route hints: a miss that overlaps the table says so.
  const miss = await getJson('/v/y');
  check(
    '404 route hints on by default',
    miss.status === 404 && miss.body.hint === 'did you mean GET /v?',
    JSON.stringify(miss)
  );

  // 2) Overlay: script injected into byte-backed HTML, SSE route live.
  const page = await fetch(`${base}/page`);
  const pageBody = await page.text();
  check(
    'overlay injects the script before </body>',
    pageBody.includes('/__s200/dev-events') &&
      pageBody.lastIndexOf('<script>') < pageBody.lastIndexOf('</body>'),
    pageBody
  );
  const events = await fetch(`${base}/__s200/dev-events`);
  const sseType = events.headers.get('content-type') ?? '';
  check(
    'overlay serves the SSE event route',
    events.status === 200 && sseType.includes('text/event-stream'),
    `status=${events.status} type=${sseType}`
  );
  const sseReader = events.body.getReader();
  const sseDecoder = new TextDecoder();
  let sseSeen = '';
  const sseUntil = async (what, timeoutMs = 6000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !sseSeen.includes(what)) {
      const { value, done } = await sseReader.read();
      sseSeen += sseDecoder.decode(value ?? new Uint8Array());
      if (done) {
        break;
      }
    }
    return sseSeen.includes(what);
  };
  check('SSE opens with a ready event', await sseUntil('event: ready'), sseSeen);

  // 3) Graph-wide reload: edit the DEPENDENCY, not the entry.
  await writeFile(join(dir, 'dep.mjs'), 'export const v = "v2";\n');
  await waitFor(() => reloaded >= 1, 'reload after dep edit');
  const second = await getJson('/v');
  check(
    'dependency edit reaches the wire (whole-graph reload)',
    second.status === 200 && second.body.v === 'v2',
    JSON.stringify(second)
  );
  check('SSE broadcast the reload', await sseUntil('event: reload'), sseSeen);
  await sseReader.cancel().catch(() => undefined);

  // 4) Non-source writes inside the watched directory must not reload.
  const reloadedBefore = reloaded;
  await writeFile(join(dir, 'dev.log'), `noise ${Date.now()}\n`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const third = await getJson('/v');
  check(
    'non-source write triggers no reload',
    third.body.v === 'v2' && reloaded === reloadedBefore,
    `v=${third.body.v} reloads=${reloaded - reloadedBefore}`
  );

  // 5) TypeScript floor: the exported helper agrees with the running Node
  //    (CI and local both run >= 22.18) and rejects Node 20.
  check(
    'strip-floor helper accepts this Node',
    supportsTypeStripping(process.version, process.execArgv) === true,
    `node=${process.version}`
  );
  check(
    'strip-floor helper rejects Node 20',
    supportsTypeStripping('v20.3.0') === false,
    'v20.3.0 should be unsupported'
  );
} finally {
  // A failed boot (the checks above throw or report FAIL after the child
  // is already gone) must not await an 'exit' that fired before this
  // listener existed — that hangs the CI job to its timeout.
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }
}

// --no-hints: the same miss stays the plain default 404 body.
{
  const noHintsPort = port + 1;
  const noHints = spawn(
    process.execPath,
    [BIN, 'dev', entry, '--port', String(noHintsPort), '--no-hints'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let noHintsOut = '';
  noHints.stdout.on('data', (chunk) => {
    noHintsOut += chunk.toString();
  });
  noHints.stderr.on('data', (chunk) => {
    noHintsOut += chunk.toString();
  });
  try {
    const up = await waitFor(
      () => noHintsOut.includes('listening'),
      'no-hints server listening',
      8000
    );
    let plain = false;
    if (up) {
      const res = await fetch(`http://127.0.0.1:${noHintsPort}/v/y`);
      plain = res.status === 404 && (await res.text()) === '{"error":"Not Found"}';
    }
    check('--no-hints leaves the default 404 untouched', plain, noHintsOut);
  } finally {
    // Same already-exited guard as the main child above.
    if (noHints.exitCode === null && noHints.signalCode === null) {
      noHints.kill('SIGTERM');
      await new Promise((resolve) => noHints.once('exit', resolve));
    }
  }
}

// One-shot subcommands.
const routes = await runOnce(['routes', entry]);
check(
  's200 routes prints the aligned table (user routes only)',
  routes.code === 0 && /GET {2}\/v\b/.test(routes.out) && routes.out.includes('/v/x') && !routes.out.includes('__s200'),
  routes.out || routes.err
);
const routesJson = await runOnce(['routes', entry, '--json']);
let parsedOk;
try {
  const table = JSON.parse(routesJson.out);
  parsedOk = Array.isArray(table.routes) && table.routes.length === 3;
} catch {
  parsedOk = false;
}
check('s200 routes --json prints the serializable table', routesJson.code === 0 && parsedOk, routesJson.out || routesJson.err);

const codegen = await runOnce(['codegen', entry, '--name', 'makeApi']);
check(
  's200 codegen prints the client module',
  codegen.code === 0 && codegen.out.includes('makeApi') && codegen.out.includes('getVX'),
  codegen.out || codegen.err
);

const unknown = await runOnce(['frobnicate']);
check(
  'unknown command exits non-zero listing every command',
  unknown.code !== 0 && unknown.err.includes('unknown command') && unknown.err.includes('dev, routes, codegen'),
  `code=${unknown.code} err=${unknown.err}`
);

await rm(dir, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`smoke-dev FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('smoke-dev OK — startup table, hints, overlay SSE, graph reload, watch filtering, subcommands, TS floor');
