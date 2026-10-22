import type { FinishInfo } from '../src/finish';
import type { NodeServer } from '../src/node';

import { afterAll, beforeAll, describe, it } from 'vitest';

import { createApp, get, use } from '../src/app';
import { createHandler } from '../src/cloudflare';
import { onFinish } from '../src/finish';
import { serve } from '../src/node';
import { json, send } from '../src/respond';

const ENCODER = new TextEncoder();

/** Short deterministic settle for exactly-once assertions: the finish
 * triggers ride the same event loop as the observed outcome, so a second
 * (buggy) trigger would land well inside 30ms. */
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 30));

/** Polls until `fired` reached `count` — finish triggers may lag the client
 * observation by a macrotask; the deadline only fires on failure. */
async function untilFired(fired: FinishInfo[], count: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (fired.length < count) {
    if (Date.now() > deadline) {
      throw new Error(`only ${fired.length}/${count} finish callbacks ran`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Races a promise against a deadline that only rejects on failure. */
function within<T>(ms: number, promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`deadline exceeded (${ms}ms)`)), ms);
    }),
  ]);
}

type Deferred = { readonly promise: Promise<void>; readonly resolve: () => void };

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Node ≥ 20 ships ReadableStream.from (the canonical async-generator
// wrapper: cancel() calls the generator's return(), running its finally) —
// the DOM lib types lag behind the runtime, hence the one cast.
const streamFromIterator = (
  ReadableStream as unknown as {
    from: <R>(iterable: AsyncIterable<R>) => ReadableStream<R>;
  }
).from;

describe('onFinish + disconnect propagation (node adapter)', () => {
  const fired: FinishInfo[] = [];
  const logged: unknown[] = [];
  let generatorDone: Deferred | undefined;
  let sourceCancelled: Deferred | undefined;
  let server: NodeServer;
  let lightServer: NodeServer;

  beforeAll(async () => {
    const app = createApp({ logError: (error) => { logged.push(error); } });
    get(app, '/plain', (ctx) => {
      onFinish(ctx, (info) => {
        fired.push(info);
      });
      return json(ctx, { ok: true });
    });
    get(app, '/throwing-finish', (ctx) => {
      // Registered before the healthy one: a throw must not stop the rest.
      onFinish(ctx, () => {
        throw new Error('finish boom');
      });
      onFinish(ctx, (info) => {
        fired.push(info);
      });
      return json(ctx, { ok: true });
    });
    get(app, '/slow', async (ctx) => {
      onFinish(ctx, (info) => {
        fired.push(info);
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      return json(ctx, { ok: true });
    });
    get(app, '/infinite', (ctx) => {
      onFinish(ctx, (info) => {
        fired.push(info);
      });
      const generator = async function* (): AsyncGenerator<Uint8Array> {
        try {
          for (;;) {
            yield ENCODER.encode('chunk\n');
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        } finally {
          // The acceptance point of disconnect propagation: reader.cancel
          // reaches the handler-side generator.
          generatorDone?.resolve();
        }
      };
      return send(ctx, streamFromIterator(generator()));
    });
    get(app, '/infinite-source', (ctx) => {
      onFinish(ctx, (info) => {
        fired.push(info);
      });
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          controller.enqueue(ENCODER.encode('chunk\n'));
          await new Promise((resolve) => setTimeout(resolve, 5));
        },
        cancel() {
          sourceCancelled?.resolve();
        },
      });
      return send(ctx, stream);
    });
    server = await serve(app, { port: 0 });

    const lightApp = createApp();
    get(lightApp, '/plain', (ctx) => {
      onFinish(ctx, (info) => {
        fired.push(info);
      });
      return json(ctx, { ok: true });
    });
    lightServer = await serve(lightApp, { port: 0, light: true });
  });

  afterAll(async () => {
    await server.close();
    await lightServer.close();
  });

  it('runs the callbacks exactly once, aborted=false, on a clean response', async () => {
    fired.length = 0;
    const res = await fetch(`${server.url}/plain`);
    (await res.json()).should.deep.equal({ ok: true });
    await untilFired(fired, 1);
    await settle();
    fired.length.should.equal(1);
    fired[0]!.aborted.should.be.false;
  });

  it('finishes the same way on the light path', async () => {
    fired.length = 0;
    const res = await fetch(`${lightServer.url}/plain`);
    (await res.json()).should.deep.equal({ ok: true });
    await untilFired(fired, 1);
    await settle();
    fired.length.should.equal(1);
    fired[0]!.aborted.should.be.false;
  });

  it('logs a throwing callback through app.logError without stopping the others', async () => {
    fired.length = 0;
    logged.length = 0;
    const res = await fetch(`${server.url}/throwing-finish`);
    (await res.json()).should.deep.equal({ ok: true });
    await untilFired(fired, 1);
    await settle();
    fired.length.should.equal(1);
    logged.length.should.equal(1);
    (logged[0] as Error).message.should.equal('finish boom');
  });

  it('finishes aborted once and runs the generator finally when the client aborts mid-stream', async () => {
    fired.length = 0;
    generatorDone = deferred();
    const controller = new AbortController();
    const res = await fetch(`${server.url}/infinite`, {
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    const first = await reader.read();
    (first.value?.byteLength ?? 0).should.be.greaterThan(0);
    controller.abort();
    await within(3000, generatorDone.promise);
    await untilFired(fired, 1);
    await settle();
    fired.length.should.equal(1);
    fired[0]!.aborted.should.be.true;
  });

  it('propagates a client body-cancel to the source and finishes aborted', async () => {
    fired.length = 0;
    sourceCancelled = deferred();
    const res = await fetch(`${server.url}/infinite-source`);
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await within(3000, sourceCancelled.promise);
    await untilFired(fired, 1);
    await settle();
    fired.length.should.equal(1);
    fired[0]!.aborted.should.be.true;
  });

  it('finishes aborted once when the client disconnects while the handler still runs', async () => {
    fired.length = 0;
    const controller = new AbortController();
    const attempt = fetch(`${server.url}/slow`, { signal: controller.signal });
    attempt.catch(() => undefined); // the abort rejection is expected
    setTimeout(() => controller.abort(), 5);
    await untilFired(fired, 1);
    await settle();
    fired.length.should.equal(1);
    fired[0]!.aborted.should.be.true;
  });
});

describe('onFinish registered after the response (node adapter)', () => {
  const fired: FinishInfo[] = [];
  let server: NodeServer;

  beforeAll(async () => {
    const app = createApp();
    // The documented cleanup shape: the callback is registered after
    // `await next()`. When the client disconnects while the handler still
    // runs, the abort trigger fires before that registration exists — the
    // callback must still run, with the outcome it missed.
    use(app, async (ctx, next) => {
      await next();
      onFinish(ctx, (info) => {
        fired.push(info);
      });
    });
    get(app, '/slow', async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return new Response('late');
    });
    server = await serve(app, { port: 0 });
  });

  afterAll(async () => {
    await server.close();
  });

  it('runs the late callback with aborted=true when the client disconnects mid-handler', async () => {
    fired.length = 0;
    const controller = new AbortController();
    const attempt = fetch(`${server.url}/slow`, { signal: controller.signal });
    attempt.catch(() => undefined); // the abort rejection is expected
    setTimeout(() => controller.abort(), 5);
    await untilFired(fired, 1);
    await settle();
    fired.length.should.equal(1);
    fired[0]!.aborted.should.be.true;
  });

  it('runs the late callback with aborted=false on a clean response', async () => {
    fired.length = 0;
    const res = await fetch(`${server.url}/slow`);
    (await res.text()).should.equal('late');
    await untilFired(fired, 1);
    await settle();
    fired.length.should.equal(1);
    fired[0]!.aborted.should.be.false;
  });
});

describe('onFinish via the body-wrap trigger (cloudflare shape)', () => {
  const env: Record<string, unknown> = {};
  const workerCtx = { waitUntil: () => undefined };

  it('finishes aborted=false exactly once when the body is read to the end', async () => {
    const fired: FinishInfo[] = [];
    const app = createApp();
    get(app, '/data', (ctx) => {
      onFinish(ctx, (info) => {
        fired.push(info);
      });
      return json(ctx, { ok: true });
    });
    const worker = createHandler(app);
    const res = await worker.fetch(new Request('http://worker/data'), env, workerCtx);
    (await res.text()).should.not.equal('');
    await untilFired(fired, 1);
    await settle();
    fired.length.should.equal(1);
    fired[0]!.aborted.should.be.false;
  });

  it('finishes an empty-body response immediately', async () => {
    const fired: FinishInfo[] = [];
    const app = createApp();
    get(app, '/empty', (ctx) => {
      onFinish(ctx, (info) => {
        fired.push(info);
      });
      return send(ctx, null);
    });
    const worker = createHandler(app);
    const res = await worker.fetch(new Request('http://worker/empty'), env, workerCtx);
    (res.body === null).should.be.true;
    // Null body: trackFinish ran synchronously before fetch resolved.
    fired.length.should.equal(1);
    fired[0]!.aborted.should.be.false;
  });

  it('finishes aborted and cancels the source when the runtime cancels the body', async () => {
    const fired: FinishInfo[] = [];
    const sourceCancelled = deferred();
    const app = createApp();
    get(app, '/stream', (ctx) => {
      onFinish(ctx, (info) => {
        fired.push(info);
      });
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          controller.enqueue(ENCODER.encode('chunk\n'));
          await new Promise((resolve) => setTimeout(resolve, 5));
        },
        cancel() {
          sourceCancelled.resolve();
        },
      });
      return send(ctx, stream);
    });
    const worker = createHandler(app);
    const res = await worker.fetch(new Request('http://worker/stream'), env, workerCtx);
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await within(3000, sourceCancelled.promise);
    await untilFired(fired, 1);
    await settle();
    fired.length.should.equal(1);
    fired[0]!.aborted.should.be.true;
  });
});
