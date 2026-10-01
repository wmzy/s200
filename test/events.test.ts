import { describe, expectTypeOf, it, vi } from 'vitest';

import { createBus } from '../src/events';

// vitest's should chain has no rejectedWith — capture rejections and
// assert on the value (jwt.test.ts pattern).
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined; // resolved — the assertions below will fail on it
}

// A promise the test resolves on demand: emitAsync's await semantics are
// proven with microtask-precise control, never real timers.
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: (value: void | PromiseLike<void>) => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('createBus', function () {
  it('delivers emit args to listeners in registration order, synchronously', function () {
    const bus = createBus<{ tick: [n: number, label: string] }>();
    const seen: string[] = [];
    bus.on('tick', (n, label) => {
      seen.push(`a:${label}:${n}`);
    });
    bus.on('tick', (n) => {
      seen.push(`b:${n}`);
    });
    bus.emit('tick', 7, 'go');
    seen.should.deep.equal(['a:go:7', 'b:7']);
  });

  it('collects listener errors without stopping peers and rethrows the first when no onError is subscribed', function () {
    const bus = createBus<{ boom: [] }>();
    const peers: number[] = [];
    bus.on('boom', () => {
      throw new Error('first');
    });
    bus.on('boom', () => {
      peers.push(1);
    });
    bus.on('boom', () => {
      throw new Error('second');
    });
    (() => bus.emit('boom')).should.throw('first');
    peers.should.deep.equal([1]);
  });

  it('routes collected errors to onError in listener order instead of throwing', function () {
    const bus = createBus<{ boom: [] }>();
    const routed: string[] = [];
    bus.onError((err) => {
      routed.push(err.message);
    });
    bus.on('boom', () => {
      throw new Error('first');
    });
    bus.on('boom', () => {
      throw new Error('second');
    });
    bus.emit('boom');
    routed.should.deep.equal(['first', 'second']);
  });

  it('fires once handlers exactly once, and honors a manual off before firing', function () {
    const bus = createBus<{ ping: [n: number] }>();
    const calls: number[] = [];
    const off = bus.once('ping', (n) => {
      calls.push(n);
    });
    bus.emit('ping', 1);
    bus.emit('ping', 2);
    calls.should.deep.equal([1]);
    off(); // already auto-removed — a no-op that must not throw
    const offEarly = bus.once('ping', () => {
      calls.push(99);
    });
    offEarly();
    bus.emit('ping', 3);
    calls.should.deep.equal([1]);
  });

  it('stops delivery after the returned off function runs (on and onError)', function () {
    const bus = createBus<{ ping: [] }>();
    const calls: number[] = [];
    const off = bus.on('ping', () => {
      calls.push(1);
    });
    off();
    bus.emit('ping');
    calls.should.deep.equal([]);

    const routed: string[] = [];
    const offErr = bus.onError((err) => {
      routed.push(err.message);
    });
    offErr();
    bus.on('ping', () => {
      throw new Error('boom');
    });
    // Channel empty again: the error reverts to the emit caller.
    (() => bus.emit('ping')).should.throw('boom');
    routed.should.deep.equal([]);
  });

  it('off(key, handler) removes one listener; off(key) drops the key; off() clears everything', function () {
    const bus = createBus<{ a: []; b: [] }>();
    const seen: string[] = [];
    const one = () => {
      seen.push('one');
    };
    const two = () => {
      seen.push('two');
    };
    bus.on('a', one);
    bus.on('a', two);
    bus.off('a', one);
    bus.emit('a');
    seen.should.deep.equal(['two']);

    bus.off('a');
    bus.emit('a');
    seen.should.deep.equal(['two']);

    bus.on('b', () => {
      seen.push('b');
    });
    bus.onError(() => {
      seen.push('err');
    });
    bus.off();
    bus.emit('a');
    bus.emit('b');
    seen.should.deep.equal(['two']);
    // off() cleared the error channel too: a fresh throwing listener now
    // rethrows to the emit caller even though an onError existed before.
    bus.on('a', () => {
      throw new Error('post-clear');
    });
    (() => bus.emit('a')).should.throw('post-clear');
  });

  it('emitAsync invokes listeners synchronously and resolves only after every returned promise settles', async function () {
    const bus = createBus<{ job: [] }>();
    const gate = deferred();
    const order: string[] = [];
    bus.on('job', () => gate.promise.then(() => {
      order.push('gated');
    }));
    bus.on('job', () => {
      order.push('sync');
    });
    bus.on('job', () => Promise.resolve().then(() => {
      order.push('micro');
    }));
    const done = bus.emitAsync('job');
    // All listeners were invoked synchronously; only the returned
    // promises are awaited.
    order.should.deep.equal(['sync']);
    // Two microtask ticks are not enough: the gate is still closed.
    const state = await Promise.race([
      done.then(() => 'resolved'),
      (async () => {
        await Promise.resolve();
        await Promise.resolve();
        return 'pending';
      })(),
    ]);
    state.should.equal('pending');
    gate.resolve();
    await done;
    order.should.deep.equal(['sync', 'micro', 'gated']);
  });

  it('emitAsync routes sync throws and async rejections through onError, awaiting once listeners too', async function () {
    const bus = createBus<{ job: [] }>();
    const routed: string[] = [];
    const finished: string[] = [];
    const gate = deferred();
    bus.onError((err) => {
      routed.push(err.message);
    });
    bus.on('job', () => {
      throw new Error('sync-throw');
    });
    bus.once('job', () => gate.promise.then(() => {
      finished.push('once');
    }));
    bus.on('job', () => Promise.reject(new Error('async-late')));
    const done = bus.emitAsync('job');
    gate.resolve();
    await done;
    finished.should.deep.equal(['once']);
    // Listener order, regardless of sync throw vs async rejection.
    routed.should.deep.equal(['sync-throw', 'async-late']);
  });

  it('emitAsync rejects with the first failing listener in registration order when no onError is subscribed', async function () {
    const bus = createBus<{ job: [] }>();
    const peers: number[] = [];
    bus.on('job', () => Promise.reject(new Error('async-first')));
    bus.on('job', () => {
      peers.push(1);
    });
    bus.on('job', () => {
      throw new Error('sync-second');
    });
    const err = (await rejectionOf(bus.emitAsync('job'))) as Error;
    err.message.should.equal('async-first');
    peers.should.deep.equal([1]);
  });

  it('honors maxListeners: the creation option, the default 10, one warning per key, 0 silences', function () {
    const warnings: unknown[][] = [];
    const warn = vi
      .spyOn(console, 'warn')
      .mockImplementation((...args: unknown[]) => {
        warnings.push(args);
      });

    const capped = createBus<{ t: [] }>({ maxListeners: 2 });
    capped.on('t', () => undefined);
    capped.on('t', () => undefined);
    warnings.length.should.equal(0);
    capped.on('t', () => undefined);
    warnings.length.should.equal(1);
    capped.on('t', () => undefined); // one warning per key, not per add
    warnings.length.should.equal(1);

    const plain = createBus<{ t: [] }>();
    for (let i = 0; i < 10; i += 1) {
      plain.on('t', () => undefined);
    }
    warnings.length.should.equal(1);
    plain.on('t', () => undefined); // default ceiling is 10
    warnings.length.should.equal(2);

    plain.setMaxListeners(0);
    plain.on('t', () => undefined);
    warnings.length.should.equal(2);

    warn.mockRestore();
  });
});

