import type { ClientInit, ClientResponse } from '../src/client';
import type { HttpError } from '../src/errors';

import { describe, expectTypeOf, it } from 'vitest';

import { createApp, get, handle, post } from '../src/app';
import { createClient } from '../src/client';
import { httpError, isHttpError } from '../src/errors';
import { json } from '../src/respond';
import {
  jsonBody,
  validate,
  standardValidate,
  type OutputOf,
  type StandardSchema,
  type StandardSchemaV1,
} from '../src/validate';

describe('validate', function () {
  it('stores the parsed value on ctx.state under the default key', async function () {
    const app = createApp();
    get(
      app,
      '/x',
      validate((ctx) => `seen:${ctx.req.url}`),
      (ctx) => new Response(String(ctx.state.validated))
    );
    const res = await handle(app, new Request('http://localhost/x'));
    (await res.text()).should.equal('seen:http://localhost/x');
  });

  it('honors a custom state key', async function () {
    const app = createApp();
    get(
      app,
      '/x',
      validate((ctx) => ctx.req.headers.get('x-id'), { key: 'id' }),
      (ctx) => new Response(String(ctx.state.id))
    );
    const res = await handle(
      app,
      new Request('http://localhost/x', { headers: { 'x-id': '42' } })
    );
    (await res.text()).should.equal('42');
  });

  it('lets parse failures reject the chain into the error path', async function () {
    const app = createApp();
    get(
      app,
      '/x',
      validate(() => {
        throw httpError(422, 'nope');
      }),
      () => new Response('unreached')
    );
    const res = await handle(app, new Request('http://localhost/x'));
    res.status.should.equal(422);
    (await res.json()).should.deep.equal({ error: 'nope' });
  });
});

describe('jsonBody', function () {
  it('parses the cached body and validates the raw JSON value', async function () {
    const app = createApp();
    post(
      app,
      '/echo',
      jsonBody((data) => {
        if (typeof data !== 'object' || data === null || !('name' in data)) {
          throw httpError(422, 'shape');
        }
        return data.name as string;
      }),
      (ctx) => new Response(String(ctx.state.validated))
    );
    const res = await handle(
      app,
      new Request('http://localhost/echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'alice' }),
      })
    );
    (await res.text()).should.equal('alice');
  });

  it('maps invalid JSON to the 400 HttpError from readJson', async function () {
    const app = createApp();
    post(
      app,
      '/x',
      jsonBody((data) => data),
      () => new Response('unreached')
    );
    const res = await handle(
      app,
      new Request('http://localhost/x', { method: 'POST', body: '{broken' })
    );
    res.status.should.equal(400);
    (await res.json()).should.deep.equal({ error: 'Invalid JSON body' });
  });
});

// ---- Standard Schema (the `~standard` vendor shape) ----

/** The output the fake schema tags onto accepted values. */
type UserOut = { readonly name: string; readonly id: number };

/** Hand-rolled standard schema: accepts `{ name: string }`, tags an id —
 * input and output differ, which is exactly the case the client's `in`
 * channel exists for. */
const userSchema: StandardSchemaV1 & {
  readonly types?: {
    readonly input: { readonly name: string };
    readonly output: UserOut;
  };
} = {
  '~standard': {
    version: 1,
    vendor: 's200-test',
    validate: (value) => {
      const name =
        typeof value === 'object' && value !== null
          ? (value as { name?: unknown }).name
          : undefined;
      if (typeof name !== 'string') {
        return { issues: [{ message: 'expected name string', path: ['name'] }] };
      }
      return { value: { name, id: 7 } };
    },
  },
};

/** Issues-only schema: every value fails with a path-carrying issue. */
const pickySchema: StandardSchema = {
  '~standard': {
    version: 1,
    vendor: 's200-test',
    validate: () => ({ issues: [{ message: 'page out of range', path: ['page'] }] }),
  },
};

/** Empty-issues schema: `{ issues: [] }` is a success, not a failure. */
const emptyIssuesSchema: StandardSchema<string> = {
  '~standard': {
    version: 1,
    vendor: 's200-test',
    validate: () => ({ issues: [], value: 'ok' }),
  },
};

