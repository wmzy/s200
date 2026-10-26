#!/usr/bin/env node
/**
 * Floor-runtime smoke test.
 *
 * CI runs this on the MINIMUM node the package declares in `engines`
 * (>= 20.3). The toolchain itself (vite/vitest) may need newer node, so
 * this script must never pull a devDependency: node's standard library
 * plus the built artifacts (dist/) only, and only APIs that already
 * exist on the floor version (fetch, CompressionStream via dist, and
 * AbortSignal.any are all 20.3-safe).
 *
 * Exercises the core barrel, the node adapter, and a few optional
 * battery entries (cors/cookies/compress) through a real server and
 * real fetch calls: static + param routes, middleware unwind header
 * mutation, JSON body round-trip, 404/405 fallbacks, httpError mapping,
 * and the ctx.signal/ctx.url guarantees.
 *
 * Exits 0 when every check passes, 1 otherwise.
 */
const core = await import('../dist/index.mjs');
const { serve } = await import('../dist/node.mjs');
const { cors } = await import('../dist/cors.mjs');
const { setCookie, getCookie } = await import('../dist/cookies.mjs');
const { compress } = await import('../dist/compress.mjs');
const { signJwt, verifyJwt } = await import('../dist/jwt.mjs');

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log(`ok   ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name} — ${detail}`);
  }
}

// ── package surface ────────────────────────────────────────────────────────
// The floor node must be able to LOAD every entry used here — a missing
// or syntax-incompatible export fails before any request is served.
const barrelNames = [
  'createApp', 'use', 'get', 'post', 'json', 'text', 'readJson', 'httpError',
  'isHttpError', 'toErrorResponse', 'throws', 'setHeader', 'handle', 'mount',
  'redirect', 'html',
];
for (const name of barrelNames) {
  check(
    `core barrel exports ${name}`,
    typeof core[name] === 'function',
    `typeof ${name} === ${typeof core[name]}`,
  );
}
check('s200/node exports serve', typeof serve === 'function', `typeof serve === ${typeof serve}`);
check('s200/cors exports cors', typeof cors === 'function', `typeof cors === ${typeof cors}`);
check('s200/cookies exports setCookie', typeof setCookie === 'function', `typeof setCookie === ${typeof setCookie}`);
check('s200/compress exports compress', typeof compress === 'function', `typeof compress === ${typeof compress}`);
check('s200/jwt exports signJwt', typeof signJwt === 'function', `typeof signJwt === ${typeof signJwt}`);

// EdDSA (Ed25519) over WebCrypto is stable on the floor node (>= 20.3):
// the roundtrip proves the family survives the oldest supported LTS.
{
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const token = await signJwt({ sub: 'floor' }, pair.privateKey, { alg: 'EdDSA' });
  const payload = await verifyJwt(token, pair.publicKey);
  check(
    'jwt EdDSA (Ed25519) roundtrip on the floor node',
    payload.sub === 'floor',
    `sub === ${String(payload.sub)}`,
  );
}
check(
  'isHttpError recognizes httpError',
  core.isHttpError(core.httpError(418, 'teapot')) === true,
  'isHttpError(httpError(...)) === false',
);
check(
  'toErrorResponse maps an HttpError to its status',
  core.toErrorResponse(core.httpError(409, 'c')).status === 409,
  'status !== 409',
);

const { createApp, use, get, post, json, text, readJson, httpError, setHeader } = core;

// A no-op logError sink keeps the (expected) plain-Error 500 check from
// spamming the default stack-trace logger; mapping of httpError and
// plain Errors to responses is unchanged.
const app = createApp({ logError: () => undefined });

// Battery middleware at the app level: cors stamps on the unwind,
// compress rewrites byte-backed bodies (4096 bytes of 'x' clears the
// 1024-byte threshold), and the floor stamp proves middleware can still
// mutate headers after next() resolves — the "res always materialized
// on the unwind" contract, checked on the floor node.
use(app, cors());
use(app, compress());
use(app, async (ctx, next) => {
  await next();
  setHeader(ctx, 'x-s200-floor', 'unwind');
  setCookie(ctx, 'floor', 'baked');
});

