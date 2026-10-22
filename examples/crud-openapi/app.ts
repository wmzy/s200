/**
 * crud-openapi — the "route table is the spec" example.
 *
 * One `/users` resource, five routes, zero dependencies — and every fact
 * about the API lives in the route table itself: `describeRoute`
 * annotates each route (summary, body, responses — including the 404/409
 * error branches), `openapiJson` serves the OpenAPI 3.1 document derived
 * from that table, `swaggerUi` serves the Scalar docs page, and
 * `s200/codegen` (see smoke.ts) emits a typed client from the same
 * table. Annotate once, consume everywhere.
 *
 * The validation channel is Standard Schema (`standardschema.dev`): the
 * body schema below is hand-rolled in the vendor-neutral shape, so it
 * slots into `jsonBody` with no wrapper — swap in a zod/valibot schema
 * and nothing else changes.
 *
 * Storage is a plain in-memory Map: fresh on every process, no database.
 * Run with PORT=… to pick a port (default 3000).
 */
import type { SerializeSchema } from 's200/serialize';
import type { StandardSchema } from 's200/validate';
import type { RouteMeta } from 's200/meta';

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { createApp, del, get, httpError, json, post, put, send } from 's200';
import { serve } from 's200/node';
import { jsonBody } from 's200/validate';
import { describeApp, describeRoute } from 's200/meta';
import { openapiJson } from 's200/openapi';
import { swaggerUi } from 's200/swagger';

export type User = { id: number; name: string; email: string };

/** What a create/update request carries — the parsed product of the
 * Standard Schema below. */
type NewUser = { readonly name: string; readonly email: string };

/**
 * The body gate, hand-rolled as a Standard Schema: the `~standard` prop
 * is the whole contract (version, vendor, validate). `jsonBody` detects
 * it structurally, calls `validate` on the parsed body, and maps the
 * first reported issue to a 422 `HttpError` — the handler never sees an
 * invalid body. A zod/valibot/typebox schema drops into the same slot
 * with zero changes elsewhere.
 */
const newUserSchema: StandardSchema<NewUser> = {
  '~standard': {
    version: 1,
    vendor: 'crud-openapi',
    validate: (data) => {
      if (typeof data !== 'object' || data === null) {
        return { issues: [{ message: 'body must be a JSON object' }] };
      }
      const { name, email } = data as { name?: unknown; email?: unknown };
      if (typeof name !== 'string' || name.trim() === '') {
        return { issues: [{ message: 'name must be a non-empty string', path: ['name'] }] };
      }
      if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(email)) {
        return { issues: [{ message: 'email must be an email address', path: ['email'] }] };
      }
      return { value: { name: name.trim(), email: email.trim().toLowerCase() } };
    },
  },
};

// — documentation schemas: the same SerializeSchema DSL feeds the OpenAPI
// document (via meta) and the generated client's response types. —

const userSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    email: { type: 'string' },
  },
  required: ['id', 'name', 'email'],
} as const satisfies SerializeSchema;

const newUserBody = {
  type: 'object',
  properties: { name: { type: 'string' }, email: { type: 'string' } },
  required: ['name', 'email'],
} as const satisfies SerializeSchema;

const errorEnvelope = {
  type: 'object',
  properties: { error: { type: 'string' } },
  required: ['error'],
} as const satisfies SerializeSchema;

/** Shared response declarations — the error branches the handlers throw. */
const notFound = { description: 'no such user', schema: errorEnvelope } as const;
const conflict = { description: 'email already in use', schema: errorEnvelope } as const;
const invalid = { description: 'validation failed', schema: errorEnvelope } as const;

/** The store — plain data, lives as long as the process does. */
const users = new Map<number, User>();
let nextId = 1;

/** Route params arrive as strings; a non-integer addresses no user. */
const findUser = (raw: string): User => {
  const id = Number(raw);
  const user = Number.isInteger(id) ? users.get(id) : undefined;
  if (user === undefined) {
    throw httpError(404, `No user ${raw}`);
  }
  return user;
};

