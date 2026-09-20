import type { Ctx } from '../src/types';

import { describe, expect, it } from 'vitest';

import { compose } from '../src/compose';

function createTestCtx(): Ctx {
  return {
    req: new Request('http://localhost/a'),
    url: new URL('http://localhost/a'),
    params: {},
    query: new URLSearchParams(),
    state: {},
    res: undefined,
  };
}

describe('compose', function () {
  it('runs middlewares in onion order', async function () {
    const order: string[] = [];
    const chain = compose([
      async (_ctx, next) => {
        order.push('a:before');
        await next();
        order.push('a:after');
      },
      async (_ctx, next) => {
        order.push('b:before');
        await next();
        order.push('b:after');
      },
      async () => {
        order.push('c');
      },
    ]);
    await chain(createTestCtx());
    order.should.deep.equal([
      'a:before',
      'b:before',
      'c',
      'b:after',
      'a:after',
    ]);
  });

  it('resolves for an empty chain', async function () {
    await compose([])(createTestCtx());
  });

  it('supports sync middlewares and a sync throw becomes a rejection', async function () {
    const order: string[] = [];
    const ok = compose([
      () => {
        order.push('sync');
      },
    ]);
    await ok(createTestCtx());
    order.should.deep.equal(['sync']);

    const boom = compose([
      () => {
        throw new Error('sync boom');
      },
    ]);
    await expect(boom(createTestCtx())).rejects.toThrow('sync boom');
  });

  it('rejects the whole chain when a middleware throws', async function () {
    const order: string[] = [];
    const chain = compose([
      async (_ctx, next) => {
        try {
          await next();
        } catch {
          order.push('caught');
          throw new Error('rethrown');
        }
      },
      async () => {
        throw new Error('boom');
      },
    ]);
    await expect(chain(createTestCtx())).rejects.toThrow('rethrown');
    order.should.deep.equal(['caught']);
  });

  it('rejects when next() is called twice before it settles', async function () {
    const chain = compose([
      async (_ctx, next) => {
        await next();
        await next();
      },
      async () => {
        /* first next() settles here */
      },
    ]);
    await expect(chain(createTestCtx())).rejects.toThrow(
      'next() called multiple times'
    );
  });

  it('rejects a double next() even from the last middleware', async function () {
    const chain = compose([
      async (_ctx, next) => {
        next();
        await next();
      },
    ]);
    await expect(chain(createTestCtx())).rejects.toThrow(
      'next() called multiple times'
    );
  });

  it('skips later middlewares when next() is not called', async function () {
    const order: string[] = [];
    const chain = compose([
      async () => {
        order.push('only');
      },
      async () => {
        order.push('never');
      },
    ]);
    await chain(createTestCtx());
    order.should.deep.equal(['only']);
  });

  it('shares one mutable ctx across the chain', async function () {
    const chain = compose([
      async (ctx, next) => {
        ctx.state.n = 1;
        await next();
        // Unwind sees writes made downstream.
        (ctx.res as Response).status.should.equal(201);
      },
      async (ctx) => {
        (ctx.state.n as number).should.equal(1);
        ctx.res = new Response('made', { status: 201 });
      },
    ]);
    const ctx = createTestCtx();
    await chain(ctx);
    ctx.res?.status.should.equal(201);
  });

  it('continues into an outer chain through the trailing next', async function () {
    const order: string[] = [];
    const inner = compose([
      async (_ctx, next) => {
        order.push('i1:before');
        await next();
        order.push('i1:after');
      },
      async (_ctx, next) => {
        order.push('i2');
        await next();
        order.push('i2:after');
      },
    ]);
    const outer = compose([
      async (_ctx, next) => {
        order.push('o1:before');
        await next();
        order.push('o1:after');
      },
      inner, // a composed chain used as a middleware
      async () => {
        order.push('o2');
      },
    ]);
    await outer(createTestCtx());
    order.should.deep.equal([
      'o1:before',
      'i1:before',
      'i2',
      'o2', // inner's last next() handed control to the outer chain
      'i2:after',
      'i1:after',
      'o1:after',
    ]);
  });

  it('calls the trailing next of an empty inner chain', async function () {
    const order: string[] = [];
    const chain = compose([
      async (_ctx, next) => {
        order.push('a');
        await next();
      },
    ]);
    const next = async () => {
      order.push('next');
    };
    // Empty chain: hands straight through to the trailing next.
    await compose([])(createTestCtx(), next);
    // Non-empty: the last middleware's next() continues outward.
    await chain(createTestCtx(), next);
    order.should.deep.equal(['next', 'a', 'next']);
  });
});
