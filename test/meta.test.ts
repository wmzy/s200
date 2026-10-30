import { describe, it } from 'vitest';

import { createApp, get } from '../src/app';
import { throws } from '../src/errors';
import { describeRoute, getRouteMeta, mergedResponses } from '../src/meta';

describe('mergedResponses', () => {
  it('yields nothing for a route that declares no statuses', () => {
    const app = createApp();
    get(app, '/bare', (ctx) => ctx);
    const route = app.routes.at(-1)!;
    // The bare 200 the spec emitter documents is its own policy, not
    // part of the union.
    [...mergedResponses(getRouteMeta(route), route)].should.deep.equal([]);
  });

  it('unions responses with gate branches, meta winning conflicts', () => {
    const app = createApp();
    get(app, '/x', throws(404, 429), throws({ 503: () => undefined }), (ctx) => ctx);
    describeRoute(app, 'GET', '/x', {
      responses: {
        200: {
          description: 'ok',
          schema: {
            type: 'object',
            properties: { id: { type: 'integer' } },
            required: ['id'],
          },
        },
        // The gate also declares 404 — the declaration wins.
        404: { description: 'missing' },
      },
    });
    const route = app.routes.at(-1)!;
    [...mergedResponses(getRouteMeta(route), route)].should.deep.equal([
      {
        status: 200,
        schema: {
          type: 'object',
          properties: { id: { type: 'integer' } },
          required: ['id'],
        },
        description: 'ok',
      },
      { status: 404, schema: undefined, description: 'missing' },
      {
        status: 429,
        // The bare gate form's `{ error: '' }` envelope, inferred.
        schema: {
          type: 'object',
          properties: { error: { type: 'string' } },
          required: ['error'],
        },
        description: 'Error response',
      },
      // A function example infers no schema — the honest undefined.
      { status: 503, schema: undefined, description: 'Error response' },
    ]);
  });

  it('keeps a gate-declared 200 in the union — each emitter resolves it', () => {
    const app = createApp();
    get(app, '/odd', throws({ 200: { imposter: true } }), (ctx) => ctx);
    const route = app.routes.at(-1)!;
    [...mergedResponses(getRouteMeta(route), route)].should.deep.equal([
      {
        status: 200,
        schema: {
          type: 'object',
          properties: { imposter: { type: 'boolean' } },
          required: ['imposter'],
        },
        description: 'Error response',
      },
    ]);
  });
});
