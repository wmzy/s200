import type { FinishInfo } from '../src/finish';
import type { VercelHandler } from '../src/vercel';

import { describe, expectTypeOf, it } from 'vitest';

import { createApp, get } from '../src/app';
import { onFinish } from '../src/finish';
import { json } from '../src/respond';
import { createVercelHandler } from '../src/vercel';

describe('vercel createVercelHandler', () => {
  it('returns the web-handler shape', () => {
    const handler = createVercelHandler(createApp());
    expectTypeOf(handler).toEqualTypeOf<VercelHandler>();
    (typeof handler).should.equal('function');
  });

  it('passes the Request through handle and returns the Response', async () => {
    const app = createApp();
    get(app, '/api/hello', (ctx) => json(ctx, { hello: 'vercel' }));
    get(app, '/api/users/:id', (ctx) => json(ctx, { id: ctx.params.id }));
    const handler = createVercelHandler(app);

    const hello = await handler(new Request('https://app.vercel.sh/api/hello'));
    hello.status.should.equal(200);
    (await hello.json()).should.deep.equal({ hello: 'vercel' });

    const user = await handler(
      new Request('https://app.vercel.sh/api/users/42')
    );
    user.status.should.equal(200);
    (await user.json()).should.deep.equal({ id: '42' });
  });

  it('materializes the 404 fallback', async () => {
    const handler = createVercelHandler(createApp());
    const response = await handler(
      new Request('https://app.vercel.sh/missing')
    );
    response.status.should.equal(404);
  });

  it('threads the request signal into ctx.signal', async () => {
    const controller = new AbortController();
    const app = createApp();
    get(app, '/sig', (ctx) => json(ctx, { aborted: ctx.signal.aborted }));
    const handler = createVercelHandler(app);

    const before = await handler(
      new Request('https://app.vercel.sh/sig', { signal: controller.signal })
    );
    (await before.json()).should.deep.equal({ aborted: false });

    controller.abort();
    const after = await handler(
      new Request('https://app.vercel.sh/sig', { signal: controller.signal })
    );
    (await after.json()).should.deep.equal({ aborted: true });
  });

  it('runs onFinish when the response body completes', async () => {
    const app = createApp();
    const seen: FinishInfo[] = [];
    get(app, '/done', (ctx) => {
      onFinish(ctx, (info) => {
        seen.push({ aborted: info.aborted });
      });
      return json(ctx, { done: true });
    });
    const response = await createVercelHandler(app)(
      new Request('https://app.vercel.sh/done')
    );
    // The finishers ride the body — drain it to reach completion.
    await response.text();
    seen.length.should.equal(1);
    (seen[0]?.aborted ?? true).should.equal(false);
  });
});
