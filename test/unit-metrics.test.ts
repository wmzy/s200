import type { UnitMetrics } from '../src/unit-metrics';

import { describe, it } from 'vitest';

import { createApp, get, handle, use } from '../src/app';
import { json } from '../src/respond';
import {
  PROMETHEUS_CONTENT_TYPE,
  createUnitMetrics,
  prometheusText,
  unitMetricsEndpoint,
} from '../src/unit-metrics';

// A controllable future — the test's stand-in for slow handlers, so exactly
// N requests are observably inside the chain at the same time.
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// An app whose single route parks every request on a shared barrier; the
// i-th arriving request opens the barrier, so the test waits until all
// `count` requests are in flight inside their handlers.
function slowApp(
  m: { readonly middleware: Parameters<typeof use>[1] },
  count: number
): { start(): Promise<Response>[]; allIn: Promise<void> } {
  const app = createApp();
  use(app, m.middleware);
  let arrived = 0;
  const allIn = deferred();
  get(app, '/slow', async (ctx) => {
    arrived += 1;
    if (arrived === count) {
      allIn.resolve();
    }
    await allIn.promise;
    return json(ctx, { ok: true });
  });
  return {
    allIn: allIn.promise,
    start: () =>
      Array.from({ length: count }, () =>
        handle(app, new Request('http://localhost/slow'))
      ),
  };
}

describe('createUnitMetrics middleware', () => {
  it('sees inFlight=3 inside three concurrent handlers, then settles at 0/3 completed/3 peak', async () => {
    const m = createUnitMetrics();
    const slow = slowApp(m, 3);
    const pending = slow.start();
    await slow.allIn;
    const mid = m.snapshot();
    mid.inFlight.should.equal(3);
    mid.requests.should.equal(0);
    mid.maxInFlight.should.equal(3);
    mid.queueDepth.should.equal(0); // uncapped: queueDepth stays 0
    const responses = await Promise.all(pending);
    responses.map((r) => r.status).should.deep.equal([200, 200, 200]);
    const end = m.snapshot();
    end.inFlight.should.equal(0);
    end.requests.should.equal(3);
    end.maxInFlight.should.equal(3);
    end.warm.should.be.true; // warmAfter defaults to 1
  });

  it('counts a completed 404 too — the middleware wraps the whole unit, not just matched routes', async () => {
    const m = createUnitMetrics();
    const app = createApp();
    use(app, m.middleware);
    const res = await handle(app, new Request('http://localhost/nowhere'));
    res.status.should.equal(404);
    m.snapshot().requests.should.equal(1);
  });

  it('reports queueDepth = inFlight - maxConcurrency only while past the announced cap', async () => {
    const m = createUnitMetrics({ maxConcurrency: 2 });
    const slow = slowApp(m, 3);
    const pending = slow.start();
    await slow.allIn;
    m.snapshot().queueDepth.should.equal(1); // 3 in flight, cap 2
    await Promise.all(pending);
    m.snapshot().queueDepth.should.equal(0); // 0 in flight — nothing queued
  });
});

describe('warm', () => {
  it('turns warm only after warmAfter completions and never un-sets mid-window', async () => {
    const m = createUnitMetrics({ warmAfter: 2 });
    const app = createApp();
    use(app, m.middleware);
    get(app, '/', (ctx) => json(ctx, { ok: true }));
    const one = async (): Promise<void> => {
      await handle(app, new Request('http://localhost/'));
    };
    await one();
    m.snapshot().warm.should.be.false;
    await one();
    m.snapshot().warm.should.be.true;
    await one();
    m.snapshot().warm.should.be.true; // sticky
  });
});

describe('snapshot vitals', () => {
  it('keeps ELU in 0..1 and reports live memory and the window start', async () => {
    const m = createUnitMetrics();
    const created = Date.now();
    // Some busy-ish work between creation and the first snapshot: the first
    // reading must be the delta since creation, not garbage or NaN.
    let spin = 0;
    for (let i = 0; i < 200_000; i += 1) {
      spin += i % 7;
    }
    spin.should.be.at.least(0); // keep the loop honest for the optimizer
    const first = m.snapshot();
    (first.eventLoopUtilization >= 0 && first.eventLoopUtilization <= 1).should
      .be.true;
    first.rss.should.be.above(0);
    first.heapUsed.should.be.above(0);
    first.startedAt.should.be.at.most(created + 5); // Date.now() at creation
    // Back-to-back snapshots on an idle loop read 0, never NaN.
    const idle = m.snapshot();
    (idle.eventLoopUtilization >= 0 && idle.eventLoopUtilization <= 1).should
      .be.true;
  });
});

describe('unitMetricsEndpoint', () => {
  it('serves the full snapshot body with status 200', async () => {
    const m = createUnitMetrics({ maxConcurrency: 2 });
    const app = createApp();
    use(app, m.middleware);
    get(app, '/metrics', unitMetricsEndpoint(m));
    const res = await handle(app, new Request('http://localhost/metrics'));
    res.status.should.equal(200);
    (res.headers.get('content-type') ?? '').should.equal('application/json');
    const body = (await res.json()) as UnitMetrics;
    Object.keys(body).sort().should.deep.equal([
      'eventLoopUtilization',
      'heapUsed',
      'inFlight',
      'maxInFlight',
      'queueDepth',
      'requests',
      'rss',
      'startedAt',
      'warm',
    ]);
    // Wrapped by its own middleware, the scrape honestly observes itself:
    // one request in flight, zero completed yet.
    body.inFlight.should.equal(1);
    body.requests.should.equal(0);
    body.warm.should.be.false;
  });
});

