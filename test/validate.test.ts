import { describe, it } from 'vitest';

import { createApp, get, handle, post } from '../src/app';
import { httpError } from '../src/errors';
import { jsonBody, validate } from '../src/validate';

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
