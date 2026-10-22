/**
 * Smoke test for crud-openapi — drives the real app.ts fully in-process
 * through `s200/test`'s `request()` (no server, no port; `handle` is the
 * whole dispatch contract), then checks the two "route table as data"
 * payoffs off the same live table: `openapiSpec` documents the surface,
 * and `generateClient` emits a typed client carrying the real patterns.
 *
 * Run: node smoke.ts — exits 0 when every check passes.
 */
import '../ts-resolve.mjs';

type User = { id: number; name: string; email: string };

const { app } = await import('./app.ts');
const { request } = await import('s200/test');
const { openapiSpec } = await import('s200/openapi');
const { generateClient } = await import('s200/codegen');

let failures = 0;
const check = (name: string, ok: boolean, detail?: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${detail ?? ''}`}`);
  if (!ok) failures += 1;
};

const jsonHeaders = { 'content-type': 'application/json' };
const call = (method: string, path: string, body?: unknown) =>
  request(app, path, {
    method,
    headers: body === undefined ? undefined : jsonHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// — the CRUD lifecycle, in-process —

const empty = await call('GET', '/users');
check(
  'GET /users on a fresh app → 200 []',
  empty.status === 200 && JSON.stringify(await empty.json()) === '[]'
);

const created = await call('POST', '/users', {
  name: '  grace hopper  ',
  email: 'Grace@Example.com',
});
const createdUser = (await created.json()) as User;
check('POST /users → 201', created.status === 201);
check(
  'the Standard Schema gate parsed the body (trimmed, lowercased, id assigned)',
  createdUser.id === 1 &&
    createdUser.name === 'grace hopper' &&
    createdUser.email === 'grace@example.com'
);

const detail = await call('GET', '/users/1');
check(
  'GET /users/1 → 200 with the created row',
  detail.status === 200 && ((await detail.json()) as User).name === 'grace hopper'
);

const dup = await call('POST', '/users', { name: 'imposter', email: 'grace@example.com' });
check('POST /users with a taken email → 409', dup.status === 409);
check(
  'the 409 body names the conflict',
  ((await dup.json()) as { error?: string }).error === 'Email grace@example.com is already in use'
);

const badShape = await call('POST', '/users', { name: '', email: 'not-an-email' });
check('POST /users with an invalid body → 422 from the schema gate', badShape.status === 422);

const missing = await call('GET', '/users/999');
check('GET /users/999 → 404', missing.status === 404);
check(
  'the 404 body carries the message',
  ((await missing.json()) as { error?: string }).error === 'No user 999'
);

// A second user makes the PUT conflict testable.
await call('POST', '/users', { name: 'alan turing', email: 'alan@example.com' });

const updated = await call('PUT', '/users/1', { name: 'grace m. hopper', email: 'grace@example.com' });
check(
  'PUT /users/1 → 200 with the replacement',
  updated.status === 200 && ((await updated.json()) as User).name === 'grace m. hopper'
);
const putConflict = await call('PUT', '/users/1', {
  name: 'grace m. hopper',
  email: 'alan@example.com',
});
check('PUT /users/1 onto the other user’s email → 409', putConflict.status === 409);
const putMissing = await call('PUT', '/users/999', { name: 'x', email: 'x@y.example' });
check('PUT /users/999 → 404', putMissing.status === 404);

const deleted = await call('DELETE', '/users/1');
const deletedBody = await deleted.text();
check('DELETE /users/1 → 204 with an empty body', deleted.status === 204 && deletedBody === '');
const deleteAgain = await call('DELETE', '/users/1');
check('DELETE /users/1 again → 404', deleteAgain.status === 404);
const gone = await call('GET', '/users/1');
check('GET /users/1 after deletion → 404', gone.status === 404);
const remaining = await call('GET', '/users');
check(
  'the list reflects the deletion',
  remaining.status === 200 && ((await remaining.json()) as User[]).length === 1
);

// — the spec, derived from the same live route table —

const spec = openapiSpec(app, { title: 'Users API', version: '1.0.0' });
const usersItem = spec.paths['/users'] as Record<string, unknown> | undefined;
check(
  'openapiSpec documents /users (get + post)',
  usersItem !== undefined && 'get' in usersItem && 'post' in usersItem
);
const userItem = spec.paths['/users/{id}'] as Record<string, unknown> | undefined;
check(
  'openapiSpec documents /users/{id} (get/put/delete)',
  userItem !== undefined && 'get' in userItem && 'put' in userItem && 'delete' in userItem
);
const getOp = userItem?.get as
  | { responses?: Record<string, { description?: string }> }
  | undefined;
check(
  'GET /users/{id} declares the 404 branch',
  getOp?.responses?.['404']?.description === 'no such user'
);
const postOp = usersItem?.post as { requestBody?: unknown } | undefined;
check('POST /users declares a requestBody', postOp?.requestBody !== undefined);

// — the generated client, from the same live route table —

const client = generateClient(app, { name: 'createUsersClient' });
check(
  'generateClient emits the /users/:id pattern literal',
  client.includes("'/users/:id'")
);
check(
  'generateClient emits one typed method per resource route',
  client.includes('getUsers:') &&
    client.includes('postUsers:') &&
    client.includes('getUsersId:') &&
    client.includes('putUsersId:') &&
    client.includes('deleteUsersId:')
);
check(
  'the generated factory carries the requested name',
  client.includes('export function createUsersClient(')
);

process.exit(failures === 0 ? 0 : 1);