describe('reset', () => {
  it('zeroes the counters, clears warmth, and reopens the window', async () => {
    const m = createUnitMetrics();
    const app = createApp();
    use(app, m.middleware);
    get(app, '/', (ctx) => json(ctx, { ok: true }));
    await handle(app, new Request('http://localhost/'));
    const before = m.snapshot();
    before.requests.should.equal(1);
    before.warm.should.be.true;

    m.reset();
    const after = m.snapshot();
    after.inFlight.should.equal(0);
    after.maxInFlight.should.equal(0);
    after.requests.should.equal(0);
    after.queueDepth.should.equal(0);
    after.warm.should.be.false;
    after.startedAt.should.be.at.least(before.startedAt);

    // Counting continues in the fresh window.
    await handle(app, new Request('http://localhost/'));
    const again = m.snapshot();
    again.requests.should.equal(1);
    again.maxInFlight.should.equal(1);
    again.warm.should.be.true;
  });
});

describe('prometheusText', () => {
  // A fully crafted snapshot: prometheusText is pure, so the exact bytes are
  // deterministic and can be asserted line by line.
  const crafted: UnitMetrics = {
    inFlight: 3,
    maxInFlight: 7,
    requests: 42,
    queueDepth: 1,
    eventLoopUtilization: 0.25,
    rss: 123_456_789,
    heapUsed: 9_876_543,
    warm: true,
    startedAt: 1_761_415_000_123, // ms -> 1761415000.123 s
  };

  it('renders the exact 0.0.4 exposition: HELP/TYPE + one gauge per field, declaration order', () => {
    prometheusText(crafted).should.equal(
      [
        "# HELP s200_unit_in_flight Requests currently inside the unit's chain.",
        '# TYPE s200_unit_in_flight gauge',
        's200_unit_in_flight 3',
        '# HELP s200_unit_max_in_flight Highest inFlight ever seen - the peak the unit actually absorbed.',
        '# TYPE s200_unit_max_in_flight gauge',
        's200_unit_max_in_flight 7',
        '# HELP s200_unit_requests Requests that finished (handler resolved or errored) - completions, not arrivals.',
        '# TYPE s200_unit_requests gauge',
        's200_unit_requests 42',
        '# HELP s200_unit_queue_depth max(0, inFlight - maxConcurrency); always 0 when no cap was announced.',
        '# TYPE s200_unit_queue_depth gauge',
        's200_unit_queue_depth 1',
        '# HELP s200_unit_event_loop_utilization Event-loop busy ratio 0..1 since the previous snapshot.',
        '# TYPE s200_unit_event_loop_utilization gauge',
        's200_unit_event_loop_utilization 0.25',
        '# HELP s200_unit_rss_bytes Resident set size in bytes.',
        '# TYPE s200_unit_rss_bytes gauge',
        's200_unit_rss_bytes 123456789',
        '# HELP s200_unit_heap_used_bytes JS heap in use in bytes.',
        '# TYPE s200_unit_heap_used_bytes gauge',
        's200_unit_heap_used_bytes 9876543',
        '# HELP s200_unit_warm 1 once requests reached warmAfter (default 1) - until reset(), else 0.',
        '# TYPE s200_unit_warm gauge',
        's200_unit_warm 1',
        "# HELP s200_unit_started_at_seconds Unix time (seconds) of the measurement window's start - creation or last reset().",
        '# TYPE s200_unit_started_at_seconds gauge',
        's200_unit_started_at_seconds 1761415000.123',
      ].join('\n') + '\n'
    );
  });

  it('maps the warm boolean to 0/1, not true/false', () => {
    const cold = prometheusText({ ...crafted, warm: false });
    cold.should.contain('s200_unit_warm 0');
    cold.should.not.contain('s200_unit_warm true');
  });

  it('never emits NaN or non-finite values — the format has no literals for them', () => {
    const poisoned = prometheusText({
      ...crafted,
      eventLoopUtilization: Number.NaN,
      rss: Number.POSITIVE_INFINITY,
    });
    poisoned.should.contain('s200_unit_event_loop_utilization 0');
    poisoned.should.contain('s200_unit_rss_bytes 0');
    poisoned.should.not.contain('NaN');
    poisoned.should.not.contain('Infinity');
  });
});

describe('unitMetricsEndpoint format option', () => {
  it("serves Prometheus text with the 0.0.4 content-type when format: 'prometheus'", async () => {
    const m = createUnitMetrics({ maxConcurrency: 2 });
    const app = createApp();
    use(app, m.middleware);
    get(app, '/metrics', unitMetricsEndpoint(m, { format: 'prometheus' }));
    const res = await handle(app, new Request('http://localhost/metrics'));
    res.status.should.equal(200);
    (res.headers.get('content-type') ?? '').should.equal(PROMETHEUS_CONTENT_TYPE);
    const body = await res.text();
    // Wrapped by its own middleware, the scrape honestly observes itself:
    // one request in flight, still cold.
    body.should.contain('# TYPE s200_unit_in_flight gauge');
    body.should.contain('s200_unit_in_flight 1');
    body.should.contain('s200_unit_warm 0');
    body.endsWith('\n').should.be.true;
  });

  it('stays on the JSON body and content-type when no format is given', async () => {
    const m = createUnitMetrics();
    const app = createApp();
    get(app, '/metrics', unitMetricsEndpoint(m));
    const res = await handle(app, new Request('http://localhost/metrics'));
    (res.headers.get('content-type') ?? '').should.equal('application/json');
    ((await res.json()) as UnitMetrics).requests.should.equal(0);
  });
});
