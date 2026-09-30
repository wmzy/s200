import type { Ctx } from '../src/types';

import { describe, it } from 'vitest';

import { createApp, get, use } from '../src/app';
import { createSession, type Session, type SessionData, type SessionStore } from '../src/session';
import { request } from '../src/test';

function sessionOf(ctx: Ctx, key = 'session'): Session {
  return ctx.state[key] as Session;
}

/** The `name=value` pairs of a response's Set-Cookie lines, as a Cookie header. */
function cookieHeader(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((line) => line.split(';')[0] ?? '')
    .join('; ');
}

function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

type SpyStore = SessionStore & {
  readonly gets: readonly string[];
  readonly sets: readonly { id: string; data: SessionData; ttl: number }[];
  readonly deletes: readonly string[];
};

/** Recording store over a private map — proves calls, not behavior. */
function spyStore(): SpyStore {
  const backing = new Map<string, SessionData>();
  const gets: string[] = [];
  const sets: { id: string; data: SessionData; ttl: number }[] = [];
  const deletes: string[] = [];
  return {
    async get(id: string) {
      gets.push(id);
      const data = backing.get(id);
      return data === undefined ? undefined : { ...data };
    },
    async set(id: string, data: SessionData, ttl: number) {
      sets.push({ id, data: { ...data }, ttl });
      backing.set(id, { ...data });
    },
    async delete(id: string) {
      deletes.push(id);
      backing.delete(id);
    },
    gets,
    sets,
    deletes,
  };
}

