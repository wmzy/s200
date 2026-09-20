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

const { createApp, use, get, post, json, text, readJson } = core;

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

get(app, '/*all', (ctx) => {
  text(ctx, 'fallback');
});

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
} finally {
  await server.close();
}

if (failures > 0) {
  console.error(`\nsmoke FAILED — ${failures} check(s) did not pass`);
  process.exit(1);
}
console.log(`\nsmoke OK — all checks passed on ${globalThis.Bun ? 'bun' : 'node'}`);
