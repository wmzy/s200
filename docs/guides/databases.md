# Databases

s200 has no database layer and wants none — a database is a value your handlers close over or read off `ctx.state`, and the pieces that do care (drain, readiness, cancellation) are already batteries. This guide is the wiring pattern, not an ORM integration; the working precedents are [`examples/db-crud`](https://github.com/wmzy/s200/tree/main/examples/db-crud) (SQLite through `node:sqlite`, zero npm dependencies) and the Redis recipes (below).

## The pool is state, injected once

Create the pool at module scope, inject it as typed state so handlers read `ctx.state.db` instead of importing a global. `withState` brands the slot — downstream middlewares and handlers see the key typed, no global merge, no `declare module`:

```ts
import { createApp, get, withState } from 's200';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const withDb = withState<{ db: Pool }>(async (ctx, next) => {
  ctx.state.db = pool;                 // one write, before anything below runs
  await next();
});

const app = createApp();
use(app, withDb);

get(app, '/users/:id', async (ctx) => {
  const { rows } = await ctx.state.db.query('select id, name from users where id = $1', [ctx.params.id]);
  return json(ctx, rows[0] ?? null);
});
```

For a per-app shape instead, `createApp<{ db: Pool }>()` types the same slot without the injector. Either way the pool is constructed once per process — never per request — and the app is still plain data: tests inject a second app wired to a throwaway database by calling the same factory.

## Close connections on drain

`lifecycle` owns shutdown ordering: readiness flips off first (the load balancer stops routing), then listening stops, then in-flight requests get their budget — and only then your cleanup hooks run. Closing the pool belongs in `onShutdown`, after the last query has finished:

```ts
import { serve } from 's200/node';
import { lifecycle } from 's200/lifecycle';
import { createGate, readiness } from 's200/health';

const gate = createGate();
get(app, '/health/ready', readiness({ db: () => pool.query('select 1'), drain: gate.check }));

const server = await serve(app, { port: 3000 });
const done = lifecycle(server, {
  readiness: gate,
  onShutdown: async () => { await pool.end(); },
});
await done.stopped;
```

The same `pool.query('select 1')` check answers readiness probes the rest of the time: any check that throws or rejects turns the response into a `503` naming the reason, and each check races its own budget (default 1000 ms) — so a wedged database fails the probe instead of hanging it.

## Hand queries the request's signal

`ctx.signal` fires when the client disconnects. Drivers that accept an `AbortSignal` (node-postgres takes `signal` in its query config) should get it — a disconnected caller stops paying for a query nobody will read:

```ts
get(app, '/users/:id', async (ctx) => {
  const { rows } = await ctx.state.db.query({
    text: 'select id, name, email from users where id = $1',
    values: [ctx.params.id],
    signal: ctx.signal,               // aborts with the connection
  });
  if (rows.length === 0) throw httpError(404, `No user ${ctx.params.id}`);
  return json(ctx, rows[0]);
});
```

The `timeout` battery composes the same way on the other side: it narrows `ctx.signal` by its deadline and answers 503 when the chain loses the race.

## Transactions are a helper, not a framework feature

There is nothing to integrate: a transaction is a function that checks out a client, runs BEGIN/COMMIT/ROLLBACK, and hands your callback the client. Map its failures to HTTP facts at the edge:

```ts
export async function withTransaction<T>(
  db: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

post(app, '/users', jsonBody(parseUser), async (ctx) => {
  try {
    return json(ctx, await withTransaction(ctx.state.db, async (tx) => {
      const { rows } = await tx.query('insert into users (name, email) values ($1, $2) returning *',
        [ctx.state.validated.name, ctx.state.validated.email]);
      await tx.query('insert into audit_log (what) values ($1)', ['user_created']);
      return rows[0];
    }), { status: 201 });
  } catch (error) {
    if (isUniqueViolation(error)) throw httpError(409, 'email already registered');
    throw error;                      // the error boundary maps the rest
  }
});
```

`examples/db-crud` runs this exact shape: a missing row is `httpError` 404, a UNIQUE violation is 409 Conflict, and the handler is the only place database facts become HTTP facts.

## Distributed stores

When the state lives behind Redis (rate-limit counters, sessions shared across a fleet), the batteries' `store` seams take a vendored adapter — see [Distributed stores](/guides/distributed-stores) and the recipes in [`recipes/redis-stores.ts`](https://github.com/wmzy/s200/blob/main/recipes/redis-stores.ts): four structurally-typed Redis commands in, exactly the `RateLimitStore`/`SessionStore` interface the matching battery injects, out.