get(app, '/static', (ctx) => {
  json(ctx, { route: 'static' });
});

get(app, '/hello/:name', (ctx) => {
  json(ctx, { hello: ctx.params.name });
});

post(app, '/echo', async (ctx) => {
  json(ctx, await readJson(ctx));
});

// Probes the per-request Ctx guarantees: a disconnect-aware combinable
// signal, the pre-parsed url, and cookie intake through s200/cookies.
get(app, '/ctx-probe', (ctx) => {
  const combinable = AbortSignal.any([ctx.signal]);
  json(ctx, {
    hasSignal: ctx.signal instanceof AbortSignal && ctx.signal.aborted === false,
    combinable: combinable instanceof AbortSignal && combinable.aborted === false,
    url: ctx.url instanceof URL ? ctx.url.pathname : String(ctx.url),
    cookie: getCookie(ctx, 'sent') ?? null,
  });
});

get(app, '/conflict', () => {
  throw httpError(409, 'floor conflict');
});

get(app, '/boom', () => {
  throw Error('unexpected');
});

get(app, '/big', (ctx) => {
  text(ctx, 'x'.repeat(4096));
});

post(app, '/only-post', (ctx) => {
  text(ctx, 'posted');
});

const server = await serve(app, { port: 0 });
const base = server.url;

