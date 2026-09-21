import { describe, it } from 'vitest';

import { all, createApp, get, post, handle  } from '../src/app';
import { describeApp, describeRoute } from '../src/meta';
import { openapiJson, openapiSpec } from '../src/openapi';

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

  it('skips ALL routes and documents body schemas', () => {
    const app = createApp();
    const withAll = all(app, '/anything', () => new Response('any'));
    const withPost = post(withAll, '/things', (ctx) => ctx);
    describeRoute(withPost, 'POST', '/things', {
      body: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    });
    const spec = openapiSpec(withPost, { title: 't', version: '1' });
    Object.keys(spec.paths).should.not.contain('/anything');
    const item = spec.paths['/things']?.post as {
      requestBody: { content: { 'application/json': { schema: { required: string[] } } } };
    };
    item.requestBody.content['application/json'].schema.required.should.deep.equal(['name']);
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
