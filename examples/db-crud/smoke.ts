/**
 * Smoke test for db-crud — drives the real app.ts against the workspace
 * `src/` (the resolve hook in ../ts-resolve.mjs redirects the public
 * `s200*` entry names there), over a real HTTP server on an ephemeral
 * port, with real SQLite (a fresh :memory: database) behind every route.
 *
 * Run: node smoke.ts — exits 0 when every check passes.
 */
import '../ts-resolve.mjs';

import type { User } from './db.ts';

const { app } = await import('./app.ts');
const { serve } = await import('s200/node');

let failures = 0;
const check = (name: string, ok: boolean, detail?: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${detail ?? ''}`}`);
  if (!ok) failures += 1;
};

const server = await serve(app, { port: 0 });
const base = server.url;

const jsonHeaders = { 'content-type': 'application/json' };
const postJson = (path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) });
const putJson = (path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: 'PUT', headers: jsonHeaders, body: JSON.stringify(body) });

try {
  // The seeded database: two users, in insertion order.
  const seeded = await fetch(`${base}/users`);
  const seededUsers = (await seeded.json()) as User[];
  check('GET /users → 200', seeded.status === 200);
  check(
    'GET /users lists the two seeded users',
    Array.isArray(seededUsers) &&
      seededUsers.length === 2 &&
      seededUsers[0]?.name === 'ada lovelace' &&
      seededUsers[1]?.email === 'alan@example.com'
  );

  const ada = await fetch(`${base}/users/1`);
  const adaBody = (await ada.json()) as User;
  check(
    'GET /users/1 → 200 with the seeded row',
    ada.status === 200 && adaBody.id === 1 && adaBody.name === 'ada lovelace'
  );

  const missing = await fetch(`${base}/users/999`);
  check('GET /users/999 → 404', missing.status === 404);
  check(
    '404 body carries the error message',
    ((await missing.json()) as { error?: string }).error === 'No user 999'
  );
  const nonNumeric = await fetch(`${base}/users/abc`);
  check('GET /users/abc (non-integer id) → 404', nonNumeric.status === 404);

  // Create: 201, and the row echoes back with its SQLite-assigned id.
  const created = await postJson('/users', { name: '  grace hopper  ', email: 'Grace@Example.com' });
  const createdUser = (await created.json()) as User;
  check('POST /users → 201', created.status === 201);
  check(
    'created user kept the parsed shape (trimmed, lowercased, fresh id)',
    createdUser.id === 3 &&
      createdUser.name === 'grace hopper' &&
      createdUser.email === 'grace@example.com'
  );

  // The UNIQUE constraint on users.email maps to 409.
  const dup = await postJson('/users', { name: 'imposter', email: 'ada@example.com' });
  check('POST /users with duplicate email → 409', dup.status === 409);
  check(
    '409 body names the conflict',
    ((await dup.json()) as { error?: string }).error === 'Email ada@example.com is already in use'
  );

  // jsonBody gate: bad shape is the parse fn's 422; invalid JSON is
  // readJson's 400 before the parse fn ever runs.
  const badShape = await postJson('/users', { name: 42, email: 'x@y' });
  check('POST /users with non-string name → 422', badShape.status === 422);
  const badEmail = await postJson('/users', { name: 'x', email: 'not-an-email' });
  check('POST /users with malformed email → 422', badEmail.status === 422);
  const badJson = await fetch(`${base}/users`, {
    method: 'POST',
    headers: jsonHeaders,
    body: '{nope',
  });
  check('POST /users with invalid JSON → 400', badJson.status === 400);

  // Update: the stored row changes; a missing id is 404, a taken email 409.
  const updated = await putJson('/users/3', { name: 'grace m. hopper', email: 'grace@example.com' });
  const updatedUser = (await updated.json()) as User;
  check(
    'PUT /users/3 → 200 with the updated row',
    updated.status === 200 &&
      updatedUser.id === 3 &&
      updatedUser.name === 'grace m. hopper'
  );
  const updateMissing = await putJson('/users/999', { name: 'x', email: 'x@y' });
  check('PUT /users/999 → 404', updateMissing.status === 404);
  const updateConflict = await putJson('/users/3', { name: 'x', email: 'alan@example.com' });
  check('PUT /users/3 onto a taken email → 409', updateConflict.status === 409);

  // Delete: 204 with an empty body (send() skips content-length on it),
  // and the row is really gone from the database.
  const deleted = await fetch(`${base}/users/3`, { method: 'DELETE' });
  const deletedBody = await deleted.text();
  check('DELETE /users/3 → 204', deleted.status === 204);
  check('204 body is empty', deletedBody === '');
  check('204 carries no content-length', deleted.headers.get('content-length') === null);
  const deleteAgain = await fetch(`${base}/users/3`, { method: 'DELETE' });
  check('DELETE /users/3 again → 404', deleteAgain.status === 404);
  const afterDelete = await fetch(`${base}/users`);
  check(
    'list reflects the deletion',
    ((await afterDelete.json()) as User[]).length === 2
  );

  // The router answers 405 + Allow itself (no collection DELETE exists).
  const notAllowed = await fetch(`${base}/users`, { method: 'DELETE' });
  const allow = notAllowed.headers.get('allow') ?? '';
  check(
    'DELETE /users (unregistered method) → 405 + Allow',
    notAllowed.status === 405 && allow.includes('GET') && allow.includes('POST'),
    `status=${String(notAllowed.status)} allow=${allow}`
  );
} finally {
  await server.close();
  check('server closed (no longer listening)', server.server.listening === false);
}

process.exit(failures === 0 ? 0 : 1);
