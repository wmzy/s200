import type { Ctx } from '../src/types';

import { describe, it } from 'vitest';

import { createApp, handle, post, use } from '../src/app';
import { readJson } from '../src/body';
import { neverSignal } from '../src/signal';
import { timeout } from '../src/timeout';

// vitest's should chain has no chai-as-promised plugins (no `rejectedWith`),
// so capture rejections manually and assert on the tagged value.
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined; // resolved — property assertions below will fail
}

function makeCtx(body: BodyInit | null, signal?: AbortSignal): Ctx {
  return {
    req: new Request('http://localhost/', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json' },
      // Node requires duplex for streaming bodies; harmless for buffers.
      duplex: 'half',
    } as RequestInit & { duplex?: 'half' }),
    url: new URL('http://localhost/'),
    params: {},
    query: new URLSearchParams(),
    state: {},
    signal: signal ?? neverSignal(),
    res: undefined,
  };
}

function stallingSource(onCancel: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    // Never enqueues, never closes: a body that stalls forever (no start
    // hook at all).
    cancel() {
      onCancel();
    },
  });
}

describe('timeout + body cooperative cancellation', () => {
  it('answers 503, cancels the stalled source and raises no unhandledRejection', async function () {
    let cancelled = false;
    const app = createApp();
    use(app, timeout(20));
    post(app, '/', (ctx) => readJson(ctx));
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown): void => {
      unhandled.push(error);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const res = await handle(
        app,
        new Request('http://localhost/', {
          method: 'POST',
          body: stallingSource(() => {
            cancelled = true;
          }),
          duplex: 'half',
        } as RequestInit & { duplex?: 'half' })
      );
      res.status.should.equal(503);
      (await res.json()).should.deep.equal({ error: 'Request timeout' });
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    // The losing chain's readJson rejected with AbortError and cancelled
    // the source instead of buffering a corpse.
    cancelled.should.equal(true);
    // Let the losing chain actually settle before judging rejections.
    await new Promise((resolve) => setTimeout(resolve, 50));
    unhandled.should.deep.equal([]);
  });

  it('readJson rejects promptly with AbortError on a pre-aborted signal', async function () {
    const controller = new AbortController();
    controller.abort();
    const ctx = makeCtx('{"a":1}', controller.signal);
    const error = (await rejectionOf(readJson(ctx))) as DOMException;
    error.should.be.an.instanceOf(DOMException);
    error.name.should.equal('AbortError');
    // Prompt: the stream was never touched.
    ctx.req.bodyUsed.should.be.false;
  });

  it('readJson mid-read abort rejects AbortError, cancels the source, and a second read does not hang', async function () {
    let cancelled = false;
    const controller = new AbortController();
    // Trickle: one chunk up front, then stall forever in pull.
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"chunk":'));
      },
      pull() {
        return new Promise<void>(() => undefined);
      },
      cancel() {
        cancelled = true;
      },
    });
    const ctx = makeCtx(source, controller.signal);
    const first = readJson(ctx);
    // Let the first chunk be delivered, then abort mid-read.
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const error = (await rejectionOf(first)) as DOMException;
    error.should.be.an.instanceOf(DOMException);
    error.name.should.equal('AbortError');
    cancelled.should.equal(true);
    // The cached raw promise rejects for every waiter: a second read of the
    // same ctx must reject (not hang, not replay stale bytes).
    const second = (await Promise.race([
      rejectionOf(readJson(ctx)),
      new Promise((resolve) => setTimeout(resolve, 250, 'HUNG')),
    ])) as DOMException | string;
    second.should.not.equal('HUNG');
    (second as DOMException).name.should.equal('AbortError');
  });

  it('fast body reads under a timeout pass through untouched', async function () {
    const app = createApp();
    use(app, timeout(1000));
    post(app, '/', (ctx) => readJson(ctx).then((data) => Response.json(data)));
    const res = await handle(
      app,
      new Request('http://localhost/', {
        method: 'POST',
        body: '{"a":1}',
        headers: { 'content-type': 'application/json' },
      })
    );
    res.status.should.equal(200);
    (await res.json()).should.deep.equal({ a: 1 });
  });

  it('normal readJson without cooperative cancellation is unchanged', async function () {
    // The default handle() path: the shared never-aborted signal, no
    // listener wiring, platform arrayBuffer() read.
    const ctx = makeCtx('{"ok":true}');
    (await readJson<{ ok: boolean }>(ctx)).should.deep.equal({ ok: true });
    // Second read served from the per-ctx cache, still no signal involved.
    (await readJson<{ ok: boolean }>(ctx)).should.deep.equal({ ok: true });
    // A real (but never-firing) signal takes the raced path and still
    // completes normally.
    const live = makeCtx('{"ok":2}', new AbortController().signal);
    (await readJson<{ ok: number }>(live)).should.deep.equal({ ok: 2 });
  });
});
