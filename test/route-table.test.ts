import { describe, it } from 'vitest';

import { addRoute, createApp, get, post } from '../src/app';
import { createRouteTable } from '../src/route-table';

describe('createRouteTable', function () {
  it('exports every route as plain data with params and middleware counts', function () {
    const app = createApp();
    get(app, '/users/:id', (ctx) => ctx.params.id);
    post(app, '/users', () => new Response('ok'));
    addRoute(
      app,
      'PURGE',
      '/cache/*rest',
      async (_ctx, next) => {
        await next();
      },
      () => undefined
    );
    createRouteTable(app).routes.should.deep.equal([
      { method: 'GET', pattern: '/users/:id', params: ['id'], middlewareCount: 0 },
      { method: 'POST', pattern: '/users', params: [], middlewareCount: 0 },
      {
        method: 'PURGE',
        pattern: '/cache/*rest',
        params: ['rest'],
        middlewareCount: 1,
      },
    ]);
  });

  it('is JSON-serializable — no functions leak into the data', function () {
    const app = createApp();
    get(app, '/a', () => new Response('ok'));
    const roundTripped = JSON.parse(JSON.stringify(createRouteTable(app))) as {
      routes: readonly {
        method: string;
        pattern: string;
        params: string[];
        middlewareCount: number;
      }[];
    };
    roundTripped.routes[0]?.should.deep.equal({
      method: 'GET',
      pattern: '/a',
      params: [],
      middlewareCount: 0,
    });
  });
});
