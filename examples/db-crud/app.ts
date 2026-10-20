/**
 * db-crud — a `users` resource over real persistence.
 *
 * Every route below reads and writes SQLite through Node's built-in
 * `node:sqlite` (see db.ts) — no database driver, no npm dependency. The
 * point: s200's chain composes with a stateful resource the same way it
 * composes with in-memory ones; SQL is the single source of truth.
 *
 * Batteries on show:
 *   - `jsonBody` (s200/validate) gating typed bodies: invalid JSON is a
 *     400 from `readJson` before the parse fn runs; a bad shape is the
 *     parse fn's own 422
 *   - `serialize` + `jsonRaw` (s200/serialize) on the way out: schema'd
 *     serializers emit exactly the declared keys with an exact
 *     content-length — the drop-in pair for `json()` on hot paths
 *   - database facts mapped to HTTP facts: a missing row is `httpError`
 *     404, a UNIQUE violation is 409 Conflict
 *   - `send(ctx, null, { status: 204 })` for DELETE — send() knows a
 *     null-body status must not advertise content-length
 *
 * Run with DB_PATH=/path/to/db to persist to a file; :memory: otherwise.
 */
import type { SerializeSchema } from 's200/serialize';
import type { User } from './db.ts';

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { createApp, del, get, httpError, post, put, send } from 's200';
import { serve } from 's200/node';
import { jsonRaw, serialize } from 's200/serialize';
import { jsonBody } from 's200/validate';

import { isUniqueViolation, openUserStore } from './db.ts';

export type { User };

/** One shared response contract: `serialize` compiles it once, and the
 * serializers below emit exactly the declared keys — nothing else. */
const userSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    email: { type: 'string' },
  },
  required: ['id', 'name', 'email'],
} as const satisfies SerializeSchema;

const toUserJson = serialize(userSchema);
const toUserListJson = serialize({ type: 'array', items: userSchema });

/** Hand-rolled parse fn for `jsonBody` — s200 stays schema-library-free
 * and just calls it; throwing an `HttpError` maps to that status. */
const parseNewUser = (data: unknown): Omit<User, 'id'> => {
  if (typeof data !== 'object' || data === null) {
    throw httpError(422, 'Body must be a JSON object');
  }
  const { name, email } = data as { name?: unknown; email?: unknown };
  if (typeof name !== 'string' || name.trim() === '') {
    throw httpError(422, 'name must be a non-empty string');
  }
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw httpError(422, 'email must be an email address');
  }
  return { name: name.trim(), email: email.trim().toLowerCase() };
};

/** Route params arrive as strings; a non-integer addresses no user. */
const userId = (raw: string): number => {
  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) {
    throw httpError(404, `No user ${raw}`);
  }
  return id;
};

/** Runs `fn()`; a SQLite UNIQUE violation on the given email maps to 409
 * Conflict, anything else propagates unchanged. */
const guardingConflicts = <T>(fn: () => T, email: string): T => {
  try {
    return fn();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw httpError(409, `Email ${email} is already in use`);
    }
    throw error;
  }
};

export const app = createApp();

// Opened at import time: :memory: by default, a file via DB_PATH. The
// smoke imports this module and gets a fresh seeded database per process.
const store = openUserStore(process.env.DB_PATH);

get(app, '/users', (ctx) => jsonRaw(ctx, toUserListJson(store.list())));

post(app, '/users', jsonBody(parseNewUser), (ctx) => {
  const input = ctx.state.validated as Omit<User, 'id'>;
  const user = guardingConflicts(() => store.create(input), input.email);
  return jsonRaw(ctx, toUserJson(user), { status: 201 });
});

get(app, '/users/:id', (ctx) => {
  const user = store.find(userId(ctx.params.id));
  if (user === undefined) {
    throw httpError(404, `No user ${ctx.params.id}`);
  }
  return jsonRaw(ctx, toUserJson(user));
});

put(app, '/users/:id', jsonBody(parseNewUser), (ctx) => {
  const id = userId(ctx.params.id);
  const input = ctx.state.validated as Omit<User, 'id'>;
  const user = guardingConflicts(() => store.update(id, input), input.email);
  if (user === undefined) {
    throw httpError(404, `No user ${id}`);
  }
  return jsonRaw(ctx, toUserJson(user));
});

del(app, '/users/:id', (ctx) => {
  if (!store.remove(userId(ctx.params.id))) {
    throw httpError(404, `No user ${ctx.params.id}`);
  }
  return send(ctx, null, { status: 204 });
});

export async function main(): Promise<void> {
  const server = await serve(app, { port: Number(process.env.PORT ?? 3000) });
  console.log(`db-crud listening on ${server.url} — try GET ${server.url}/users`);
}

// Serve only when executed directly (`node app.ts`), not when smoke.ts
// imports the app to drive it on an ephemeral port.
const entry =
  process.argv[1] === undefined
    ? undefined
    : pathToFileURL(realpathSync(process.argv[1])).href;
if (entry === import.meta.url) {
  await main();
}
