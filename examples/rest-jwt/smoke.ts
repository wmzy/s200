/**
 * Smoke test for rest-jwt — drives the real app.ts against the workspace
 * `src/` (the resolve hook in ../ts-resolve.mjs redirects the public
 * `s200*` entry names there), over a real HTTP server on an ephemeral port.
 *
 * Run: node smoke.ts — exits 0 when every check passes.
 */
import '../ts-resolve.mjs';

import type { Article } from './app.ts';

const { app } = await import('./app.ts');
const { serve } = await import('s200/node');

let failures = 0;
const check = (name: string, ok: boolean, detail?: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${detail ?? ''}`}`);
  if (!ok) failures += 1;
};

const server = await serve(app, { port: 0 });
const base = server.url;

const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

try {
  // Wrong password: 401, and the body is the mapped HttpError message.
  const badLogin = await postJson('/login', { user: 'ada', password: 'nope' });
  check('login with wrong password → 401', badLogin.status === 401);
  check(
    'login 401 body carries the error message',
    ((await badLogin.json()) as { error?: string }).error === 'Wrong user or password'
  );

  // Login mints a compact JWS (three dot-separated base64url segments).
  const login = await postJson('/login', { user: 'ada', password: 'lovelace' });
  const loginBody = (await login.json()) as { token?: string };
  check('login → 200', login.status === 200);
  check(
    'login returns a compact JWT',
    typeof loginBody.token === 'string' && loginBody.token.split('.').length === 3
  );
  const auth = { authorization: `Bearer ${loginBody.token}` };

  // /me without a token: 401 + RFC 7235 challenge (stamped by the example's
  // prefix middleware on the unwind — the boundary materializes the 401).
  const anonymous = await fetch(`${base}/me`);
  check('/me without token → 401', anonymous.status === 401);
  check(
    '/me 401 carries WWW-Authenticate: Bearer',
    anonymous.headers.get('www-authenticate') === 'Bearer'
  );

  // A structurally valid but wrongly signed token: still 401 + challenge.
  const [head, payload] = (loginBody.token ?? '').split('.');
  const forged = `${head}.${payload}.Zm9yZ2Vk`;
  const badToken = await fetch(`${base}/me`, { headers: { authorization: `Bearer ${forged}` } });
  check('/me with bad signature → 401', badToken.status === 401);
  check(
    'bad-signature 401 says Invalid token',
    ((await badToken.json()) as { error?: string }).error === 'Invalid token'
  );
  check(
    'bad-signature 401 carries WWW-Authenticate',
    badToken.headers.get('www-authenticate') === 'Bearer'
  );

  // /me with the real token returns the verified payload (sub: ada).
  const me = await fetch(`${base}/me`, { headers: auth });
  const meBody = (await me.json()) as { sub?: string; exp?: number };
  check('/me with token → 200', me.status === 200);
  check('verified payload has sub=ada and exp', meBody.sub === 'ada' && typeof meBody.exp === 'number');

  // Articles are gated.
  const anonList = await fetch(`${base}/articles`);
  check('GET /articles without token → 401', anonList.status === 401);

  // jsonBody gate: invalid shape is rejected before the handler runs.
  const invalid = await postJson('/articles', { title: 42 }, auth);
  check('POST /articles with bad body → 422', invalid.status === 422);

  // Create (note the trimmed title — the hand-rolled parse fn did it).
  const created = await postJson('/articles', { title: '  Hello  ', body: 'First post' }, auth);
  const article = (await created.json()) as Article;
  check('POST /articles → 201', created.status === 201);
  check(
    'created article kept the parsed shape',
    article.title === 'Hello' && article.body === 'First post' && typeof article.id === 'string'
  );

  // List + read-back by id.
  const list = await fetch(`${base}/articles`, { headers: auth });
  const items = (await list.json()) as Article[];
  check(
    'GET /articles lists the created article',
    list.status === 200 && Array.isArray(items) && items.some((a) => a.id === article.id)
  );

  const one = await fetch(`${base}/articles/${article.id}`, { headers: auth });
  check(
    'GET /articles/:id returns the stored article',
    one.status === 200 && ((await one.json()) as Article).id === article.id
  );

  const missing = await fetch(`${base}/articles/does-not-exist`, { headers: auth });
  check('GET /articles/does-not-exist → 404', missing.status === 404);
} finally {
  await server.close();
  check('server closed (no longer listening)', server.server.listening === false);
}

process.exit(failures === 0 ? 0 : 1);
