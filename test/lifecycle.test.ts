import type { NodeServer } from '../src/node';

import { afterEach, describe, it } from 'vitest';

import { createApp, get, handle } from '../src/app';
import { createGate, readiness } from '../src/health';
import { lifecycle } from '../src/lifecycle';
import { serve } from '../src/node';
import { json } from '../src/respond';

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

// Tiny-interval polling wait — deterministic without fake timers or sleeps.
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

// Every real server a test created, closed no matter how the test ends —
// a leaked listening socket would hang the vitest worker. The adapter's
// close() force-drops connections, so already-drained servers merely
// reject (swallowed) with ERR_SERVER_NOT_RUNNING.
const openServers: NodeServer[] = [];
afterEach(async () => {
  while (openServers.length > 0) {
    const server = openServers.pop();
    await server?.close().catch(() => undefined);
  }
});

describe('lifecycle', () => {
  it('waits for an in-flight request to finish before the drain resolves', async () => {
    const app = createApp();
    const release = deferred<void>();
    let hits = 0;
    get(app, '/slow', async (ctx) => {
      hits += 1;
      await release.promise;
      return json(ctx, { done: true });
    });
    const server = await serve(app, { port: 0 });
    openServers.push(server);
    const events: string[] = [];
    const lc = lifecycle(server, { timeout: 1000, signals: [] });
    const fetched = fetch(`${server.url}/slow`).then(async (res) => {
      await res.text();
      events.push('response');
    });
    await poll(() => hits === 1);
    const stopping = lc.stop();
    void stopping.then(() => events.push('stopped'));
    release.resolve();
    await fetched;
    await stopping;
    events.should.deep.equal(['response', 'stopped']);
  });

  it('force-closes a hung request at the budget instead of waiting forever', async () => {
    const app = createApp();
    let hits = 0;
    get(app, '/hang', () => {
      hits += 1;
      return new Promise<Response>(() => undefined);
    });
    const server = await serve(app, { port: 0 });
    openServers.push(server);
    const lc = lifecycle(server, { timeout: 120, signals: [] });
    let failed = false;
    void fetch(`${server.url}/hang`).catch(() => {
      failed = true;
    });
    await poll(() => hits === 1);
    await lc.stop();
    await poll(() => failed);
    failed.should.be.true;
  });

  it('stop() is idempotent — one drain, one close, one onShutdown', async () => {
    const events: string[] = [];
    let shutdowns = 0;
    const lc = lifecycle(
      {
        close: async () => {
          events.push('server-close');
        },
      },
      {
        signals: [],
        onShutdown: () => {
          shutdowns += 1;
          events.push('on-shutdown');
        },
      }
    );
    const first = lc.stop();
    const second = lc.stop();
    await first;
    await second;
    await lc.stopped;
    shutdowns.should.equal(1);
    events.should.deep.equal(['server-close', 'on-shutdown']);
  });

  it('closes the readiness gate as the first step of the drain, before sockets', async () => {
    const events: string[] = [];
    const lc = lifecycle(
      {
        close: async () => {
          events.push('server-close');
        },
      },
      {
        signals: [],
        readiness: {
          close: (reason) => {
            events.push(`readiness:${reason ?? ''}`);
          },
        },
      }
    );
    await lc.stop();
    events.should.deep.equal(['readiness:draining', 'server-close']);
  });

  it('rejects stop() when onShutdown throws, but stopped still resolves', async () => {
    const lc = lifecycle(
      { close: async () => undefined },
      {
        signals: [],
        onShutdown: () => {
          throw new Error('shutdown boom');
        },
      }
    );
    let caught: unknown;
    try {
      await lc.stop();
    } catch (error) {
      caught = error;
    }
    (caught as Error).message.should.equal('shutdown boom');
    await lc.stopped;
  });

  it('a signal-triggered onShutdown failure is logged, stopped still resolves', async () => {
    const sig = 'SIGUSR2';
    const errors: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]): void => {
      errors.push(args);
    };
    let listener: (() => void) | undefined;
    try {
      const lc = lifecycle(
        { close: async () => undefined },
        {
          signals: [sig],
          onShutdown: () => {
            throw new Error('boom');
          },
        }
      );
      listener = process.listeners(sig).at(-1) as (() => void) | undefined;
      listener?.();
      await lc.stopped;
    } finally {
      console.error = original;
      if (listener !== undefined) {
        process.removeListener(sig, listener);
      }
    }
    errors.length.should.equal(1);
    ((errors[0]?.[0] ?? {}) as Error).message.should.equal('boom');
  });

  it('registers on its signals and unregisters once the drain settles', async () => {
    const sig = 'SIGUSR2';
    const before = process.listeners(sig).length;
    const lc = lifecycle({ close: async () => undefined }, { signals: [sig] });
    process.listeners(sig).length.should.equal(before + 1);
    await lc.stop();
    process.listeners(sig).length.should.equal(before);
  });

  it('a second signal during the drain hard-kills instead of waiting the budget', async () => {
    const sig = 'SIGUSR2';
    const app = createApp();
    let hits = 0;
    get(app, '/hang', () => {
      hits += 1;
      return new Promise<Response>(() => undefined);
    });
    const server = await serve(app, { port: 0 });
    openServers.push(server);
    const before = process.listeners(sig).length;
    let shutdowns = 0;
    const lc = lifecycle(server, {
      signals: [sig],
      // The forced kill must beat this by orders of magnitude.
      timeout: 10_000,
      onShutdown: () => {
        shutdowns += 1;
      },
    });
    // lifecycle() appended its handler synchronously — the last one is ours.
    const listener = process.listeners(sig).at(-1) as (() => void) | undefined;
    let failed = false;
    void fetch(`${server.url}/hang`).catch(() => {
      failed = true;
    });
    await poll(() => hits === 1);
    const startedAt = Date.now();
    try {
      listener?.(); // first signal: the drain begins
      listener?.(); // second signal during the drain: hard kill
      await lc.stopped;
    } finally {
      if (listener !== undefined) {
        process.removeListener(sig, listener);
      }
    }
    (Date.now() - startedAt).should.be.lessThan(2000);
    shutdowns.should.equal(1);
    // stop() after a signal-triggered drain joins the settled drain.
    await lc.stop();
    shutdowns.should.equal(1);
    await poll(() => failed);
    process.listeners(sig).length.should.equal(before);
  });

  it('drains a bun-shaped raw server via stop(false), forcing stop() at the budget', async () => {
    const stops: (boolean | undefined)[] = [];
    let adapterCloses = 0;
    const never = new Promise<void>(() => undefined);
    const lc = lifecycle(
      {
        close: async () => {
          adapterCloses += 1;
        },
        server: {
          stop: (force?: boolean): Promise<void> => {
            stops.push(force);
            return force === undefined ? Promise.resolve() : never;
          },
        },
      },
      { signals: [], timeout: 60 }
    );
    await lc.stop();
    // The graceful attempt, then the forced kill — and never the adapter
    // close (it would force-drop in-flight connections itself).
    stops.should.deep.equal([false, undefined]);
    adapterCloses.should.equal(0);
  });

  it('resolves a bun drain as soon as the graceful stop settles, no forcing', async () => {
    const stops: (boolean | undefined)[] = [];
    const lc = lifecycle(
      {
        close: async () => undefined,
        server: {
          stop: (force?: boolean): Promise<void> => {
            stops.push(force);
            return Promise.resolve();
          },
        },
      },
      { signals: [], timeout: 50 }
    );
    await lc.stop();
    stops.should.deep.equal([false]);
  });

  it('bridges with the health battery: the drain trips the gate the probe reads', async () => {
    const gate = createGate();
    const probeApp = createApp();
    get(probeApp, '/ready', readiness({ gate: gate.check }));
    const app = createApp();
    const release = deferred<void>();
    let hits = 0;
    get(app, '/slow', async (ctx) => {
      hits += 1;
      await release.promise;
      return json(ctx, { ok: true });
    });
    const server = await serve(app, { port: 0 });
    openServers.push(server);
    const lc = lifecycle(server, { readiness: gate, signals: [], timeout: 1000 });

    (await handle(probeApp, new Request('http://localhost/ready'))).status.should.equal(200);

    const fetched = fetch(`${server.url}/slow`).then((res) => res.text());
    await poll(() => hits === 1);
    const stopping = lc.stop();
    // The gate tripped the moment the drain started — mid-drain probes 503.
    (await handle(probeApp, new Request('http://localhost/ready'))).status.should.equal(503);
    release.resolve();
    await fetched;
    await stopping;
    // And it stays closed after the drain.
    (await handle(probeApp, new Request('http://localhost/ready'))).status.should.equal(503);
  });
});
