/**
 * Smoke test for ws-chat — two layers:
 *
 *   1. HTTP-level (this file, node): the chat page serves, and a plain
 *      GET /chat/<room> — no `Upgrade` header — never matches the ws
 *      route: `upgradeWebSocket` registers beside the HTTP route table,
 *      so the static miss falls through to next() and the default 404.
 *      Only the server's 'upgrade' event reaches ws dispatch.
 *   2. ws round trip (bun smoke-ws.ts): spawned here because bun ships a
 *      native WebSocket client; it connects two peers to a room, checks
 *      broadcast + roster events, room isolation, and leave cleanup.
 *      Skipped with a logged note when bun is unavailable.
 *
 * The app runs against the workspace `src/` (../ts-resolve.mjs redirects
 * the public `s200*` entry names there) on an ephemeral port.
 *
 * Run: node smoke.ts — exits 0 when every check passes.
 */
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import '../ts-resolve.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const { app } = await import('./app.ts');
const { serve } = await import('s200/node');
const { createUpgradeHandler } = await import('s200/websocket/node');

let failures = 0;
const check = (name: string, ok: boolean, detail?: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${detail ?? ''}`}`);
  if (!ok) failures += 1;
};

/** Runs `bun smoke-ws.ts <url>`; resolves the child's exit code, or null
 * when bun is not installed (a skip, not a failure). */
const runWsRoundTrip = (url: string): Promise<number | null> =>
  new Promise((resolve) => {
    const child = spawn('bun', ['smoke-ws.ts', url], { cwd: here, stdio: 'inherit' });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        resolve(null);
      } else {
        resolve(1);
      }
    });
    child.on('close', (code) => resolve(code ?? 1));
  });

const server = await serve(app, { port: 0, upgrade: createUpgradeHandler(app) });
const base = server.url;

try {
  // The chat page serves (index: 'chat.html' maps / to it).
  const page = await fetch(`${base}/`);
  const html = await page.text();
  check('GET / serves the chat page', page.status === 200);
  check(
    'chat page content-type is text/html',
    (page.headers.get('content-type') ?? '').startsWith('text/html')
  );
  check('page wires a WebSocket client', html.includes('new WebSocket('));

  // Same path as a plain GET (no Upgrade header): the ws route is not an
  // HTTP route, the static lookup misses, and the default 404 answers.
  const plainGet = await fetch(`${base}/chat/room1`);
  const notFound = plainGet.status === 404;
  check(
    'GET /chat/room1 without Upgrade header → 404 (ws routes answer upgrades only)',
    notFound,
    `status was ${String(plainGet.status)}`
  );
  if (notFound) {
    await plainGet.json(); // drain the 404 body so the socket frees up
  }

  // Real ws round trip through bun's native client.
  const wsExit = await runWsRoundTrip(base);
  if (wsExit === null) {
    console.log('SKIP ws round trip — bun not found on PATH');
  } else {
    check('bun smoke-ws.ts round trip passed', wsExit === 0, `exit ${String(wsExit)}`);
  }
} finally {
  await server.close();
  check('server closed (no longer listening)', server.server.listening === false);
}

process.exit(failures === 0 ? 0 : 1);
