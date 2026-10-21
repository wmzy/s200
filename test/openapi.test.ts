import { describe, it, vi } from 'vitest';

import { all, createApp, get, handle, post } from '../src/app';
import { throws } from '../src/errors';
import { describeApp, describeRoute } from '../src/meta';
import { openapiJson, openapiSpec } from '../src/openapi';
import { json } from '../src/respond';

describe('openapi (spec emission)', () => {
  function appFixture() {
    const app = createApp();
    const withGet = get(app, '/users/:id', (ctx) => ctx);
    const withPost = post(withGet, '/users', (ctx) => ctx);
    return { app: withPost, withGet, withPost };
  }

  it('emits every route as a path item with templated params', () => {
    const { app } = appFixture();
    const spec = openapiSpec(app, { title: 't', version: '1' });

    spec.openapi.should.equal('3.1.0');
    spec.info.title.should.equal('t');
    const user = spec.paths['/users/{id}'];
    user?.should.have.property('get');
    const item = user?.get as { parameters: { name: string; in: string; required: boolean }[] };
    item.parameters.map((p) => p.name).should.contain('id');
    item.parameters.find((p) => p.name === 'id')?.required.should.equal(true);
    spec.paths['/users']?.should.have.property('post');
  });

  it('carries meta into the path item', () => {
    const { app, withGet } = appFixture();
    describeRoute(withGet, 'GET', '/users/:id', {
      summary: 'Fetch one user',
      tags: ['users'],
      deprecated: true,
      query: { verbose: { type: 'boolean' } },
      responses: {
        200: {
          description: 'ok',
          schema: {
            type: 'object',
            properties: { id: { type: 'integer' }, name: { type: 'string' } },
            required: ['id', 'name'],
          },
        },
        404: { description: 'missing' },
      },
    });
    const spec = openapiSpec(app, { title: 't', version: '1' });
    const item = spec.paths['/users/{id}']?.get as {
      summary: string;
      tags: string[];
      deprecated: boolean;
      parameters: { name: string; in: string; schema: unknown }[];
      responses: Record<string, { description: string; content?: { 'application/json': { schema: unknown } } }>;
    };

    item.summary.should.equal('Fetch one user');
    item.tags.should.contain('users');
    item.deprecated.should.equal(true);
    item.parameters.find((p) => p.in === 'query')?.name.should.equal('verbose');
    item.responses[404]?.description.should.equal('missing');
    item.responses[404]?.should.not.have.property('content');
    const schema = item.responses[200]?.content?.['application/json'].schema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    schema.properties.should.have.property('id');
    schema.required.should.deep.equal(['id', 'name']);
  });

  it('converts nullable and array schemas to JSON Schema', () => {
    const app = createApp();
    const withGet = get(app, '/list', (ctx) => ctx);
    describeRoute(withGet, 'GET', '/list', {
      responses: {
        200: {
          description: 'ok',
          schema: {
            type: 'array',
            items: { type: 'string', nullable: true },
          },
        },
      },
    });
    const spec = openapiSpec(withGet, { title: 't', version: '1' });
    const item = spec.paths['/list']?.get as {
      responses: { 200: { content: { 'application/json': { schema: unknown } } } };
    };
    const schema = item.responses[200].content['application/json']
      .schema as { type: string; items: { type: string[] } };
    schema.type.should.equal('array');
    schema.items.type.should.deep.equal(['string', 'null']);
  });

  it('skips ALL routes with one deduped warn per pattern per build, and documents body schemas', () => {
    const app = createApp();
    const withAll = all(app, '/anything', () => new Response('any'));
    // A second ALL registration of the same pattern: still one warn.
    all(withAll, '/anything', () => new Response('any'));
    const withPost = post(withAll, '/things', (ctx) => ctx);
    describeRoute(withPost, 'POST', '/things', {
      body: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let spec: ReturnType<typeof openapiSpec>;
    try {
      spec = openapiSpec(withPost, { title: 't', version: '1' });
      // Deduped within one build; a second build warns once more.
      openapiSpec(withPost, { title: 't', version: '1' });
      warn.mock.calls.should.have.length(2);
      for (const call of warn.mock.calls) {
        String(call[0]).should.equal(
          '[s200] openapi: route /anything uses ALL — expand to explicit methods to document it'
        );
      }
    } finally {
      warn.mockRestore();
    }
    Object.keys(spec.paths).should.not.contain('/anything');
    const item = spec.paths['/things']?.post as {
      requestBody: { content: { 'application/json': { schema: { required: string[] } } } };
    };
    item.requestBody.content['application/json'].schema.required.should.deep.equal(['name']);
  });

  it('emits throws-declared error responses: bare statuses as the envelope, record form as inferred schemas', () => {
    const app = createApp();
    get(app, '/bare', throws(401, 404), (ctx) => json(ctx, { ok: true }));
    get(app, '/shaped', throws({ 422: { issues: ['x'] } }), (ctx) => json(ctx, { ok: true }));
    const spec = openapiSpec(app, { title: 't', version: '1' });

    const bare = (spec.paths['/bare']?.get as { responses: Record<string, unknown> }).responses;
    // No meta.responses: the bare 200 stays, the gate adds its statuses.
    Object.keys(bare).should.deep.equal(['200', '401', '404']);
    const envelope = (
      (bare[401] as { content: { 'application/json': { schema: unknown } } }).content[
        'application/json'
      ] as { schema: unknown }
    ).schema as Record<string, unknown>;
    envelope.should.deep.equal({
      type: 'object',
      properties: { error: { type: 'string' } },
    });
    (bare[404] as { description: string }).description.should.equal('Error response');

    const shaped = (spec.paths['/shaped']?.get as { responses: Record<string, unknown> })
      .responses;
    const schema = (
      (shaped[422] as { content: { 'application/json': { schema: unknown } } }).content[
        'application/json'
      ] as { schema: unknown }
    ).schema as Record<string, unknown>;
    schema.should.deep.equal({
      type: 'object',
      properties: { issues: { type: 'array', items: { type: 'string' } } },
    });
  });

  it('merges throws branches with meta.responses — meta wins a status both declare', () => {
    const app = createApp();
    const withMeta = get(app, '/x', throws(404, 429), (ctx) => json(ctx, { ok: true }));
    describeRoute(withMeta, 'GET', '/x', {
      responses: { 200: { description: 'ok' }, 404: { description: 'missing' } },
    });
    const spec = openapiSpec(app, { title: 't', version: '1' });
    const responses = (spec.paths['/x']?.get as { responses: Record<string, unknown> }).responses;

    Object.keys(responses).should.deep.equal(['200', '404', '429']);
    // 404 is meta's (its description, no inferred content); 429 is the
    // gate's envelope.
    (responses[404] as { description: string }).description.should.equal('missing');
    (responses[404] as Record<string, unknown>).should.not.have.property('content');
    const gate = (
      (responses[429] as { content: { 'application/json': { schema: unknown } } }).content[
        'application/json'
      ] as { schema: unknown }
    ).schema as Record<string, unknown>;
    gate.should.deep.equal({ type: 'object', properties: { error: { type: 'string' } } });
  });

  it('emits servers, components.securitySchemes and per-route security', () => {
    const app = createApp();
    const open = get(app, '/open', (ctx) => json(ctx, { ok: true }));
    const locked = get(app, '/locked', (ctx) => json(ctx, { secret: true }));
    describeRoute(open, 'GET', '/open', {});
    describeRoute(locked, 'GET', '/locked', {
      security: [{ bearerAuth: [] }, { apiKey: ['read'] }],
    });
    const spec = openapiSpec(app, {
      title: 't',
      version: '1',
      servers: [
        { url: 'https://api.example', description: 'production' },
        { url: 'http://localhost:3000' },
      ],
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        apiKey: { type: 'apiKey', name: 'X-API-Key', in: 'header' },
      },
    });

    spec.servers?.should.deep.equal([
      { url: 'https://api.example', description: 'production' },
      { url: 'http://localhost:3000' },
    ]);
    spec.components?.securitySchemes.should.deep.equal({
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      apiKey: { type: 'apiKey', name: 'X-API-Key', in: 'header' },
    });
    (spec.paths['/open']?.get as Record<string, unknown>).should.not.have.property('security');
    const security = (spec.paths['/locked']?.get as { security: unknown }).security as unknown[];
    security.should.deep.equal([{ bearerAuth: [] }, { apiKey: ['read'] }]);
    // Absent options emit nothing (the document stays minimal).
    const minimal = openapiSpec(createApp(), { title: 't', version: '1' });
    minimal.should.not.have.property('servers');
    minimal.should.not.have.property('components');
  });

  it('openapiJson answers a spec document over the wire', async () => {
    const app = createApp();
    describeApp(app, { title: 'Wire API', version: '2.0.0' });
    // Registrars mutate the app in place, so the route itself appears in
    // the spec the request handler walks.
    get(app, '/openapi.json', (ctx) => openapiJson(ctx, app));
    const res = await handle(app, new Request('http://x.test/openapi.json'));
    const body = (await res.json()) as { openapi: string; info: { title: string } };
    body.openapi.should.equal('3.1.0');
    body.info.title.should.equal('Wire API');
  });
});
