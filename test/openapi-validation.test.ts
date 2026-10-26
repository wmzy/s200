
import type { SerializeSchema } from '../src/serialize';

import type { App } from '../src/app';

import { describe, it } from 'vitest';

import { createApp, get, mount, post, use } from '../src/app';
import { readJson } from '../src/body';
import { describeRoute } from '../src/meta';
import { openapiSpec, withRouteValidation } from '../src/openapi';
import { parseQuery } from '../src/query';
import { json } from '../src/respond';
import { compileValidator } from '../src/serialize';
import { request } from '../src/test';

// The one annotation shared by the gate and the spec assertions below —
// the same object drives both, proving the single source of truth.
const userBody: SerializeSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    age: { type: 'integer' },
    nickname: { type: 'string', nullable: true },
    tags: { type: 'array', items: { type: 'string' } },
    address: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  },
  required: ['name', 'age', 'tags', 'address'],
};

const goodUser = {
  name: 'ada',
  age: 36,
  nickname: null,
  tags: ['admin', 'dev'],
  address: { city: 'Oslo' },
};

/** POST /users described with `userBody`, then transformed. The handler
 * re-reads the JSON itself — the gate must leave the value untouched. */
function userApp() {
  const app = post(createApp(), '/users', async (ctx) =>
    json(ctx, await readJson(ctx))
  );
  describeRoute(app, 'POST', '/users', { body: userBody });
  return withRouteValidation(app);
}

