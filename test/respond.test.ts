import type { SettledCtx } from '../src/respond';
import type { Ctx } from '../src/types';

import { describe, expectTypeOf, it } from 'vitest';

import { createApp, get, handle, use } from '../src/app';
import {
  html,
  json,
  resOf,
  setHeader,
  stringResponse,
  text,
  utf8Length,
} from '../src/respond';

const quiet = { logError: () => undefined };

describe('resOf', () => {
  it('returns the response after next() settles (handler 200)', async () => {
    const app = createApp();
    const statuses: number[] = [];
    use(app, async (ctx, next) => {
      await next();
      statuses.push(resOf(ctx).status);
    });
    get(app, '/', (ctx) => {
      text(ctx, 'hello');
    });
    const res = await handle(app, new Request('http://localhost/'));
    res.status.should.equal(200);
    (await res.text()).should.equal('hello');
    statuses.should.deep.equal([200]);
  });

  it('returns the mapped 500 and the 404 fallback alike', async () => {
    const app = createApp(quiet);
    const statuses: number[] = [];
    use(app, async (ctx, next) => {
      await next();
      statuses.push(resOf(ctx).status);
    });
    get(app, '/boom', () => {
      throw new Error('kaboom');
    });
    (await handle(app, new Request('http://localhost/boom'))).status.should.equal(500);
    (await handle(app, new Request('http://localhost/missing'))).status.should.equal(404);
    statuses.should.deep.equal([500, 404]);
  });

  it('throws a misuse-naming plain Error before a response exists', async () => {
    const app = createApp();
    let caught: unknown;
    use(app, async (ctx, next) => {
      try {
        resOf(ctx);
      } catch (e) {
        caught = e;
      }
      await next();
    });
    get(app, '/', (ctx) => {
      text(ctx, 'late');
    });
    const res = await handle(app, new Request('http://localhost/'));
    res.status.should.equal(200);
    (caught instanceof Error).should.be.true;
    // Names the misuse: pre-next call, post-next invariant.
    (caught as Error).message.should.match(/after `await next\(\)`/);
    (caught as Error).message.should.match(/before next/);
    // Programmer error, not an httpError — it never maps to a client response.
    ((caught as { _tag?: string })._tag === undefined).should.be.true;
  });
});

describe('SettledCtx', () => {
  it('is a Ctx with res narrowed from Response | undefined to Response', () => {
    expectTypeOf<SettledCtx>().toExtend<Ctx>();
    expectTypeOf<SettledCtx['res']>().toEqualTypeOf<Response>();
  });

  it('types post-next helpers — resOf proves it, the spread assigns it', async () => {
    const collected: string[] = [];
    // A helper that only ever runs after next(): no `?.` dance inside.
    const statusLine = (ctx: SettledCtx): string =>
      `${ctx.req.method} ${ctx.url.pathname} → ${ctx.res.status}`;
    const app = createApp();
    use(app, async (ctx, next) => {
      await next();
      collected.push(statusLine({ ...ctx, res: resOf(ctx) }));
    });
    get(app, '/', (ctx) => {
      json(ctx, { ok: true });
    });
    (await handle(app, new Request('http://localhost/'))).status.should.equal(200);
    collected.should.deep.equal(['GET / → 200']);
  });
});

describe('the shared materialization tail', () => {
  it('json/text/html advertise the exact byte length on body-ful statuses', async () => {
    const app = createApp();
    get(app, '/j', (ctx) => json(ctx, { ok: true }));
    get(app, '/t', (ctx) => text(ctx, 'héllo'));
    get(app, '/h', (ctx) => html(ctx, '<p>ok</p>'));
    const j = await handle(app, new Request('http://localhost/j'));
    (j.headers.get('content-type') ?? '').should.equal('application/json');
    (j.headers.get('content-length') ?? '').should.equal(
      String(JSON.stringify({ ok: true }).length)
    );
    const t = await handle(app, new Request('http://localhost/t'));
    (t.headers.get('content-type') ?? '').should.equal('text/plain; charset=utf-8');
    (t.headers.get('content-length') ?? '').should.equal(String(utf8Length('héllo')));
    const h = await handle(app, new Request('http://localhost/h'));
    (h.headers.get('content-type') ?? '').should.equal('text/html; charset=utf-8');
    (h.headers.get('content-length') ?? '').should.equal(String(utf8Length('<p>ok</p>')));
  });

  it('stringResponse keeps explicit headers and invents no content-type without a fallback', async () => {
    const app = createApp();
    get(app, '/s', (ctx) =>
      stringResponse(ctx, 'héllo', { headers: { 'x-mark': 'on' } })
    );
    const res = await handle(app, new Request('http://localhost/s'));
    res.status.should.equal(200);
    (res.headers.get('content-length') ?? '').should.equal(String(utf8Length('héllo')));
    (res.headers.get('x-mark') ?? '').should.equal('on');
    // No fallbackContentType given, so the helper adds none — whatever
    // content-type the response carries is the platform's own
    // text/plain default for USVString bodies, not an invented default.
    (res.headers.get('content-type') ?? '').should.not.equal('text/csv');
    (await res.text()).should.equal('héllo');
  });

  it('stringResponse fills the fallback content-type only when none is set', async () => {
    const app = createApp();
    get(app, '/defaulted', (ctx) => stringResponse(ctx, 'x', undefined, 'text/csv'));
    get(app, '/explicit', (ctx) =>
      stringResponse(ctx, 'x', { headers: { 'content-type': 'text/plain' } }, 'text/csv')
    );
    const defaulted = await handle(app, new Request('http://localhost/defaulted'));
    (defaulted.headers.get('content-type') ?? '').should.equal('text/csv');
    const explicit = await handle(app, new Request('http://localhost/explicit'));
    (explicit.headers.get('content-type') ?? '').should.equal('text/plain');
  });

  it('adoptResponse rides deferred setHeader values onto a returned Response', async () => {
    const app = createApp();
    get(app, '/adopt', (ctx) => {
      setHeader(ctx, 'x-deferred', 'rides');
      return new Response('adopted');
    });
    const res = await handle(app, new Request('http://localhost/adopt'));
    res.status.should.equal(200);
    (res.headers.get('x-deferred') ?? '').should.equal('rides');
    (await res.text()).should.equal('adopted');
  });

  it('an error-mapped response carries deferred headers too (mapError adoption)', async () => {
    const app = createApp(quiet);
    get(app, '/boom', (ctx) => {
      setHeader(ctx, 'x-deferred', 'rides-500');
      throw new Error('kaboom');
    });
    const res = await handle(app, new Request('http://localhost/boom'));
    res.status.should.equal(500);
    (res.headers.get('x-deferred') ?? '').should.equal('rides-500');
  });
});