const findByEmail = (email: string): User | undefined =>
  [...users.values()].find((user) => user.email === email);

export const app = createApp();

// The app-level annotation — `openapiJson` reads it as the info block.
describeApp(app, {
  title: 'Users API',
  version: '1.0.0',
  description: 'crud-openapi example — the route table is the spec.',
});

// — the resource, registration + annotation side by side —

get(app, '/users', (ctx) => json(ctx, [...users.values()]));
describeRoute(app, 'GET', '/users', {
  summary: 'List users',
  tags: ['users'],
  responses: {
    200: { description: 'all users', schema: { type: 'array', items: userSchema } },
  },
} satisfies RouteMeta);

post(app, '/users', jsonBody(newUserSchema), (ctx) => {
  const input = ctx.state.validated as NewUser;
  if (findByEmail(input.email) !== undefined) {
    throw httpError(409, `Email ${input.email} is already in use`);
  }
  const user: User = { id: nextId++, ...input };
  users.set(user.id, user);
  return json(ctx, user, { status: 201 });
});
describeRoute(app, 'POST', '/users', {
  summary: 'Create a user',
  tags: ['users'],
  body: newUserBody,
  responses: {
    201: { description: 'created', schema: userSchema },
    409: conflict,
    422: invalid,
  },
} satisfies RouteMeta);

get(app, '/users/:id', (ctx) => json(ctx, findUser(ctx.params.id ?? '')));
describeRoute(app, 'GET', '/users/:id', {
  summary: 'Fetch one user',
  tags: ['users'],
  responses: {
    200: { description: 'the user', schema: userSchema },
    404: notFound,
  },
} satisfies RouteMeta);

put(app, '/users/:id', jsonBody(newUserSchema), (ctx) => {
  const user = findUser(ctx.params.id ?? '');
  const input = ctx.state.validated as NewUser;
  const owner = findByEmail(input.email);
  if (owner !== undefined && owner.id !== user.id) {
    throw httpError(409, `Email ${input.email} is already in use`);
  }
  const updated: User = { ...user, ...input };
  users.set(user.id, updated);
  return json(ctx, updated);
});
describeRoute(app, 'PUT', '/users/:id', {
  summary: 'Replace a user',
  tags: ['users'],
  body: newUserBody,
  responses: {
    200: { description: 'the updated user', schema: userSchema },
    404: notFound,
    409: conflict,
    422: invalid,
  },
} satisfies RouteMeta);

del(app, '/users/:id', (ctx) => {
  const user = findUser(ctx.params.id ?? '');
  users.delete(user.id);
  return send(ctx, null, { status: 204 });
});
describeRoute(app, 'DELETE', '/users/:id', {
  summary: 'Delete a user',
  tags: ['users'],
  responses: {
    204: { description: 'deleted' },
    404: notFound,
  },
} satisfies RouteMeta);

// — the docs pair, served from the same table —

get(app, '/openapi.json', (ctx) => openapiJson(ctx, app));
describeRoute(app, 'GET', '/openapi.json', {
  summary: 'The OpenAPI 3.1 document',
  tags: ['docs'],
  responses: { 200: { description: 'the spec derived from the route table' } },
} satisfies RouteMeta);

get(app, '/docs', (ctx) => swaggerUi(ctx, { url: '/openapi.json', title: 'Users API' }));
describeRoute(app, 'GET', '/docs', {
  summary: 'API reference (Scalar)',
  tags: ['docs'],
  responses: { 200: { description: 'HTML documentation page' } },
} satisfies RouteMeta);

export async function main(): Promise<void> {
  const server = await serve(app, { port: Number(process.env.PORT ?? 3000) });
  console.log(`listening on ${server.url}`);
}

// Serve only when executed directly (`node app.ts`), not when smoke.ts
// imports the app to drive it in-process.
const entry =
  process.argv[1] === undefined
    ? undefined
    : pathToFileURL(realpathSync(process.argv[1])).href;
if (entry === import.meta.url) {
  await main();
}
