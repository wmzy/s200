#!/usr/bin/env node
/**
 * `s200 dev` end-to-end smoke — exercises the built bin (dist/cli.mjs)
 * against a real project directory:
 *
 *   1. serves the entry and answers requests,
 *   2. re-evaluates the WHOLE module graph on reload (editing a module
 *      the entry imports — not the entry itself — must reach the wire),
 *   3. ignores watch events for non-source files (writing a log inside
 *      the watched directory must not trigger a reload),
 *   4. fails fast with the remedy when a .ts entry meets a Node without
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

// The project: entry imports a dependency — the reload must reach it.
await writeFile(join(dir, 'dep.mjs'), 'export const v = "v1";\n');
await writeFile(
  join(dir, 'app.mjs'),
  `import { v } from './dep.mjs';\n` +
    `import { createApp, get } from ${JSON.stringify(join(ROOT, 'dist', 'index.mjs'))};\n` +
    `const app = createApp();\n` +
    `get(app, '/v', (ctx) => Response.json({ v }));\n` +
    `export default app;\n`
);

const child = spawn(process.execPath, [BIN, 'dev', join(dir, 'app.mjs'), '--port', String(port)], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
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

  const first = await getJson('/v');
  check('serves the entry app', first.status === 200 && first.body.v === 'v1', JSON.stringify(first));

  // 1) Graph-wide reload: edit the DEPENDENCY, not the entry.
  await writeFile(join(dir, 'dep.mjs'), 'export const v = "v2";\n');
  await waitFor(() => reloaded >= 1, 'reload after dep edit');
  const second = await getJson('/v');
  check(
    'dependency edit reaches the wire (whole-graph reload)',
    second.status === 200 && second.body.v === 'v2',
    JSON.stringify(second)
  );

  // 2) Non-source writes inside the watched directory must not reload.
  const reloadedBefore = reloaded;
  await writeFile(join(dir, 'dev.log'), `noise ${Date.now()}\n`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const third = await getJson('/v');
  check(
    'non-source write triggers no reload',
    third.body.v === 'v2' && reloaded === reloadedBefore,
    `v=${third.body.v} reloads=${reloaded - reloadedBefore}`
  );

  // 3) TypeScript floor: the exported helper agrees with the running Node
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
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
  await rm(dir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`smoke-dev FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('smoke-dev OK — graph reload, watch filtering, TS floor');
