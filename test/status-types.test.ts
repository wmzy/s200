import type { Ctx } from '../src/types';

import { describe, expectTypeOf, it } from 'vitest';

import { createApp, get, handle, mount } from '../src/app';
import {
  createClient,
  type ClientInit,
  type ClientResponse,
} from '../src/client';
import { httpError, toErrorResponse } from '../src/errors';
import {
  html,
  json,
  redirect,
  send,
  text,
  type StatusedResponse,
} from '../src/respond';

type User = { id: number; name: string };
type Err = { code: string };

/** A minimal live ctx for driving the respond builders directly. */
const ctx: Ctx = {
  req: new Request('http://t.test/'),
  url: new URL('http://t.test/'),
  params: {},
  query: new URLSearchParams(),
  state: {},
  signal: new AbortController().signal,
  res: undefined,
};

describe('status literal brands', () => {
  it("unions status and body types across a handler's branches", async () => {
    const app = createApp();
    const withUsers = get(app, '/users/:id', (c) => {
      const id = Number(c.params.id);
      return Number.isNaN(id)
        ? json(c, { code: 'no_user' }, { status: 404 })
        : json(c, { id, name: 'ada' });
    });
    const full = get(withUsers, '/plain', () => new Response('ok'));
    // A fetch that routes straight into handle: one bridge, both branches
    // exercised against the real dispatch (not a stubbed Response).
    const client = createClient(full, {
      baseUrl: 'http://t.test',
      fetch: (input, init) => handle(full, new Request(input, init)),
    });

    // Compile time: the branch union lands on both channels — the body
    // brands AND the status literals.
    expectTypeOf<typeof client.get>().toExtend<
      (
        path: '/users/:id',
        args: { id: string },
        init?: ClientInit
      ) => Promise<ClientResponse<Err | User, 200 | 404>>
    >();
    // A plain Response handler stays doubly untyped: unknown body, number status.
    expectTypeOf<typeof client.get>().toExtend<
      (path: '/plain', init?: ClientInit) => Promise<ClientResponse<unknown, number>>
    >();

    // Runtime: both branches ship exactly what their brands claim.
    const ok = await client.get('/users/:id', { id: '7' });
    ok.status.should.equal(200);
    (await ok.json()).should.deep.equal({ id: 7, name: 'ada' });
    const miss = await client.get('/users/:id', { id: 'x' });
    miss.status.should.equal(404);
    (await miss.json()).should.deep.equal({ code: 'no_user' });

    // A type query, not a call: the runtime body was consumed above.
    expectTypeOf<typeof ok.json>().toEqualTypeOf<() => Promise<Err | User>>();
    expectTypeOf(ok.status).branded.toEqualTypeOf<200 | 404>();
  });

  it('brands redirect with 302 by default and the literal when given', async () => {
    const app = createApp();
    const withOld = get(app, '/old', (c) => redirect(c, '/new'));
    const full = get(withOld, '/moved', (c) => redirect(c, '/new', 301));
    const client = createClient(full, {
      baseUrl: 'http://t.test',
      fetch: (input, init) => handle(full, new Request(input, init)),
    });

    const res = await client.get('/old');
    res.status.should.equal(302);
    (res.headers.get('location') ?? '').should.equal('/new');
    (await client.get('/moved')).status.should.equal(301);

    expectTypeOf<typeof client.get>().toExtend<
      (path: '/old', init?: ClientInit) => Promise<ClientResponse<unknown, 302>>
    >();
    expectTypeOf<typeof client.get>().toExtend<
      (path: '/moved', init?: ClientInit) => Promise<ClientResponse<unknown, 301>>
    >();
  });

  it('brands text, html and send status literals', () => {
    const tooMany = text(ctx, 'slow down', { status: 429 });
    tooMany.status.should.equal(429);
    expectTypeOf(tooMany).toExtend<StatusedResponse<429>>();

    const page = html(ctx, '<p>ok</p>');
    page.status.should.equal(200);
    expectTypeOf(page).toExtend<StatusedResponse<200>>();

    const gone = send(ctx, 'gone', { status: 410 });
    gone.status.should.equal(410);
    expectTypeOf(gone).toExtend<StatusedResponse<410>>();

    const plain = redirect(ctx, '/new');
    plain.status.should.equal(302);
    expectTypeOf(plain).toExtend<StatusedResponse<302>>();
  });

  it('keeps status brands through mount', () => {
    const sub = createApp();
    const subFull = get(sub, '/item/:id', (c) =>
      c.params.id === '0'
        ? json(c, { code: 'gone' }, { status: 404 })
        : json(c, { id: c.params.id })
    );
    const parent = mount(createApp(), '/v1', subFull);
    // Stubbed fetch: this is the type-level ride-along assertion.
    const client = createClient(parent, { fetch: async () => new Response('ok') });
    void client.get('/v1/item/:id', { id: '7' });

    expectTypeOf<typeof client.get>().toExtend<
      (
        path: '/v1/item/:id',
        args: { id: string },
        init?: ClientInit
      ) => Promise<ClientResponse<{ code: string } | { id: string }, 200 | 404>>
    >();
  });
});

describe('httpError body channel', () => {
  it('ships a structured body verbatim with the error status', async () => {
    const res = toErrorResponse(
      httpError(404, 'no such user', { code: 'USER_NOT_FOUND', hint: 'check the id' })
    );
    res.status.should.equal(404);
    (await res.json()).should.deep.equal({
      code: 'USER_NOT_FOUND',
      hint: 'check the id',
    });
    (res.headers.get('content-type') ?? '').should.match(/application\/json/);
  });

  it('keeps the { error: message } envelope without a body', async () => {
    const res = toErrorResponse(httpError(422, 'invalid'));
    res.status.should.equal(422);
    (await res.json()).should.deep.equal({ error: 'invalid' });
  });

  it('omits the body key entirely when none was given', () => {
    const e = httpError(404, 'x');
    ('body' in e).should.be.false;
    e.should.deep.equal({ _tag: 'HttpError', status: 404, message: 'x' });
  });

  it('brands the body type on the built error', () => {
    const conflict = httpError(409, 'stale write', { version: 3, field: 'title' });
    expectTypeOf(conflict.body).toEqualTypeOf<
      { version: number; field: string } | undefined
    >();
    const bare = httpError(500);
    expectTypeOf(bare.body).toEqualTypeOf<undefined>();
  });

  it('renders a thrown httpError body through the app boundary', async () => {
    const app = createApp();
    get(app, '/brew', () => {
      throw httpError(418, 'teapot', { brew: 'coffee' });
    });
    const res = await handle(app, new Request('http://t.test/brew'));
    res.status.should.equal(418);
    (await res.json()).should.deep.equal({ brew: 'coffee' });
  });
});
