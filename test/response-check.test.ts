import type { SchemaIssue, SerializeSchema } from '../src/serialize';

import { describe, it } from 'vitest';

import { createApp, get, handle, use } from '../src/app';
import { describeRoute } from '../src/meta';
import { withRouteValidation } from '../src/openapi';
import { json, text } from '../src/respond';
import { responseCheck } from '../src/response-check';
import { checkSchema } from '../src/serialize';
import { stream } from '../src/streaming';

const userSchema: SerializeSchema = {
  type: 'object',
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    nick: { type: 'string', nullable: true },
    tags: { type: 'array', items: { type: 'string' } },
    address: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  },
  required: ['id', 'name'],
};

/** The app under check: one annotated route returning `body`. */
function checkedApp(
  body: unknown,
  options?: Parameters<typeof responseCheck>[1]
) {
  const app = createApp();
  use(app, responseCheck(app, options));
  get(app, '/user', (ctx) => json(ctx, body));
  describeRoute(app, 'GET', '/user', {
    responses: { 200: { description: 'ok', schema: userSchema } },
  });
  return app;
}

describe('checkSchema', () => {
  const goodUser = {
    id: 7,
    name: 'ada',
    nick: null,
    tags: ['x'],
    address: { city: 'london' },
  };

  it('accepts conforming data, nullable null included', () => {
    checkSchema(userSchema, goodUser).should.deep.equal([]);
  });

  it('reports a type mismatch at the offending path', () => {
    checkSchema(userSchema, { ...goodUser, id: 'x' }).should.deep.equal([
      { path: ['id'], message: 'expected integer, got string' },
    ]);
  });

  it('reports a missing required key at its own path', () => {
    checkSchema(userSchema, { id: 7, tags: [] }).should.deep.equal([
      { path: ['name'], message: 'required' },
    ]);
  });

  it('treats extra keys as violations — the closed shape', () => {
    checkSchema(userSchema, { ...goodUser, secret: true }).should.deep.equal([
      { path: ['secret'], message: 'undeclared key' },
    ]);
  });

  it('recurses into arrays and nested objects', () => {
    checkSchema(userSchema, {
      ...goodUser,
      tags: ['x', 2],
      address: {},
    }).should.deep.equal([
      { path: ['tags', 1], message: 'expected string, got number' },
      { path: ['address', 'city'], message: 'required' },
    ]);
  });

  it('reports a root type error with an empty path', () => {
    checkSchema(userSchema, 'nope').should.deep.equal([
      { path: [], message: 'expected object, got string' },
    ]);
    checkSchema({ type: 'array', items: { type: 'integer' } }, 3).should.deep.equal([
      { path: [], message: 'expected array, got number' },
    ]);
  });

  it('integer demands integrality; number accepts any finite', () => {
    checkSchema({ type: 'integer' }, 3.5).should.deep.equal([
      { path: [], message: 'expected integer, got number' },
    ]);
    checkSchema({ type: 'integer' }, 3).should.deep.equal([]);
    checkSchema({ type: 'number' }, 3.5).should.deep.equal([]);
  });

  it('nullable admits null where declared and rejects it elsewhere', () => {
    checkSchema({ type: 'string', nullable: true }, null).should.deep.equal([]);
    checkSchema({ type: 'string' }, null).should.deep.equal([
      { path: [], message: 'expected string, got null' },
    ]);
    // A `null`-typed schema rejects everything but null.
    checkSchema({ type: 'null' }, 0).should.deep.equal([
      { path: [], message: 'expected null, got number' },
    ]);
    checkSchema({ type: 'null' }, null).should.deep.equal([]);
  });
});

describe('ctx.route', () => {
  it('is the registered route object by reference, undefined on fallbacks', async () => {
    const app = createApp();
    const seen: (unknown | undefined)[] = [];
    use(app, (ctx, next) => {
      seen.push(ctx.route);
      return next();
    });
    get(app, '/', (ctx) => json(ctx, { ok: true }));
    (await handle(app, new Request('http://localhost/'))).status.should.equal(200);
    // Matched: the very object in the route table.
    (seen[0] === app.routes[0]).should.be.true;
    // Unmatched path: the 404 fallback, no route.
    (await handle(app, new Request('http://localhost/missing'))).status.should.equal(404);
    (seen[1] === undefined).should.be.true;
    // Matched path, unmatched method: the 405 fallback, no route either.
    (
      await handle(app, new Request('http://localhost/', { method: 'POST' }))
    ).status.should.equal(405);
    (seen[2] === undefined).should.be.true;
  });
});