describe('createSession', function () {
  it('continues a session across two requests via the Set-Cookie handshake', async function () {
    const tool = createSession({ secret: 'sekret' });
    const app = createApp();
    use(app, tool.middleware);
    get(app, '/', (ctx) => {
      const session = sessionOf(ctx);
      if (session.isNew) {
        session.set('user', 'alice');
        session.set('visits', 1);
      } else {
        session.set('visits', Number(session.get('visits') ?? 0) + 1);
      }
      return Response.json({
        user: session.get('user'),
        visits: session.get('visits'),
        isNew: session.isNew,
        id: session.id,
      });
    });

    const first = await request(app, '/');
    const handshake = cookieHeader(first);
    handshake.should.match(/s200\.sid=/);
    handshake.should.match(/s200\.sid\.sig=/);
    const firstBody = (await first.json()) as { user: string; isNew: boolean; id?: string };
    firstBody.user.should.equal('alice');
    firstBody.isNew.should.equal(true);
    (firstBody.id === undefined).should.be.true;

    const sid = handshake.match(/s200\.sid=([^;]+)/)?.[1] ?? '';
    const second = await request(app, '/', { headers: { cookie: handshake } });
    const secondBody = (await second.json()) as {
      user: string;
      isNew: boolean;
      id?: string;
      visits: number;
    };
    secondBody.user.should.equal('alice');
    secondBody.isNew.should.equal(false);
    secondBody.visits.should.equal(2);
    (secondBody.id ?? '').should.equal(sid);
    tool.close();
  });

  it('leaves no Set-Cookie on requests that only read', async function () {
    const tool = createSession({ secret: 'sekret' });
    const app = createApp();
    use(app, tool.middleware);
    get(app, '/', (ctx) => new Response(String(sessionOf(ctx).isNew)));

    const anonymous = await request(app, '/');
    anonymous.headers.has('set-cookie').should.be.false;
    (await anonymous.text()).should.equal('true');

    // A restored session read without mutation stays silent too.
    get(app, '/seed', (ctx) => {
      sessionOf(ctx).set('user', 'bob');
      return new Response('set');
    });
    const seeded = await request(app, '/seed');
    const reader = await request(app, '/', { headers: { cookie: cookieHeader(seeded) } });
    reader.headers.has('set-cookie').should.be.false;
    (await reader.text()).should.equal('false');
    tool.close();
  });

  it('treats a tampered cookie as a brand-new empty session', async function () {
    const tool = createSession({ secret: 'sekret' });
    const app = createApp();
    use(app, tool.middleware);
    get(app, '/seed', (ctx) => {
      sessionOf(ctx).set('user', 'alice');
      return new Response('set');
    });
    get(app, '/', (ctx) =>
      Response.json({ user: sessionOf(ctx).get('user'), isNew: sessionOf(ctx).isNew })
    );

    const seeded = await request(app, '/seed');
    const tampered = cookieHeader(seeded).replace(/s200\.sid=[^;]+/, 's200.sid=forged-id');
    const res = await request(app, '/', { headers: { cookie: tampered } });
    res.status.should.equal(200);
    const body = (await res.json()) as { user: unknown; isNew: boolean };
    body.isNew.should.equal(true);
    (body.user === undefined).should.be.true;
    tool.close();
  });

  it('emits the default and custom cookie attributes', async function () {
    const defaults = createSession({ secret: 'sekret' });
    const defaultApp = createApp();
    use(defaultApp, defaults.middleware);
    get(defaultApp, '/', (ctx) => {
      sessionOf(ctx).set('a', 1);
      return new Response('ok');
    });
    const defaultLines = (await request(defaultApp, '/')).headers.getSetCookie();
    defaultLines.should.have.lengthOf(2);
    (defaultLines[0] ?? '').should.match(
      /^s200\.sid=[0-9a-f-]{36}; Max-Age=86400; Path=\/; HttpOnly$/
    );
    (defaultLines[1] ?? '').should.match(/^s200\.sid\.sig=[A-Za-z0-9_-]+; Max-Age=86400; Path=\/; HttpOnly$/);
    defaults.close();

    const custom = createSession({
      secret: 'sekret',
      key: 'acct',
      cookie: { name: 'app.sid', maxAge: 60, sameSite: 'lax', path: '/app', secure: true },
    });
    const customApp = createApp();
    use(customApp, custom.middleware);
    get(customApp, '/', (ctx) => {
      (ctx.state.acct as Session).set('a', 1);
      return new Response('ok');
    });
    const customLines = (await request(customApp, '/')).headers.getSetCookie();
    (customLines[0] ?? '').should.match(
      /^app\.sid=[0-9a-f-]{36}; Max-Age=60; Path=\/app; HttpOnly; Secure; SameSite=Lax$/
    );
    (customLines[1] ?? '').should.match(/^app\.sid\.sig=/);
    custom.close();
  });

  it('touch() renews an existing session but mints nothing for a new one', async function () {
    const spy = spyStore();
    const tool = createSession({ secret: 'sekret', store: spy, cookie: { maxAge: 60 } });
    const app = createApp();
    use(app, tool.middleware);
    get(app, '/', (ctx) => {
      sessionOf(ctx).touch();
      return new Response('ok');
    });

    // A brand-new session has no expiry to renew — no store write, no cookie.
    const cold = await request(app, '/');
    cold.headers.has('set-cookie').should.be.false;
    spy.sets.should.be.empty;

    get(app, '/seed', (ctx) => {
      sessionOf(ctx).set('user', 'alice');
      return new Response('set');
    });
    const seeded = await request(app, '/seed');
    spy.sets.should.have.lengthOf(1);
    (spy.sets[0]?.ttl ?? 0).should.equal(60);
    (spy.sets[0]?.data ?? {}).should.deep.equal({ user: 'alice' });

    const renewed = await request(app, '/', { headers: { cookie: cookieHeader(seeded) } });
    renewed.headers.has('set-cookie').should.be.true;
    spy.sets.should.have.lengthOf(2);
    (spy.sets[1]?.id ?? '').should.equal(spy.sets[0]?.id ?? '');
    (spy.sets[1]?.data ?? {}).should.deep.equal({ user: 'alice' });
    (spy.sets[1]?.ttl ?? 0).should.equal(60);
    // One store get: only the renewed request presented a session id.
    spy.gets.should.have.lengthOf(1);
    tool.close();
  });

  it('destroy() removes the store entry and expires the cookie', async function () {
    const spy = spyStore();
    const tool = createSession({ secret: 'sekret', store: spy });
    const app = createApp();
    use(app, tool.middleware);
    get(app, '/', (ctx) => {
      const session = sessionOf(ctx);
      if (session.isNew) {
        session.set('user', 'alice');
        return new Response('created');
      }
      return session.destroy().then(() => new Response('destroyed'));
    });

    const seeded = await request(app, '/');
    const sid = cookieHeader(seeded).match(/s200\.sid=([^;]+)/)?.[1] ?? '';
    sid.should.not.be.empty;

    const destroyed = await request(app, '/', { headers: { cookie: cookieHeader(seeded) } });
    (await destroyed.text()).should.equal('destroyed');
    spy.deletes.should.deep.equal([sid]);
    const expiryLines = destroyed.headers.getSetCookie();
    expiryLines.should.have.lengthOf(2);
    for (const line of expiryLines) {
      line.should.contain('Max-Age=0');
    }

    // The id is gone from the store: the same cookie now restores nothing.
    const after = await request(app, '/', { headers: { cookie: cookieHeader(seeded) } });
    (await after.text()).should.equal('created');
    spy.deletes.should.deep.equal([sid]);
    tool.close();
  });

  it('expires sessions past their ttl and slides the expiry on touch', async function () {
    const time = clock();
    const tool = createSession({ secret: 'sekret', cookie: { maxAge: 5 }, now: time.now });
    const app = createApp();
    use(app, tool.middleware);
    get(app, '/seed', (ctx) => {
      sessionOf(ctx).set('user', 'alice');
      return new Response('set');
    });
    get(app, '/', (ctx) => {
      const session = sessionOf(ctx);
      if (!session.isNew) session.touch();
      return Response.json({ isNew: session.isNew, user: session.get('user') });
    });

    const seeded = await request(app, '/seed');
    time.advance(6_000); // past the 5s ttl
    const stale = await request(app, '/', { headers: { cookie: cookieHeader(seeded) } });
    const staleBody = (await stale.json()) as { isNew: boolean; user: unknown };
    staleBody.isNew.should.equal(true);
    (staleBody.user === undefined).should.be.true;

    // Sliding renewal: an entry stored at t=6s expires at t=11s…
    const reseeded = await request(app, '/seed');
    time.advance(3_000); // t=9s — still alive
    const beforeExpiry = await request(app, '/', { headers: { cookie: cookieHeader(reseeded) } });
    const aliveBody = (await beforeExpiry.json()) as { isNew: boolean };
    aliveBody.isNew.should.equal(false);
    time.advance(3_000); // t=12s — the touch at t=9s extended expiry to t=14s…
    const touched = await request(app, '/', { headers: { cookie: cookieHeader(beforeExpiry) } });
    // …so this request still restores (and touches again, to t=17s).
    const touchedBody = (await touched.json()) as { isNew: boolean; user: string };
    touchedBody.isNew.should.equal(false);
    touchedBody.user.should.equal('alice');
    tool.close();
  });
});