try {
  // ── static + param routes ────────────────────────────────────────────────
  const staticRes = await fetch(`${base}/static`);
  const staticBody = await staticRes.json();
  check('GET /static status 200', staticRes.status === 200, `got ${staticRes.status}`);
  check(
    'GET /static body {"route":"static"}',
    JSON.stringify(staticBody) === '{"route":"static"}',
    JSON.stringify(staticBody),
  );

  const hello = await fetch(`${base}/hello/floor`);
  const helloBody = await hello.json();
  check('GET /hello/:name status 200', hello.status === 200, `got ${hello.status}`);
  check(
    'GET /hello/:name decodes ctx.params',
    JSON.stringify(helloBody) === '{"hello":"floor"}',
    JSON.stringify(helloBody),
  );
  check(
    'middleware unwind mutates response headers (setHeader)',
    hello.headers.get('x-s200-floor') === 'unwind',
    `got ${hello.headers.get('x-s200-floor')}`,
  );
  check(
    'setCookie stamps a Set-Cookie on the unwind',
    (hello.headers.getSetCookie() ?? []).some((c) => c.startsWith('floor=baked')),
    `got ${JSON.stringify(hello.headers.getSetCookie())}`,
  );

  // ── JSON body round-trip ────────────────────────────────────────────────
  const echo = await fetch(`${base}/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ a: 1 }),
  });
  const echoBody = await echo.json();
  check('POST /echo status 200', echo.status === 200, `got ${echo.status}`);
  check(
    'POST /echo readJson round-trips the body',
    JSON.stringify(echoBody) === '{"a":1}',
    JSON.stringify(echoBody),
  );

  // ── Ctx guarantees ──────────────────────────────────────────────────────
  const probe = await fetch(`${base}/ctx-probe`, { headers: { cookie: 'sent=yes' } });
  const probeBody = await probe.json();
  check('ctx.signal exists un-aborted', probeBody.hasSignal === true, JSON.stringify(probeBody));
  check(
    'ctx.signal composes with AbortSignal.any',
    probeBody.combinable === true,
    JSON.stringify(probeBody),
  );
  check('ctx.url is the pre-parsed URL', probeBody.url === '/ctx-probe', probeBody.url);
  check('getCookie reads the request cookie', probeBody.cookie === 'yes', probeBody.cookie);

  // ── error mapping ───────────────────────────────────────────────────────
  const conflict = await fetch(`${base}/conflict`);
  const conflictBody = await conflict.json();
  check('thrown httpError maps to its status', conflict.status === 409, `got ${conflict.status}`);
  check(
    'httpError body is the { error } envelope',
    JSON.stringify(conflictBody) === '{"error":"floor conflict"}',
    JSON.stringify(conflictBody),
  );
  check(
    'error response still carries the unwind stamp',
    conflict.headers.get('x-s200-floor') === 'unwind',
    `got ${conflict.headers.get('x-s200-floor')}`,
  );

  const boom = await fetch(`${base}/boom`);
  check('plain Error maps to 500', boom.status === 500, `got ${boom.status}`);

  // ── 404/405 fallbacks ───────────────────────────────────────────────────
  const notFound = await fetch(`${base}/definitely-not-a-route`);
  const notFoundBody = await notFound.json();
  check('unmatched path answers 404', notFound.status === 404, `got ${notFound.status}`);
  check(
    '404 body is the fallback envelope',
    JSON.stringify(notFoundBody) === '{"error":"Not Found"}',
    JSON.stringify(notFoundBody),
  );
  check(
    '404 fallback is materialized inside the chain (stamped on the unwind)',
    notFound.headers.get('x-s200-floor') === 'unwind',
    `got ${notFound.headers.get('x-s200-floor')}`,
  );

  const methodNotAllowed = await fetch(`${base}/only-post`);
  const allowBody = await methodNotAllowed.json();
  check('method miss answers 405', methodNotAllowed.status === 405, `got ${methodNotAllowed.status}`);
  check(
    '405 carries the Allow header',
    (methodNotAllowed.headers.get('allow') ?? '').includes('POST'),
    `got ${methodNotAllowed.headers.get('allow')}`,
  );
  check(
    '405 body is the fallback envelope',
    JSON.stringify(allowBody) === '{"error":"Method Not Allowed"}',
    JSON.stringify(allowBody),
  );

  // ── cors battery (real preflight + stamped actual response) ──────────────
  const actual = await fetch(`${base}/static`, { headers: { origin: 'http://floor.test' } });
  check(
    'cors stamps access-control-allow-origin on actual responses',
    actual.headers.get('access-control-allow-origin') === '*',
    `got ${actual.headers.get('access-control-allow-origin')}`,
  );
  const preflight = await fetch(`${base}/only-post`, {
    method: 'OPTIONS',
    headers: { origin: 'http://floor.test', 'access-control-request-method': 'POST' },
  });
  check('cors preflight answers 204 in place', preflight.status === 204, `got ${preflight.status}`);
  check(
    'cors preflight echoes the requested method',
    preflight.headers.get('access-control-allow-methods') === 'POST',
    `got ${preflight.headers.get('access-control-allow-methods')}`,
  );

  // ── compress battery (CompressionStream on the floor node) ───────────────
  const big = await fetch(`${base}/big`, { headers: { 'accept-encoding': 'gzip' } });
  const bigBody = await big.text();
  check(
    'compress encodes byte-backed bodies (gzip)',
    big.headers.get('content-encoding') === 'gzip',
    `got ${big.headers.get('content-encoding')}`,
  );
  check(
    'compressed body decompresses to the original bytes',
    bigBody === 'x'.repeat(4096),
    `got ${bigBody.length} chars`,
  );
  check(
    'compress stamps Vary: Accept-Encoding',
    (big.headers.get('vary') ?? '').toLowerCase().includes('accept-encoding'),
    `got ${big.headers.get('vary')}`,
  );
} finally {
  await server.close();
}

if (failures > 0) {
  console.error(`\nsmoke-floor FAILED — ${failures} check(s) did not pass on node ${process.version}`);
  process.exit(1);
}
console.log(`\nsmoke-floor OK — all checks passed on node ${process.version} (declared floor: >= 20.3)`);