describe('responseCheck', () => {
  it('passes a conforming 200 through byte-identical', async () => {
    const body = { id: 7, name: 'ada', tags: [] };
    const res = await handle(checkedApp(body), new Request('http://localhost/user'));
    res.status.should.equal(200);
    (await res.text()).should.equal(JSON.stringify(body));
    res.headers.get('content-type')!.should.equal('application/json');
    res.headers
      .get('content-length')!
      .should.equal(String(JSON.stringify(body).length));
  });

  it('fails a type mismatch with a bare 500 (default mode)', async () => {
    const res = await handle(
      checkedApp({ id: 'x', name: 'ada' }),
      new Request('http://localhost/user')
    );
    res.status.should.equal(500);
    (await res.json()).should.deep.equal({ error: 'Response schema mismatch' });
  });

  it('fails a missing-required and an extra-key response alike', async () => {
    (
      await handle(checkedApp({ id: 1 }), new Request('http://localhost/user'))
    ).status.should.equal(500);
    (
      await handle(
        checkedApp({ id: 1, name: 'a', debug: true }),
        new Request('http://localhost/user')
      )
    ).status.should.equal(500);
  });

  it('details: true attaches the issue paths to the 500 body', async () => {
    const res = await handle(
      checkedApp({ id: 'x', name: 'ada' }, { details: true }),
      new Request('http://localhost/user')
    );
    res.status.should.equal(500);
    const body = (await res.json()) as {
      error: string;
      issues: { path: string; message: string }[];
    };
    body.error.should.equal('Response schema mismatch');
    body.issues.should.deep.equal([
      { path: 'id', message: 'expected integer, got string' },
    ]);
  });

  it('report mode keeps the response and hands the issues to onIssue', async () => {
    const reported: (readonly SchemaIssue[])[] = [];
    const body = { id: 7, name: 'ada', oops: 1 };
    const res = await handle(
      checkedApp(body, {
        onMismatch: 'report',
        onIssue: (issues, ctx) => {
          reported.push(issues);
          ctx.req.method.should.equal('GET');
        },
      }),
      new Request('http://localhost/user')
    );
    // The response survives, body intact.
    res.status.should.equal(200);
    (await res.json()).should.deep.equal(body);
    reported.should.have.lengthOf(1);
    reported[0]!.should.deep.equal([{ path: ['oops'], message: 'undeclared key' }]);
  });

  it('skips routes without a response annotation', async () => {
    const app = createApp();
    use(app, responseCheck(app));
    get(app, '/wild', (ctx) => json(ctx, { anything: 'goes' }));
    const res = await handle(app, new Request('http://localhost/wild'));
    res.status.should.equal(200);
    (await res.json()).should.deep.equal({ anything: 'goes' });
  });

  it('skips statuses the annotation does not declare', async () => {
    const app = createApp();
    use(app, responseCheck(app));
    get(app, '/user', (ctx) => json(ctx, { id: 'x' }, { status: 201 }));
    describeRoute(app, 'GET', '/user', {
      responses: { 200: { description: 'ok', schema: userSchema } },
    });
    const res = await handle(app, new Request('http://localhost/user'));
    res.status.should.equal(201);
    (await res.json()).should.deep.equal({ id: 'x' });
  });

  it('skips the 404 fallback — no route ran', async () => {
    const app = createApp();
    use(app, responseCheck(app));
    get(app, '/user', (ctx) => json(ctx, { id: 1, name: 'a' }));
    describeRoute(app, 'GET', '/user', {
      responses: { 200: { description: 'ok', schema: userSchema } },
    });
    (await handle(app, new Request('http://localhost/nope'))).status.should.equal(404);
  });

  it('skips non-JSON content types', async () => {
    const app = createApp();
    use(app, responseCheck(app));
    get(app, '/user', (ctx) => text(ctx, 'name: ada'));
    describeRoute(app, 'GET', '/user', {
      responses: { 200: { description: 'ok', schema: userSchema } },
    });
    const res = await handle(app, new Request('http://localhost/user'));
    res.status.should.equal(200);
    (await res.text()).should.equal('name: ada');
  });

  it('skips streamed bodies — never buffered, JSON or not', async () => {
    const app = createApp();
    use(app, responseCheck(app));
    get(app, '/log', (ctx) =>
      stream(
        ctx,
        async (w) => {
          await w.write('{"id": "not an integer"}');
          w.close();
        },
        { headers: { 'content-type': 'application/json' } }
      )
    );
    describeRoute(app, 'GET', '/log', {
      responses: { 200: { description: 'ok', schema: userSchema } },
    });
    const res = await handle(app, new Request('http://localhost/log'));
    res.status.should.equal(200);
    (await res.text()).should.equal('{"id": "not an integer"}');
  });

  it('treats an unparseable JSON body as a root mismatch', async () => {
    const app = createApp();
    use(app, responseCheck(app, { details: true }));
    get(app, '/user', (ctx) =>
      text(ctx, 'name: ada', { headers: { 'content-type': 'application/json' } })
    );
    describeRoute(app, 'GET', '/user', {
      responses: { 200: { description: 'ok', schema: userSchema } },
    });
    const res = await handle(app, new Request('http://localhost/user'));
    res.status.should.equal(500);
    const body = (await res.json()) as { issues: { path: string; message: string }[] };
    body.issues.should.deep.equal([{ path: '', message: 'invalid JSON body' }]);
  });

  it('reads the live route across withRouteValidation rebuilds', async () => {
    const app = createApp();
    use(app, responseCheck(app));
    get(app, '/user', (ctx) =>
      ctx.query.get('bad') === null
        ? json(ctx, { id: 1, name: 'ada' })
        : json(ctx, { id: 'x' })
    );
    describeRoute(app, 'GET', '/user', {
      query: { bad: { type: 'string' } },
      responses: { 200: { description: 'ok', schema: userSchema } },
    });
    // Rebuilds the annotated route (this one) and re-attaches the meta —
    // ctx.route is the rebuilt object, and the lookup still finds it.
    withRouteValidation(app);
    (await handle(app, new Request('http://localhost/user'))).status.should.equal(200);
    (
      await handle(app, new Request('http://localhost/user?bad=1'))
    ).status.should.equal(500);
  });
});
