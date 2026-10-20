import { describe, it } from 'vitest';

import { createApp, get, handle, use } from '../src/app';
import { als, currentCtx } from '../src/als';
import { json } from '../src/respond';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('als', function () {
  it('restores the ctx inside deep awaits and setTimeout callbacks', async function () {
    const app = createApp();
    use(app, als());
    const seen: string[] = [];
    get(app, '/x', async (ctx) => {
      await delay(5);
      const deep = async (): Promise<void> => {
        await delay(5);
        await new Promise<void>((resolve) => {
          setTimeout(() => {
            const found = currentCtx();
            seen.push(found === ctx ? 'same' : found === undefined ? 'none' : 'other');
            resolve();
          }, 5);
        });
      };
      await deep();
      return json(ctx, { ok: true });
    });
    const res = await handle(app, new Request('http://localhost/x'));
    res.status.should.equal(200);
    seen.should.deep.equal(['same']);
  });

  it('returns undefined when the middleware is not registered', async function () {
    const app = createApp();
    const seen: string[] = [];
    get(app, '/x', async (ctx) => {
      await delay(5);
      seen.push(currentCtx() === undefined ? 'none' : 'some');
      return json(ctx, { ok: true });
    });
    const res = await handle(app, new Request('http://localhost/x'));
    res.status.should.equal(200);
    seen.should.deep.equal(['none']);
  });

  it('isolates interleaved concurrent requests', async function () {
    const app = createApp();
    use(app, als());
    const reads: (string | undefined)[] = [];
    get(app, '/slow', async (ctx) => {
      await delay(20);
      reads.push(currentCtx()?.url.pathname);
      return json(ctx, { ok: true });
    });
    get(app, '/fast', async (ctx) => {
      reads.push(currentCtx()?.url.pathname);
      return json(ctx, { ok: true });
    });
    await Promise.all([
      handle(app, new Request('http://localhost/slow')),
      handle(app, new Request('http://localhost/fast')),
    ]);
    reads.sort();
    reads.should.deep.equal(['/fast', '/slow']);
    // the ambient ctx never leaks past the request's async extent
    (currentCtx() === undefined).should.be.true;
  });
});
