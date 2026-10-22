import { describe, it } from 'vitest';

import { all, createApp, get, post, use } from '../src/app';
import { routeHints } from '../src/dev';
import { httpError } from '../src/errors';
import { json, text, utf8Length } from '../src/respond';
import { request } from '../src/test';

/** The decorated body shape routeHints ships (never both hint and routes). */
type HintsBody = { error: string; hint?: string; routes?: string[] };

const bodyOf = async (res: Response): Promise<HintsBody> => (await res.json()) as HintsBody;

describe('routeHints', () => {
  it('decorates the default 404 with a same-method hint when a close route exists', async () => {
    const app = createApp();
    use(app, routeHints(app));
    get(app, '/users/:id', (ctx) => text(ctx, 'user'));

    const res = await request(app, '/users');
    res.status.should.equal(404);
    (res.headers.get('content-type') ?? '').should.equal('application/json');
    (await bodyOf(res)).should.deep.equal({
      error: 'Not Found',
      hint: 'did you mean GET /users/:id?',
    });
  });

  it('rebuilds the decorated 404 with a content-length matching the new body', async () => {
    const app = createApp();
    use(app, routeHints(app));
    get(app, '/users/:id', (ctx) => text(ctx, 'user'));

    const res = await request(app, '/users');
    const body = await res.text();
    res.status.should.equal(404);
    // The default 404's 21-byte content-length must not survive onto the
    // larger decorated body: on the wire the client would read a truncated,
    // invalid JSON body and keep-alive framing would desynchronise.
    (res.headers.get('content-length') ?? '').should.equal(String(utf8Length(body)));
    (JSON.parse(body) as HintsBody).should.deep.equal({
      error: 'Not Found',
      hint: 'did you mean GET /users/:id?',
    });
  });

  it('ranks same-method candidates by static overlap, ties by registration order', async () => {
    const app = createApp();
    use(app, routeHints(app));
    // Both 404 on /admin/users: it is one segment too short for each.
    get(app, '/admin/users/:id', (ctx) => text(ctx, 'deep')); // 2 statics match
    get(app, '/admin/:id/posts', (ctx) => text(ctx, 'shallow')); // 1 static matches

    const res = await request(app, '/admin/users');
    (await bodyOf(res)).should.deep.equal({
      error: 'Not Found',
      hint: 'did you mean GET /admin/users/:id?',
    });

    const tied = createApp();
    use(tied, routeHints(tied));
    get(tied, '/users/:id', (ctx) => text(ctx, 'first'));
    get(tied, '/users/:uid', (ctx) => text(ctx, 'second'));
    (await bodyOf(await request(tied, '/users'))).should.deep.equal({
      error: 'Not Found',
      hint: 'did you mean GET /users/:id?', // first registrant wins the tie
    });
  });

  it('treats ALL and HEAD→GET as same-method, mirroring the router', async () => {
    const app = createApp();
    use(app, routeHints(app));
    all(app, '/things/:id', (ctx) => text(ctx, 'any'));

    (await bodyOf(await request(app, '/things'))).should.deep.equal({
      error: 'Not Found',
      hint: 'did you mean ALL /things/:id?',
    });
  });

  it('leaves a custom onNotFound body untouched', async () => {
    const app = createApp({
      onNotFound: (ctx) => {
        json(ctx, { custom: 'nope' }, { status: 404 });
      },
    });
    use(app, routeHints(app));
    get(app, '/users/:id', (ctx) => text(ctx, 'user'));

    const res = await request(app, '/users');
    res.status.should.equal(404);
    (await bodyOf(res)).should.deep.equal({ custom: 'nope' });
  });

  it('leaves non-404 responses, 405s and handler-authored 404s untouched', async () => {
    const app = createApp();
    use(app, routeHints(app));
    get(app, '/users/:id', (ctx) => text(ctx, 'user'));
    post(app, '/things', (ctx) => text(ctx, 'thing'));
    get(app, '/gone', () => {
      throw httpError(404);
    });

    const ok = await request(app, '/users/1');
    ok.status.should.equal(200);
    (await ok.text()).should.equal('user');

    // Path matches, method does not: a 405, not a 404 — out of scope.
    const wrongMethod = await request(app, '/things');
    wrongMethod.status.should.equal(405);
    (await wrongMethod.json()).should.deep.equal({ error: 'Method Not Allowed' });

    // httpError(404) ships its own envelope, not the framework default.
    const thrown = await request(app, '/gone');
    thrown.status.should.equal(404);
    (await thrown.json()).should.deep.equal({ error: 'HTTP 404 Not Found' });
  });

  it('lists top all-method routes when no same-method route overlaps (default 3)', async () => {
    const app = createApp();
    use(app, routeHints(app));
    post(app, '/users/:id', (ctx) => text(ctx, 'a'));
    post(app, '/users/:uid', (ctx) => text(ctx, 'b'));
    post(app, '/users/:pid', (ctx) => text(ctx, 'c'));
    post(app, '/users/:x', (ctx) => text(ctx, 'd'));
    get(app, '/health', (ctx) => text(ctx, 'ok')); // zero overlap with /users

    const res = await request(app, '/users');
    res.status.should.equal(404);
    // GET has no overlapping route at all, so the all-methods fallback
    // lists the top 3 by overlap; equal scores keep registration order.
    (await bodyOf(res)).should.deep.equal({
      error: 'Not Found',
      routes: ['POST /users/:id', 'POST /users/:uid', 'POST /users/:pid'],
    });
  });

  it('respects the limit option', async () => {
    const app = createApp();
    use(app, routeHints(app, { limit: 2 }));
    post(app, '/users/:id', (ctx) => text(ctx, 'a'));
    post(app, '/users/:uid', (ctx) => text(ctx, 'b'));
    post(app, '/users/:pid', (ctx) => text(ctx, 'c'));

    (await bodyOf(await request(app, '/users'))).should.deep.equal({
      error: 'Not Found',
      routes: ['POST /users/:id', 'POST /users/:uid'],
    });
  });

  it('leaves the default body untouched when a same-method candidate is below half', async () => {
    const app = createApp();
    use(app, routeHints(app));
    get(app, '/users/:id', (ctx) => text(ctx, 'user'));

    // One static match over three request segments — not close enough to
    // hint, and a same-method candidate existing suppresses the routes list.
    const res = await request(app, '/users/1/extra');
    res.status.should.equal(404);
    (await res.text()).should.equal('{"error":"Not Found"}');
  });

  it('leaves the body untouched when an inner middleware already rewrote it', async () => {
    const app = createApp();
    use(app, routeHints(app));
    // Registered after routeHints, so its unwind runs first — routeHints
    // sees the rewritten body, not the framework default.
    use(app, async (ctx, next) => {
      await next();
      if (ctx.res?.status === 404) {
        ctx.res = json(ctx, { error: 'Not Found', rewritten: true }, { status: 404 });
      }
    });
    get(app, '/users/:id', (ctx) => text(ctx, 'user'));

    const res = await request(app, '/users');
    res.status.should.equal(404);
    (await bodyOf(res)).should.deep.equal({ error: 'Not Found', rewritten: true });
  });
});