async function postUser(app: App, body: unknown): Promise<Response> {
  return request(app, '/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function errorOf(res: Response): Promise<string> {
  return ((await res.json()) as { error: string }).error;
}

describe('compileValidator', () => {
  it('collects every issue with dot-joined paths in traversal order', () => {
    const issues = compileValidator(userBody)({
      age: 'x',
      tags: ['a', 1],
      address: {},
    });
    issues
      .map((issue) => issue.path)
      .should.deep.equal(['name', 'age', 'tags.1', 'address.city']);
    issues.map((issue) => issue.message).should.contain('required');
    issues
      .map((issue) => issue.message)
      .should.contain('expected integer, got string');
  });

  it('returns an empty list for conforming data and reports at the root', () => {
    const validate = compileValidator(userBody);
    validate(goodUser).length.should.equal(0);
    // Extra keys are ignored — the serializer's drop-undeclared contract.
    validate({ ...goodUser, extra: true }).length.should.equal(0);
    const root = validate([]);
    root.length.should.equal(1);
    root[0]?.path.should.equal('');
    root[0]?.message.should.equal('expected object, got array');
  });

  it('admits null only where nullable, and rejects non-finite numbers', () => {
    const validate = compileValidator(userBody);
    validate({ ...goodUser, name: null }).should.deep.equal([
      { path: 'name', message: 'expected string, got null' },
    ]);
    // 1e999 parses to Infinity — a number the declared shape cannot carry.
    validate(JSON.parse('{"name":"a","age":1e999,"tags":[],"address":{"city":"x"}}')).should.deep.equal([
      { path: 'age', message: 'expected integer, got number' },
    ]);
  });
});

describe('withRouteValidation (body)', () => {
  it('admits a conforming body untouched, nullable null and extra keys included', async () => {
    const res = await postUser(userApp(), {
      ...goodUser,
      extra: 'the schema never declared this',
    });
    res.status.should.equal(200);
    (await res.json()).should.deep.equal({
      ...goodUser,
      extra: 'the schema never declared this',
    });
  });

  it('rejects a missing required property with its path', async () => {
    const res = await postUser(userApp(), {
      age: 1,
      tags: [],
      address: { city: 'x' },
    });
    res.status.should.equal(422);
    (await errorOf(res)).should.contain('body.name');
  });

  it('carries every issue in the body, paths scope-qualified', async () => {
    const res = await postUser(userApp(), {
      tags: [1],
      address: { city: 'x' },
    });
    res.status.should.equal(422);
    (await res.json()).should.deep.equal({
      error: 'body.name: required',
      issues: [
        { path: 'body.name', message: 'required' },
        { path: 'body.age', message: 'required' },
        { path: 'body.tags.0', message: 'expected string, got number' },
      ],
    });
  });

  it('names nested required paths and array item indices', async () => {
    const nested = await postUser(userApp(), {
      name: 'a',
      age: 1,
      tags: [],
      address: {},
    });
    nested.status.should.equal(422);
    (await errorOf(nested)).should.contain('body.address.city');

    const item = await postUser(userApp(), {
      ...goodUser,
      tags: ['a', 1],
    });
    item.status.should.equal(422);
    (await errorOf(item)).should.contain('body.tags.1');
  });

  it('rejects type mismatches, non-integer numbers, and non-object roots', async () => {
    (await postUser(userApp(), { ...goodUser, age: 'x' })).status.should.equal(422);
    (await errorOf(await postUser(userApp(), { ...goodUser, age: 'x' }))).should.contain(
      'body.age'
    );
    (await postUser(userApp(), { ...goodUser, age: 2.5 })).status.should.equal(422);
    const root = await postUser(userApp(), [1, 2]);
    root.status.should.equal(422);
    (await errorOf(root)).should.contain('body: expected object');
  });

  it('surfaces readJson own 400 for a non-JSON body', async () => {
    const res = await postUser(userApp(), 'not json');
    res.status.should.equal(400);
    (await errorOf(res)).should.contain('Invalid JSON body');
  });
});

describe('withRouteValidation (query)', () => {
  function searchApp() {
    const app = get(createApp(), '/search', (ctx) =>
      json(ctx, { tag: parseQuery(ctx).tag })
    );
    describeRoute(app, 'GET', '/search', {
      query: {
        tag: { type: 'array', items: { type: 'string' } },
        mode: { type: 'string' },
        page: { type: 'integer' },
      },
    });
    return withRouteValidation(app);
  }

  it('checks each annotated key; absent keys pass', async () => {
    const app = searchApp();
    (await request(app, '/search')).status.should.equal(200);
    const repeated = await request(app, '/search?tag=a&tag=b');
    repeated.status.should.equal(200);
    (await repeated.json()).should.deep.equal({ tag: ['a', 'b'] });
  });

  it('reports the key-qualified path for a bad value', async () => {
    const app = searchApp();
    const single = await request(app, '/search?tag=a');
    single.status.should.equal(422);
    (await errorOf(single)).should.contain('query.tag');

    const mode = await request(app, '/search?mode=x&mode=y');
    mode.status.should.equal(422);
    (await errorOf(mode)).should.contain('query.mode');
  });

  it('sees query values verbatim — the string domain, no coercion', async () => {
    const res = await request(searchApp(), '/search?page=2');
    res.status.should.equal(422);
    (await errorOf(res)).should.contain(
      'query.page: expected integer, got string'
    );
  });
});

describe('withRouteValidation (required query)', () => {
  /** `/report` with a required `format` and an optional `verbose`. */
  function reportApp() {
    const app = get(createApp(), '/report', (ctx) =>
      json(ctx, { format: parseQuery(ctx).format })
    );
    describeRoute(app, 'GET', '/report', {
      query: {
        format: { schema: { type: 'string' }, required: true },
        verbose: { type: 'boolean' },
      },
    });
    return withRouteValidation(app);
  }

  it('answers a missing required key with 422 and the validationError body', async () => {
    const res = await request(reportApp(), '/report');
    res.status.should.equal(422);
    (await res.json()).should.deep.equal({
      error: 'query.format: required',
      issues: [{ path: 'query.format', message: 'required' }],
    });
  });

  it('checks every required key before the chain continues', async () => {
    const res = await request(reportApp(), '/report?verbose=true');
    res.status.should.equal(422);
    (await errorOf(res)).should.contain('query.format: required');
  });

  it('passes a present required key; absent optional keys still pass', async () => {
    const res = await request(reportApp(), '/report?format=csv');
    res.status.should.equal(200);
    (await res.json()).should.deep.equal({ format: 'csv' });
  });

  it('treats an empty value as present — only the absence is required', async () => {
    const res = await request(reportApp(), '/report?format=');
    res.status.should.equal(200);
    (await res.json()).should.deep.equal({ format: '' });
  });

  it('still type-checks a present required key like any other', async () => {
    // `format` passes; `verbose` fails its boolean check — the marker
    // only decides absence, the schema still owns the value.
    const res = await request(reportApp(), '/report?format=csv&verbose=maybe');
    res.status.should.equal(422);
    (await errorOf(res)).should.contain('query.verbose');
  });

  it('emits parameters[].required isomorphic to the gate', () => {
    const spec = openapiSpec(reportApp(), { title: 't', version: '1' });
    const parameters = (
      spec.paths['/report']?.get as {
        parameters: { name: string; in: string; required: boolean }[];
      }
    ).parameters;
    parameters.find((p) => p.in === 'query' && p.name === 'format')?.required.should.equal(
      true
    );
    parameters.find((p) => p.in === 'query' && p.name === 'verbose')?.required.should.equal(
      false
    );
  });
});

describe('withRouteValidation (params)', () => {
  /** `/users/:uid` with an integer-typed `uid` annotation (path params
   * live in the string domain, so the annotation is the gate's to
   * satisfy) and `/files/:name?` with the required-marker form. */
  function paramsApp() {
    const app = get(createApp(), '/users/:uid', (ctx) =>
      json(ctx, { uid: ctx.params.uid })
    );
    get(app, '/files/:name?', (ctx) => json(ctx, { name: ctx.params.name ?? null }));
    describeRoute(app, 'GET', '/users/:uid', {
      params: { uid: { type: 'integer' } },
    });
    describeRoute(app, 'GET', '/files/:name?', {
      params: { name: { schema: { type: 'string' }, required: true } },
    });
    return withRouteValidation(app);
  }

  it('checks the captured value against the annotated schema', async () => {
    const res = await request(paramsApp(), '/users/abc');
    res.status.should.equal(422);
    (await errorOf(res)).should.contain('params.uid: expected integer, got string');
  });

  it('sees params verbatim — the string domain, no coercion', async () => {
    // Even a digit string stays a string: annotate string shapes, or gate
    // with `s200/validate`'s validateParams when you want coercion.
    const res = await request(paramsApp(), '/users/7');
    res.status.should.equal(422);
    (await errorOf(res)).should.contain('params.uid: expected integer, got string');
  });

  it('answers an optional segment\'s absence with 422 when marked required', async () => {
    const res = await request(paramsApp(), '/files');
    res.status.should.equal(422);
    (await res.json()).should.deep.equal({
      error: 'params.name: required',
      issues: [{ path: 'params.name', message: 'required' }],
    });
  });

  it('passes a present param and still checks its value', async () => {
    const res = await request(paramsApp(), '/files/a.txt');
    res.status.should.equal(200);
    (await res.json()).should.deep.equal({ name: 'a.txt' });
  });

  it('emits the parameter schema isomorphic to the gate', () => {
    const spec = openapiSpec(paramsApp(), { title: 't', version: '1' });
    const parameters = (
      spec.paths['/users/{uid}']?.get as {
        parameters: { name: string; in: string; schema: unknown }[];
      }
    ).parameters;
    const uid = parameters.find((p) => p.in === 'path' && p.name === 'uid')?.schema;
    (uid as Record<string, unknown>).should.deep.equal({ type: 'integer' });
  });
});

describe('withRouteValidation (transform semantics)', () => {
  it('keeps unannotated routes by reference — zero rebuild, zero gate', async () => {
    const app = createApp();
    post(app, '/plain', async (ctx) => json(ctx, await readJson(ctx)));
    const annotated = post(app, '/users', async (ctx) =>
      json(ctx, await readJson(ctx))
    );
    describeRoute(annotated, 'POST', '/users', { body: userBody });
    // The transform replaces `app.routes` in place (mount's family), so
    // the original annotated entry must be captured beforehand.
    const original = app.routes[1];
    const transformed = withRouteValidation(app);

    transformed.routes.length.should.equal(2);
    const [plain, gated] = transformed.routes;
    plain?.should.equal(app.routes[0]);
    gated?.should.not.equal(original);

    const res = await request(transformed, '/plain', {
      method: 'POST',
      body: JSON.stringify({ anything: 'goes' }),
    });
    res.status.should.equal(200);
    (await res.json()).should.deep.equal({ anything: 'goes' });
  });

  it('keeps app-level middlewares running around the gate', async () => {
    let seen = 0;
    const app = createApp();
    use(app, (_ctx, next) => {
      seen += 1;
      return next();
    });
    const annotated = post(app, '/users', async (ctx) =>
      json(ctx, await readJson(ctx))
    );
    describeRoute(annotated, 'POST', '/users', { body: userBody });
    withRouteValidation(app);

    await postUser(app, goodUser);
    await postUser(app, {});
    seen.should.equal(2);
  });

  it('keeps openapiSpec describing the same annotation after the transform', () => {
    const spec = openapiSpec(userApp(), { title: 't', version: '1' });
    const schema = spec.paths['/users']?.post as {
      requestBody: {
        content: {
          'application/json': {
            schema: { required: string[]; properties: Record<string, unknown> };
          };
        };
      };
    };
    schema.requestBody.content['application/json'].schema.required.should.deep.equal(
      ['name', 'age', 'tags', 'address']
    );
    schema.requestBody.content['application/json'].schema.properties.should.have.property(
      'nickname'
    );
  });

  it('gates mounted sub-app routes described on the parent', async () => {
    const sub = post(createApp(), '/users', async (ctx) =>
      json(ctx, await readJson(ctx))
    );
    const parent = mount(createApp(), '/v1', sub);
    describeRoute(parent, 'POST', '/v1/users', { body: userBody });
    withRouteValidation(parent);

    (
      await request(parent, '/v1/users', {
        method: 'POST',
        body: JSON.stringify(goodUser),
      })
    ).status.should.equal(200);
    const bad = await request(parent, '/v1/users', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    bad.status.should.equal(422);
    (await errorOf(bad)).should.contain('body.name');
  });

  it('does not carry annotations described on the sub before mount', async () => {
    const sub = post(createApp(), '/users', async (ctx) =>
      json(ctx, await readJson(ctx))
    );
    describeRoute(sub, 'POST', '/users', { body: userBody });
    const parent = withRouteValidation(mount(createApp(), '/v1', sub));
    // mount rebuilds route objects; the WeakMap keys did not travel —
    // describe after mount, on the app that dispatches.
    (await request(parent, '/v1/users', { method: 'POST', body: '{}' })).status.should.equal(
      200
    );
  });
});

describe('withRouteValidation (headers)', () => {
  /** `/report` with a required `x-trace-id` and an optional `x-verbose`. */
  function traceApp() {
    const app = get(createApp(), '/report', (ctx) =>
      json(ctx, { trace: ctx.req.headers.get('x-trace-id') })
    );
    describeRoute(app, 'GET', '/report', {
      headers: {
        'x-trace-id': { schema: { type: 'string' }, required: true },
        'x-verbose': { type: 'boolean' },
      },
    });
    return withRouteValidation(app);
  }

  it('checks present headers against their schema; absent optional headers pass', async () => {
    const app = traceApp();
    const ok = await request(app, '/report', { headers: { 'x-trace-id': 't-1' } });
    ok.status.should.equal(200);
    ((await ok.json()) as { trace: string }).trace.should.equal('t-1');

    // The marker only decides absence; the schema still owns the value.
    const bad = await request(app, '/report', {
      headers: { 'x-trace-id': 't-1', 'x-verbose': 'maybe' },
    });
    bad.status.should.equal(422);
    (await errorOf(bad)).should.contain('headers.x-verbose');
  });

  it('answers a missing required header with 422 and the validationError body', async () => {
    const bad = await request(traceApp(), '/report');
    bad.status.should.equal(422);
    (await bad.json()).should.deep.equal({
      error: 'headers.x-trace-id: required',
      issues: [{ path: 'headers.x-trace-id', message: 'required' }],
    });
  });

  it('matches header names case-insensitively — the platform rule', async () => {
    const res = await request(traceApp(), '/report', { headers: { 'X-Trace-Id': 't-2' } });
    res.status.should.equal(200);
    ((await res.json()) as { trace: string }).trace.should.equal('t-2');
  });

  it('rebuilds a route whose only annotation is headers', async () => {
    // A headers-only annotation must still get the gate — the transform
    // condition counts it.
    const app = get(createApp(), '/ping', (ctx) => json(ctx, { ok: true }));
    describeRoute(app, 'GET', '/ping', {
      headers: { 'x-api-key': { schema: { type: 'string' }, required: true } },
    });
    const gated = withRouteValidation(app);
    (await request(gated, '/ping')).status.should.equal(422);
    (await request(gated, '/ping', { headers: { 'x-api-key': 'k' } })).status.should.equal(200);
  });
});

describe('withRouteValidation (cookies — spec-only)', () => {
  it('documents cookies without gating them: the request passes without the cookie', async () => {
    const app = get(createApp(), '/who', (ctx) => json(ctx, { ok: true }));
    describeRoute(app, 'GET', '/who', {
      cookies: { session: { schema: { type: 'string' }, required: true } },
    });
    const gated = withRouteValidation(app);
    // No gate fires — parsing the cookie header is the cookies battery's
    // job, not the spec emitter's.
    (await request(gated, '/who')).status.should.equal(200);
    // The spec still documents the annotation.
    const spec = openapiSpec(gated, { title: 't', version: '1' });
    const parameters = (
      spec.paths['/who']?.get as {
        parameters: { name: string; in: string; required: boolean }[];
      }
    ).parameters;
    parameters.should.deep.equal([
      { name: 'session', in: 'cookie', required: true, schema: { type: 'string' } },
    ]);
  });
});

describe('withRouteValidation (multipart bodies)', () => {
  /** POST /avatars documented as a multipart form, gated. */
  function uploadApp() {
    const app = post(createApp(), '/avatars', async (ctx) =>
      json(ctx, { type: ctx.req.headers.get('content-type') ?? '' }, { status: 201 })
    );
    describeRoute(app, 'POST', '/avatars', {
      body: {
        form: {
          label: { schema: { type: 'string' }, required: true },
          avatar: { file: true, contentTypes: ['image/png'] },
        },
      },
    });
    return withRouteValidation(app);
  }

  it('documents the form without reading the body — multipart requests pass through', async () => {
    const form = new FormData();
    form.append('label', 'avatar');
    form.append('avatar', new Blob([new Uint8Array([1, 2, 3])]), 'a.png');
    const res = await request(uploadApp(), '/avatars', { method: 'POST', body: form });
    // The gate never JSON-parses the body; the handler runs.
    res.status.should.equal(201);
  });

  it('never reads the body even when it is JSON — the 415 is the route runtime\'s', async () => {
    const res = await request(uploadApp(), '/avatars', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'x' }),
    });
    res.status.should.equal(201);
  });

  it('still emits the multipart requestBody after the transform', () => {
    const spec = openapiSpec(uploadApp(), { title: 't', version: '1' });
    const media = (
      (spec.paths['/avatars']?.post as { requestBody: { content: Record<string, unknown> } })
        .requestBody.content['multipart/form-data'] as {
        schema: Record<string, unknown>;
        encoding: Record<string, unknown>;
      }
    );
    media.schema.should.deep.equal({
      type: 'object',
      properties: {
        label: { type: 'string' },
        avatar: { type: 'string', format: 'binary' },
      },
      required: ['label'],
    });
    media.encoding.should.deep.equal({ avatar: { contentType: 'image/png' } });
  });
});