describe('createBus types', function () {
  type DocEvents = {
    'user:created': [id: number, name: string];
    'doc:saved': [];
  };

  it('narrows listener params and emit args by the events map', function () {
    const bus = createBus<DocEvents>();
    bus.on('user:created', (id, name) => {
      expectTypeOf(id).toEqualTypeOf<number>();
      expectTypeOf(name).toEqualTypeOf<string>();
      return `${id}:${name}`;
    });
    expectTypeOf(bus.emit<'user:created'>).toEqualTypeOf<
      (key: 'user:created', id: number, name: string) => void
    >();
    expectTypeOf(bus.emitAsync<'doc:saved'>).toEqualTypeOf<
      (key: 'doc:saved') => Promise<void>
    >();
    const off: () => void = bus.once('doc:saved', () => undefined);
    expectTypeOf(off).toEqualTypeOf<() => void>();
    bus.onError((err) => {
      expectTypeOf(err).toEqualTypeOf<Error>();
    });

    // Wrong shapes must not fit — keys and tuples are enforced.
    // @ts-expect-error -- handler params must be (number, string)
    bus.on('user:created', (id: string) => id);
    // @ts-expect-error -- 'user:created' takes (id, name); 'ada' is not the id's number
    bus.emit('user:created', 'ada');
    // @ts-expect-error -- 'nope' is not an event of DocEvents
    bus.on('nope', () => undefined);
    // @ts-expect-error -- 'doc:saved' carries no arguments
    bus.emitAsync('doc:saved', 1);
  });
});
