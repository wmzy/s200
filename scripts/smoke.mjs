#!/usr/bin/env node
/**
 * Runtime-agnostic smoke test.
 *
 * Runs the built artifacts (dist/) through the adapter of the invoking
 * runtime — node or bun — and exercises the core end to end: onion
 * middleware header injection, param routes, JSON body reading and the
 * wildcard fallback.
 *
 * Exits 0 when every check passes, 1 otherwise.
 */
const core = await import('../dist/index.mjs');
const adapter = globalThis.Bun
  ? await import('../dist/bun.mjs')
  : await import('../dist/node.mjs');

const { createApp, use, get, post, json, text, readJson, mount, serveStatic } = core;

const app = createApp();

use(app, async (ctx, next) => {
  await next();
  if (ctx.res !== undefined) {
    const headers = new Headers(ctx.res.headers);
    headers.set('x-s200', 'smoke');
    ctx.res = new Response(ctx.res.body, {
      status: ctx.res.status,
      statusText: ctx.res.statusText,
      headers,
    });
  }
});

get(app, '/hello/:name', (ctx) => {
  json(ctx, { hello: ctx.params.name });
});

post(app, '/echo', async (ctx) => {
  json(ctx, await readJson(ctx));
});

get(app, '/secret', (ctx, next) => {
  if (ctx.query.get('token') !== 's200') {
    text(ctx, 'denied', { status: 401 });
    return; // no next(): the handler must not run
  }
  return next();
}, (ctx) => json(ctx, { secret: 'ok' }));

// A mounted sub-app proves the trie joins prefixes and params, and a busy
// route table exercises the static-prefix index against the last bucket.
// All registered before the catch-all so the wildcard never shadows them.
const api = createApp();
get(api, '/users/:id', (ctx) => json(ctx, { id: ctx.params.id }));
mount(app, '/v1', api);
for (let i = 0; i < 50; i += 1) {
  get(app, `/api/resource${i}/:id`, (ctx) => json(ctx, { n: i, id: ctx.params.id }));
}
get(app, '/*all', (ctx) => {
  text(ctx, 'fallback');
});

// Dotfiles get their own app: a read that must never see a dotfile path.
const staticReads = [];
const staticApp = createApp();
use(
  staticApp,
  serveStatic({
    read: async (path) => {
      staticReads.push(path);
      return new TextEncoder().encode('file');
    },
  }),
);

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log(`ok   ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name} — ${detail}`);
  }
}

const server = await adapter.serve(app, { port: 0 });
const base = server.url;

