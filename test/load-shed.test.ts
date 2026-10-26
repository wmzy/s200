import { describe, it } from 'vitest';

import { createApp, get, handle, use } from '../src/app';
import { isHttpError } from '../src/errors';
import { loadShed } from '../src/load-shed';
import { json, setHeader } from '../src/respond';

// A pressure knob: every reading is whatever the test last dialed in, so
// the gate is driven by fake sensors — no real load, no timing dependence.
function pressure(): {
  readings: { eventLoopUtilization: number; rssBytes: number; inFlight: number };
  sensors: {
    eventLoopUtilization: () => number;
    rssBytes: () => number;
    inFlight: () => number;
  };
} {
  const readings = { eventLoopUtilization: 0, rssBytes: 0, inFlight: 0 };
  return {
    readings,
    sensors: {
      eventLoopUtilization: () => readings.eventLoopUtilization,
      rssBytes: () => readings.rssBytes,
      inFlight: () => readings.inFlight,
    },
  };
}

// A controllable future — the test's stand-in for slow handlers, so exactly
// N requests are observably inside the chain at the same time.
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('loadShed', function () {
  it('sheds over the ELU threshold with a 503 envelope + Retry-After, and passes once pressure clears', async function () {
    const p = pressure();
    let handled = 0;
    const app = createApp();
    use(
      app,
      loadShed({
        maxEventLoopUtilization: 0.9,
        retryAfterSeconds: 3,
        sensors: p.sensors,
      })
    );
    get(app, '/', () => {
      handled += 1;
      return new Response('ok');
    });

    p.readings.eventLoopUtilization = 0.95;
    const shed = await handle(app, new Request('http://localhost/'));
    shed.status.should.equal(503);
    (await shed.json()).should.deep.equal({ error: 'Service Unavailable' });
    (shed.headers.get('retry-after') ?? '').should.equal('3');

    // Recovery: pressure clears → the chain runs again, immediately.
    p.readings.eventLoopUtilization = 0.4;
    (await handle(app, new Request('http://localhost/'))).status.should.equal(
      200
    );
    handled.should.equal(1); // the shed request never reached the handler
  });

  it('sheds over the RSS threshold by bytes', async function () {
    const p = pressure();
    const app = createApp();
    use(app, loadShed({ maxRssBytes: 512, sensors: p.sensors }));
    get(app, '/', () => new Response('ok'));

    p.readings.rssBytes = 513;
    (await handle(app, new Request('http://localhost/'))).status.should.equal(
      503
    );
    // Exactly at the threshold passes — the bound is strictly-over.
    p.readings.rssBytes = 512;
    (await handle(app, new Request('http://localhost/'))).status.should.equal(
      200
    );
  });

  it('sheds when several dimensions trip at once — one 503, default Retry-After', async function () {
    const p = pressure();
    const app = createApp();
    use(
      app,
      loadShed({
        maxEventLoopUtilization: 0.5,
        maxRssBytes: 100,
        maxInFlight: 1,
        sensors: p.sensors,
      })
    );
    get(app, '/', () => new Response('ok'));

    p.readings.eventLoopUtilization = 0.9;
    p.readings.rssBytes = 500;
    p.readings.inFlight = 9;
    const shed = await handle(app, new Request('http://localhost/'));
    shed.status.should.equal(503);
    (await shed.json()).should.deep.equal({ error: 'Service Unavailable' });
    (shed.headers.get('retry-after') ?? '').should.equal('1');
  });

  it('leaves dimensions without a threshold unchecked — their sensors are never read', async function () {
    let eluReads = 0;
    let inFlightReads = 0;
    const app = createApp();
    use(
      app,
      loadShed({
        maxRssBytes: 100,
        sensors: {
          eventLoopUtilization: () => {
            eluReads += 1;
            return 0.99;
          },
          rssBytes: () => 50,
          inFlight: () => {
            inFlightReads += 1;
            return 999;
          },
        },
      })
    );
    get(app, '/', () => new Response('ok'));

    (await handle(app, new Request('http://localhost/'))).status.should.equal(
      200
    );
    eluReads.should.equal(0);
    inFlightReads.should.equal(0);
  });

  it('bypasses the probes: /healthz answers 200 while everything else sheds', async function () {
    const p = pressure();
    const app = createApp();
    use(
      app,
      loadShed({
        maxEventLoopUtilization: 0.5,
        bypass: (ctx) => ctx.url.pathname === '/healthz',
        sensors: p.sensors,
      })
    );
    get(app, '/healthz', () => new Response('ok'));
    get(app, '/', () => new Response('ok'));

    p.readings.eventLoopUtilization = 0.99;
    (
      await handle(app, new Request('http://localhost/healthz'))
    ).status.should.equal(200);
    (await handle(app, new Request('http://localhost/'))).status.should.equal(
      503
    );
  });

  it('enforces maxInFlight with its own incremental counter — the request past the cap sheds, the ledger recovers', async function () {
    const app = createApp();
    use(app, loadShed({ maxInFlight: 2, retryAfterSeconds: 7 }));
    let arrived = 0;
    const allIn = deferred();
    get(app, '/', async () => {
      arrived += 1;
      if (arrived === 2) {
        allIn.resolve();
      }
      await allIn.promise;
      return new Response('ok');
    });

    const first = handle(app, new Request('http://localhost/'));
    const second = handle(app, new Request('http://localhost/'));
    await allIn.promise; // both are inside their handlers: ledger = 2

    const third = await handle(app, new Request('http://localhost/'));
    third.status.should.equal(503);
    (third.headers.get('retry-after') ?? '').should.equal('7');
    arrived.should.equal(2); // the shed request never reached the handler

    allIn.resolve();
    (await first).status.should.equal(200);
    (await second).status.should.equal(200);
    // Ledger back to zero — recovery is immediate once the chain drains.
    (await handle(app, new Request('http://localhost/'))).status.should.equal(
      200
    );
  });

  it('takes the in-flight reading from an injected sensor (a shared counter)', async function () {
    const p = pressure();
    const app = createApp();
    use(app, loadShed({ maxInFlight: 4, sensors: p.sensors }));
    get(app, '/', () => new Response('ok'));

    p.readings.inFlight = 5;
    (await handle(app, new Request('http://localhost/'))).status.should.equal(
      503
    );
    p.readings.inFlight = 4; // exactly at the cap: not over
    (await handle(app, new Request('http://localhost/'))).status.should.equal(
      200
    );
  });

  it('reads real vitals through the default sensors when none are injected', async function () {
    const tight = createApp();
    use(tight, loadShed({ maxRssBytes: 1 })); // real RSS is always over 1 byte
    get(tight, '/', () => new Response('ok'));
    (
      await handle(tight, new Request('http://localhost/'))
    ).status.should.equal(503);

    const loose = createApp();
    use(
      loose,
      loadShed({ maxRssBytes: Number.MAX_SAFE_INTEGER, maxEventLoopUtilization: 1 })
    );
    get(loose, '/', () => new Response('ok'));
    (
      await handle(loose, new Request('http://localhost/'))
    ).status.should.equal(200);
  });

  it('hands the 503 rejection to a configured onError, Retry-After on the error', async function () {
    const seen: unknown[] = [];
    const p = pressure();
    const app = createApp({
      onError: (ctx, error) => {
        seen.push(error);
        json(ctx, { error: 'later' }, { status: 503 });
      },
    });
    use(app, loadShed({ maxEventLoopUtilization: 0.5, sensors: p.sensors }));
    get(app, '/', () => new Response('ok'));

    p.readings.eventLoopUtilization = 0.9;
    const res = await handle(app, new Request('http://localhost/'));
    // The policy owns the wire answer — no gate headers unless it adds them.
    res.status.should.equal(503);
    (await res.json()).should.deep.equal({ error: 'later' });
    (res.headers.get('retry-after') ?? '').should.equal('');
    const err = seen[0];
    isHttpError(err).should.be.true;
    if (isHttpError(err)) {
      err.status.should.equal(503);
      (err.headers?.['retry-after'] ?? '').should.equal('1');
    }
  });

  it('drains setHeader-pending headers onto the shed 503 (newResponse funnel regression)', async function () {
    const p = pressure();
    const app = createApp();
    use(app, async (ctx, next) => {
      setHeader(ctx, 'x-request-scope', 'abc');
      await next();
    });
    use(app, loadShed({ maxEventLoopUtilization: 0.5, sensors: p.sensors }));
    get(app, '/', () => new Response('ok'));

    p.readings.eventLoopUtilization = 0.9;
    const shed = await handle(app, new Request('http://localhost/'));
    shed.status.should.equal(503);
    (shed.headers.get('x-request-scope') ?? '').should.equal('abc');
    (shed.headers.get('retry-after') ?? '').should.equal('1');
  });

  it('rejects impossible thresholds at creation', function () {
    (() => loadShed({ maxEventLoopUtilization: 0 })).should.throw(
      /must be in \(0, 1\]/
    );
    (() => loadShed({ maxEventLoopUtilization: 1.5 })).should.throw(
      /must be in \(0, 1\]/
    );
    (() => loadShed({ maxRssBytes: 0 })).should.throw(/must be positive/);
    (() => loadShed({ maxInFlight: -1 })).should.throw(/must be positive/);
    (() => loadShed({ retryAfterSeconds: 0 })).should.throw(
      /positive integer/
    );
    (() => loadShed({ retryAfterSeconds: 1.5 })).should.throw(
      /positive integer/
    );
  });
});
