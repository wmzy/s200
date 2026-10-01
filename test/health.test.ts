import type { ReadinessBody } from '../src/health';

import { describe, it } from 'vitest';

import { createApp, get, handle } from '../src/app';
import { createGate, health, readiness } from '../src/health';

// A controllable future — the test's stand-in for slow dependencies.
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Tiny-interval polling wait — deterministic without fake timers.
function poll(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = (): void => {
      if (condition()) {
        resolve();
      } else if (Date.now() - startedAt > timeoutMs) {
        reject(new Error('poll timeout'));
      } else {
        setTimeout(tick, 5);
      }
    };
    tick();
  });
}

describe('health (liveness)', () => {
  it('answers 200 {"status":"ok"} — answering at all is alive', async () => {
    const app = createApp();
    get(app, '/live', health());
    const res = await handle(app, new Request('http://localhost/live'));
    res.status.should.equal(200);
    (await res.json()).should.deep.equal({ status: 'ok' });
  });
});

describe('readiness', () => {
  it('reports 200 with every check "ok" — sync and async checks mix', async () => {
    const app = createApp();
    get(
      app,
      '/ready',
      readiness({
        db: async () => {
          await Promise.resolve();
        },
        cache: () => undefined,
      })
    );
    const res = await handle(app, new Request('http://localhost/ready'));
    res.status.should.equal(200);
    (await res.json()).should.deep.equal({
      status: 'ok',
      checks: { db: 'ok', cache: 'ok' },
    });
  });

  it('runs checks concurrently — a barrier only both checkers can open resolves', async () => {
    let started = 0;
    const barrier = deferred<void>();
    const check = async (): Promise<void> => {
      started += 1;
      if (started === 2) {
        barrier.resolve();
      }
      await barrier.promise;
    };
    const app = createApp();
    // Sequential execution would deadlock on the barrier and hit the
    // 300ms budget instead of resolving fast.
    get(app, '/ready', readiness({ a: check, b: check }, { timeout: 300 }));
    const res = await handle(app, new Request('http://localhost/ready'));
    res.status.should.equal(200);
    ((await res.json()) as ReadinessBody).checks.should.deep.equal({ a: 'ok', b: 'ok' });
  });

  it("answers 503 with each check's own reason; healthy siblings still report 'ok'", async () => {
    const app = createApp();
    get(
      app,
      '/ready',
      readiness({
        db: () => {
          throw new Error('connection refused');
        },
        cache: async () => undefined,
      })
    );
    const res = await handle(app, new Request('http://localhost/ready'));
    res.status.should.equal(503);
    (await res.json()).should.deep.equal({
      status: 'fail',
      checks: { db: 'connection refused', cache: 'ok' },
    });
  });

  it('times a hung check out at the budget and reports the timeout reason', async () => {
    const app = createApp();
    get(
      app,
      '/ready',
      readiness(
        {
          hang: () => new Promise<void>(() => undefined),
          quick: () => undefined,
        },
        { timeout: 25 }
      )
    );
    const res = await handle(app, new Request('http://localhost/ready'));
    res.status.should.equal(503);
    const body = (await res.json()) as ReadinessBody;
    body.status.should.equal('fail');
    body.checks.hang?.should.match(/timeout of 25ms/);
    body.checks.quick?.should.equal('ok');
  });

  it('truncates failure reasons to 200 chars', async () => {
    const app = createApp();
    get(
      app,
      '/ready',
      readiness(
        { noisy: () => Promise.reject(new Error('x'.repeat(500))) },
        { timeout: 50 }
      )
    );
    const res = await handle(app, new Request('http://localhost/ready'));
    res.status.should.equal(503);
    const body = (await res.json()) as ReadinessBody;
    (body.checks.noisy?.length ?? 0).should.equal(200);
    (body.checks.noisy?.endsWith('…') ?? false).should.be.true;
  });

  it('stops waiting when the client aborts — ctx.signal races the budget', async () => {
    const controller = new AbortController();
    let started = false;
    const app = createApp();
    get(
      app,
      '/ready',
      readiness(
        {
          db: () => {
            started = true;
            return new Promise<void>(() => undefined);
          },
        },
        { timeout: 5000 }
      )
    );
    const pending = handle(app, new Request('http://localhost/ready'), {
      signal: controller.signal,
    });
    await poll(() => started);
    controller.abort();
    const res = await pending;
    res.status.should.equal(503);
    const body = (await res.json()) as ReadinessBody;
    body.checks.db?.should.match(/abort/i);
  });
});

describe('createGate', () => {
  it('is a HealthCheck: open passes, closed throws the reason, open() resets', async () => {
    const gate = createGate();
    const app = createApp();
    get(app, '/ready', readiness({ gate: gate.check }));

    (await handle(app, new Request('http://localhost/ready'))).status.should.equal(200);

    gate.close('draining');
    const res = await handle(app, new Request('http://localhost/ready'));
    res.status.should.equal(503);
    ((await res.json()) as ReadinessBody).checks.should.deep.equal({ gate: 'draining' });

    gate.open();
    (await handle(app, new Request('http://localhost/ready'))).status.should.equal(200);
  });

  it('defaults the close reason', () => {
    const gate = createGate();
    gate.close();
    let error: unknown;
    try {
      gate.check();
    } catch (e) {
      error = e;
    }
    (error as Error).message.should.equal('unavailable');
  });
});