try {
  const hello = await fetch(`${base}/hello/smoke`);
  const helloBody = await hello.json();
  check('GET /hello/:name status 200', hello.status === 200, `got ${hello.status}`);
  check(
    'GET /hello/:name body {"hello":"smoke"}',
    JSON.stringify(helloBody) === '{"hello":"smoke"}',
    JSON.stringify(helloBody),
  );
  check(
    'onion middleware header on route hit',
    hello.headers.get('x-s200') === 'smoke',
    `got ${hello.headers.get('x-s200')}`,
  );

  const echo = await fetch(`${base}/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ a: 1 }),
  });
  const echoBody = await echo.json();
  check('POST /echo status 200', echo.status === 200, `got ${echo.status}`);
  check(
    'POST /echo roundtrips the JSON body',
    JSON.stringify(echoBody) === '{"a":1}',
    JSON.stringify(echoBody),
  );
  check(
    'onion middleware header on echo',
    echo.headers.get('x-s200') === 'smoke',
    `got ${echo.headers.get('x-s200')}`,
  );

  const denied = await fetch(`${base}/secret`);
  const deniedBody = await denied.text();
  check('route middleware short-circuits with 401', denied.status === 401, `got ${denied.status}`);
  check('short-circuited 401 body is "denied"', deniedBody === 'denied', deniedBody);
  check(
    'app middleware unwind still stamps the short-circuited response',
    denied.headers.get('x-s200') === 'smoke',
    `got ${denied.headers.get('x-s200')}`,
  );

  const secret = await fetch(`${base}/secret?token=s200`);
  const secretBody = await secret.json();
  check('route middleware passes through on success', secret.status === 200, `got ${secret.status}`);
  check(
    'gated handler body {"secret":"ok"}',
    JSON.stringify(secretBody) === '{"secret":"ok"}',
    JSON.stringify(secretBody),
  );

  const fallback = await fetch(`${base}/anything/else`);
  const fallbackBody = await fallback.text();
  check('GET wildcard fallback status 200', fallback.status === 200, `got ${fallback.status}`);
  check(
    'GET wildcard fallback body "fallback"',
    fallbackBody === 'fallback',
    `got ${fallbackBody}`,
  );
  check(
    'onion middleware header on fallback',
    fallback.headers.get('x-s200') === 'smoke',
    `got ${fallback.headers.get('x-s200')}`,
  );

  const mounted = await fetch(`${base}/v1/users/42`);
  const mountedBody = await mounted.json();
  check('mounted sub-app route status 200', mounted.status === 200, `got ${mounted.status}`);
  check(
    'mounted sub-app params joined under the prefix',
    JSON.stringify(mountedBody) === '{"id":"42"}',
    JSON.stringify(mountedBody),
  );

  const lastBucket = await fetch(`${base}/api/resource49/7`);
  const lastBucketBody = await lastBucket.json();
  check(
    'trie reaches the last static bucket',
    JSON.stringify(lastBucketBody) === '{"n":49,"id":"7"}',
    JSON.stringify(lastBucketBody),
  );

  const staticServer = await adapter.serve(staticApp, { port: 0 });
  try {
    const dotfile = await fetch(`${staticServer.url}/.env`);
    check('dotfile path is refused with 404', dotfile.status === 404, `got ${dotfile.status}`);
    check(
      'dotfile refusal happens before any read',
      !staticReads.includes('.env'),
      `read saw: ${staticReads.join(',')}`,
    );
    const plain = await fetch(`${staticServer.url}/ok.txt`);
    check('non-dotfile path is served', plain.status === 200, `got ${plain.status}`);
    check('plain file lookup reached the reader', staticReads.includes('ok.txt'), `read saw: ${staticReads.join(',')}`);
  } finally {
    await staticServer.close();
  }

  // WebSocket round-trip: the bun bridge on bun, the RFC 6455 server on
  // node. Needs a WebSocket client (bun always; node >= 22).
  if (typeof WebSocket !== 'undefined') {
    const wsMod = await import('../dist/websocket.mjs');
    const wsApp = createApp();
    wsMod.upgradeWebSocket(wsApp, '/ws/:id', (socket, ctx) => {
      socket.onMessage((data) => socket.send(`${ctx.params.id}:${data}`));
    });
    let wsServer;
    if (globalThis.Bun) {
      const { createBunWebSocketBridge } = await import('../dist/websocket-bun.mjs');
      wsServer = adapter.serve(wsApp, {
        port: 0,
        websocket: createBunWebSocketBridge(wsApp),
      });
    } else {
      const { createUpgradeHandler } = await import('../dist/websocket-node.mjs');
      wsServer = await adapter.serve(wsApp, {
        port: 0,
        upgrade: createUpgradeHandler(wsApp),
      });
    }
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${wsServer.port}/ws/42`);
      const reply = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('ws timeout')), 3000);
        ws.addEventListener('open', () => ws.send('hi'));
        ws.addEventListener('message', (event) => {
          clearTimeout(timer);
          resolve(event.data);
        });
        ws.addEventListener('error', () => {
          clearTimeout(timer);
          reject(new Error('ws error'));
        });
      });
      check('websocket upgrade + echo with params', reply === '42:hi', `got ${reply}`);
      ws.close();
    } finally {
      await wsServer.close();
    }
  } else {
    console.log('skip websocket round-trip (no WebSocket client on this runtime)');
  }
} finally {
  await server.close();
}

if (failures > 0) {
  console.error(`\nsmoke FAILED — ${failures} check(s) did not pass`);
  process.exit(1);
}
console.log(`\nsmoke OK — all checks passed on ${globalThis.Bun ? 'bun' : 'node'}`);
