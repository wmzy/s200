import type { SettledCtx } from '../src/respond';
import type { Ctx } from '../src/types';

import { describe, expectTypeOf, it } from 'vitest';

import { createApp, get, handle, use } from '../src/app';
import { json, resOf, text } from '../src/respond';

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