describe('jsonBody with a Standard Schema', function () {
  it('stores the schema output on ctx.state.validated', async function () {
    const app = createApp();
    post(
      app,
      '/x',
      jsonBody(userSchema),
      (ctx) => json(ctx, ctx.state.validated)
    );
    const res = await handle(
      app,
      new Request('http://localhost/x', {
        method: 'POST',
        body: JSON.stringify({ name: 'ada' }),
      })
    );
    res.status.should.equal(200);
    (await res.json()).should.deep.equal({ name: 'ada', id: 7 });
  });

  it('honors a custom state key', async function () {
    const app = createApp();
    post(
      app,
      '/x',
      jsonBody(userSchema, { key: 'body' }),
      (ctx) => json(ctx, ctx.state.body)
    );
    const res = await handle(
      app,
      new Request('http://localhost/x', {
        method: 'POST',
        body: JSON.stringify({ name: 'bob' }),
      })
    );
    res.status.should.equal(200);
    (await res.json()).should.deep.equal({ name: 'bob', id: 7 });
  });

  it('maps the first issue to a 422 HttpError with its message', async function () {
    const app = createApp();
    post(app, '/x', jsonBody(userSchema), () => new Response('unreached'));
    const res = await handle(
      app,
      new Request('http://localhost/x', {
        method: 'POST',
        body: JSON.stringify({ name: 42 }),
      })
    );
    res.status.should.equal(422);
    (await res.json()).should.deep.equal({ error: 'expected name string' });
  });

  it('still answers invalid JSON with the 400 from readJson', async function () {
    const app = createApp();
    post(app, '/x', jsonBody(userSchema), () => new Response('unreached'));
    const res = await handle(
      app,
      new Request('http://localhost/x', { method: 'POST', body: '{nope' })
    );
    res.status.should.equal(400);
  });

  it('treats an empty issues array as success and stores the value', async function () {
    const app = createApp();
    post(
      app,
      '/x',
      jsonBody(emptyIssuesSchema),
      (ctx) => new Response(String(ctx.state.validated))
    );
    const res = await handle(
      app,
      new Request('http://localhost/x', { method: 'POST', body: 'null' })
    );
    res.status.should.equal(200);
    (await res.text()).should.equal('ok');
  });

  it('types the client body from the schema input (not its output)', function () {
    const app = createApp();
    const full = post(
      app,
      '/users',
      jsonBody(userSchema),
      (ctx) => json(ctx, { ok: ctx.state.validated !== undefined })
    );
    // Stubbed fetch: the compile-time assertions below must not hit the network.
    const client = createClient(full, { fetch: async () => new Response('ok') });

    expectTypeOf<typeof client.post>().toExtend<
      (
        path: '/users',
        init: Omit<ClientInit, 'body'> & { body: { readonly name: string } }
      ) => Promise<ClientResponse<{ ok: boolean }>>
    >();
    void client.post('/users', { body: { name: 'ada' } });
    // @ts-expect-error -- id is the schema's OUTPUT side; callers send name only
    void client.post('/users', { body: { name: 'ada', id: 7 } });
  });
});

describe('standardValidate', function () {
  it('returns the parsed value on success', function () {
    // The cast is the assertion seam: the adapter's return is `unknown`.
    (standardValidate(userSchema, { name: 'ada' }) as UserOut).should.deep.equal({
      name: 'ada',
      id: 7,
    });
  });

  it('throws a 422 HttpError carrying the first issue message', function () {
    let thrown: unknown;
    try {
      standardValidate(pickySchema, { page: 999 });
    } catch (error) {
      thrown = error;
    }
    isHttpError(thrown).should.be.true;
    (thrown as HttpError).status.should.equal(422);
    (thrown as HttpError).message.should.equal('page out of range');
  });

  it('passes an empty issues array through as success', function () {
    (standardValidate(emptyIssuesSchema, 'anything') as string).should.equal('ok');
  });
});

describe('OutputOf', function () {
  it('infers the output from the phantom types prop', function () {
    expectTypeOf<OutputOf<typeof userSchema>>().toEqualTypeOf<UserOut>();
  });

  it('falls back to unknown for types-less schemas', function () {
    expectTypeOf<OutputOf<typeof pickySchema>>().toEqualTypeOf<unknown>();
  });
});
