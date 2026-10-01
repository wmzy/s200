import type { NodeServer } from '../src/node';

import type { Socket } from 'node:net';

import { connect } from 'node:net';

import { describe, it } from 'vitest';

import { createApp, get, handle, post, use } from '../src/app';
import { serve } from '../src/node';
import { json } from '../src/respond';
import { neverSignal } from '../src/signal';

describe('handle ctx.signal', () => {
  it('seeds a shared never-aborted signal when no init is passed', async () => {
    const seen: AbortSignal[] = [];
    const seenAbortedAfter: boolean[] = [];
    const app = createApp();
    use(app, async (ctx, next) => {
      seen.push(ctx.signal);
      await next();
      // Unwind check: a normal request never trips the signal.
      seenAbortedAfter.push(ctx.signal.aborted);
    });
    get(app, '/', () => new Response('ok'));
    const first = await handle(app, new Request('http://localhost/'));
    first.status.should.equal(200);
    seen.should.have.length(1);
    seen[0]!.should.be.an.instanceOf(AbortSignal);
    seen[0]!.aborted.should.be.false;
    // The zero-allocation contract: the shared module-level signal, not a
    // fresh one per request.
    seen[0]!.should.equal(neverSignal());

    await handle(app, new Request('http://localhost/'));
    seen[1]!.should.equal(seen[0]!);
    seenAbortedAfter.should.deep.equal([false, false]);
  });

  it('surfaces an already-aborted init.signal to the chain', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('gone', 'AbortError'));
    let observed: { aborted: boolean; signal: AbortSignal; reason: unknown } | undefined;
    const app = createApp();
    use(app, (ctx, next) => {
      observed = {
        aborted: ctx.signal.aborted,
        signal: ctx.signal,
        reason: ctx.signal.reason,
      };
      return next();
    });
    get(app, '/', () => new Response('ok'));
    // handle itself stays cooperative: an aborted seed does not short-
    // circuit the chain, readers decide what to do with it.
    const res = await handle(app, new Request('http://localhost/'), {
      signal: controller.signal,
    });
    res.status.should.equal(200);
    observed?.aborted.should.be.true;
    observed?.signal.should.equal(controller.signal);
    (observed?.reason as DOMException).name.should.equal('AbortError');
  });
});

/** One disconnect probe: uploads `Content-Length: 1024` worth of headers
 * plus a partial body, then hands the socket back — the caller destroys it
 * once the server-side middleware is armed (mid-upload, before any
 * response). */
async function cutMidUpload(server: NodeServer): Promise<Socket> {
  const socket = connect({ host: '127.0.0.1', port: server.port });
  await new Promise<void>((resolve) => socket.once('connect', resolve));
  socket.write(
    'POST /upload HTTP/1.1\r\nHost: localhost\r\nContent-Type: text/plain\r\nContent-Length: 1024\r\n\r\npartial-body'
  );
  return socket;
}

/** Runs `disconnect` (a promise the test resolves on the server) against a
 * 4s watchdog — a hang means the abort never fired. */
async function raceDisconnect(disconnect: Promise<void>): Promise<void> {
  const winner = await Promise.race([
    disconnect.then(() => 'aborted'),
    new Promise<'timeout'>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 4000);
      timer.unref();
    }),
  ]);
  winner.should.equal('aborted');
}

describe('node adapter abortOnDisconnect', () => {
  it('aborts ctx.signal by default when the client cuts the socket mid-upload', async () => {
    const observations: {
      aborted: boolean;
      reason: unknown;
      requestSignalAborted: boolean;
    }[] = [];
    let arm: (() => void) | undefined;
    let finish: (() => void) | undefined;
    const started = new Promise<void>((resolve) => (arm = resolve));
    const completed = new Promise<void>((resolve) => (finish = resolve));
    const app = createApp();
    use(app, async (ctx) => {
      arm?.();
      // The cooperative pattern under test: race the abort event instead
      // of polling.
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) {
          resolve();
          return;
        }
        ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      observations.push({
        aborted: ctx.signal.aborted,
        reason: ctx.signal.reason,
        // undici wraps init.signal (no object identity) but keeps it
        // linked: the request's own signal aborts with the controller's.
        requestSignalAborted: ctx.req.signal.aborted,
      });
      finish?.();
    });
    post(app, '/upload', (ctx) => json(ctx, { ok: true }));

    const server = await serve(app, { port: 0 });
    try {
      const socket = await cutMidUpload(server);
      await started;
      // Cut mid-upload: headers delivered, body truncated.
      socket.destroy();
      await raceDisconnect(completed);
      observations.should.have.length(1);
      observations[0]!.aborted.should.be.true;
      (observations[0]!.reason as DOMException).name.should.equal('AbortError');
      (observations[0]!.reason as DOMException).message.should.equal(
        'client disconnected'
      );
      // The undici request's own signal stays linked to the controller's.
      observations[0]!.requestSignalAborted.should.be.true;
    } finally {
      await server.close();
    }
  });

  it('light mode: the same disconnect aborts through the light path', async () => {
    const observations: {
      aborted: boolean;
      sameObjectAsRequestSignal: boolean;
    }[] = [];
    let arm: (() => void) | undefined;
    let finish: (() => void) | undefined;
    const started = new Promise<void>((resolve) => (arm = resolve));
    const completed = new Promise<void>((resolve) => (finish = resolve));
    const app = createApp();
    use(app, async (ctx) => {
      const sameObjectAsRequestSignal = ctx.req.signal === ctx.signal;
      arm?.();
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) {
          resolve();
          return;
        }
        ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      observations.push({ aborted: ctx.signal.aborted, sameObjectAsRequestSignal });
      finish?.();
    });
    post(app, '/upload', (ctx) => json(ctx, { ok: true }));

    const server = await serve(app, {
      port: 0,
      light: true,
    });
    try {
      const socket = await cutMidUpload(server);
      await started;
      socket.destroy();
      await raceDisconnect(completed);
      observations.should.have.length(1);
      observations[0]!.aborted.should.be.true;
      // The light request's `signal` field mirrors the same controller.
      observations[0]!.sameObjectAsRequestSignal.should.be.true;
    } finally {
      await server.close();
    }
  });

  it('opt-out (false): round trip works on the shared never-aborted signal', async () => {
    const seen: AbortSignal[] = [];
    const abortedAtUnwind: boolean[] = [];
    const app = createApp();
    use(app, async (ctx, next) => {
      seen.push(ctx.signal);
      await next();
      abortedAtUnwind.push(ctx.signal.aborted);
    });
    get(app, '/ping', (ctx) => json(ctx, { pong: true }));

    const server = await serve(app, { port: 0, abortOnDisconnect: false });
    try {
      const res = await fetch(`${server.url}/ping`);
      res.status.should.equal(200);
      (await res.json()).should.deep.equal({ pong: true });
    } finally {
      await server.close();
    }
    seen.should.have.length(1);
    // The opt-out contract: back to the zero-allocation shared signal.
    seen[0]!.should.equal(neverSignal());
    abortedAtUnwind.should.deep.equal([false]);
  });
});
