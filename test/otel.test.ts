import { describe, it } from 'vitest';

import { createApp, get, handle, use } from '../src/app';
import {
  metrics,
  trace,
  type InstrumentOptions,
  type Meter,
  type MetricAttributes,
  type Span,
  type Tracer,
} from '../src/otel';
import { text } from '../src/respond';

/** What the fake tracer captured for one span's whole lifecycle. */
type Recorded = {
  name: string;
  startAttributes: Record<string, string | number | boolean> | undefined;
  parentContext: unknown;
  attributes: Record<string, string | number | boolean>;
  status: { code: number; message?: string } | undefined;
  exceptions: unknown[];
  ended: boolean;
};

/** A tracer that records every span it is asked to start. */
function fakeTracer(): { tracer: Tracer; spans: Recorded[] } {
  const spans: Recorded[] = [];
  const tracer: Tracer = {
    startSpan(name, options) {
      const rec: Recorded = {
        name,
        startAttributes: options?.attributes,
        parentContext: options?.parentContext,
        attributes: {},
        status: undefined,
        exceptions: [],
        ended: false,
      };
      spans.push(rec);
      const span: Span = {
        setAttribute(key, value) {
          rec.attributes[key] = value;
        },
        setStatus(status) {
          rec.status = status;
        },
        recordException(error) {
          rec.exceptions.push(error);
        },
        end() {
          rec.ended = true;
        },
      };
      return span;
    },
  };
  return { tracer, spans };
}

describe('trace', function () {
  it('spans a successful request with method, path, status and duration', async function () {
    const { tracer, spans } = fakeTracer();
    const app = createApp();
    use(app, trace({ tracer }));
    get(app, '/x', (ctx) => text(ctx, 'ok'));
    const res = await handle(app, new Request('http://localhost/x'));
    res.status.should.equal(200);

    spans.should.have.length(1);
    const span = spans[0];
    span?.name.should.equal('GET /x');
    span?.attributes['http.request.method']?.should.equal('GET');
    span?.attributes['url.path']?.should.equal('/x');
    span?.attributes['http.response.status_code']?.should.equal(200);
    (span?.attributes['s200.duration_ms'] as number).should.be.at.least(0);
    span?.status?.code.should.equal(1); // UNSET: 2xx is not an errored span
    span?.exceptions.should.have.length(0);
    span?.ended.should.equal(true);
  });

  it('sees the materialized 404 of an unmatched request', async function () {
    const { tracer, spans } = fakeTracer();
    const app = createApp();
    use(app, trace({ tracer }));
    const res = await handle(app, new Request('http://localhost/nope'));
    res.status.should.equal(404);

    spans.should.have.length(1);
    const span = spans[0];
    span?.name.should.equal('GET /nope');
    span?.attributes['http.response.status_code']?.should.equal(404);
    span?.status?.code.should.equal(1); // UNSET: 4xx is the client's story
    span?.ended.should.equal(true);
  });

  it('marks a throwing handler as ERROR via the materialized 500', async function () {
    const { tracer, spans } = fakeTracer();
    const app = createApp();
    use(app, trace({ tracer }));
    get(app, '/x', () => {
      throw new Error('boom');
    });
    const res = await handle(app, new Request('http://localhost/x'));
    res.status.should.equal(500);

    // The error boundary sits below the app middlewares: next() resolves
    // with the mapped 500 already written, so no exception reaches trace.
    spans.should.have.length(1);
    const span = spans[0];
    span?.attributes['http.response.status_code']?.should.equal(500);
    span?.status?.code.should.equal(2); // ERROR
    span?.ended.should.equal(true);
  });

  it('records the exception, rethrows, and the mapped 500 still comes out', async function () {
    const { tracer, spans } = fakeTracer();
    const app = createApp();
    use(app, trace({ tracer }));
    const boom = new Error('middleware boom');
    // An error raised above the in-chain boundary (a middleware, not a
    // handler) is the case where next() rejects at trace's level.
    use(app, async () => {
      throw boom;
    });
    get(app, '/x', (ctx) => text(ctx, 'ok'));
    const res = await handle(app, new Request('http://localhost/x'));
    res.status.should.equal(500);

    spans.should.have.length(1);
    const span = spans[0];
    span?.exceptions.should.deep.equal([boom]);
    span?.status?.code.should.equal(2); // ERROR
    span?.ended.should.equal(true);
  });

  it('marks >= 500 responses as ERROR even when a handler answered them', async function () {
    const { tracer, spans } = fakeTracer();
    const app = createApp();
    use(app, trace({ tracer }));
    get(app, '/x', () => new Response('no', { status: 503 }));
    const res = await handle(app, new Request('http://localhost/x'));
    res.status.should.equal(503);

    const span = spans[0];
    span?.attributes['http.response.status_code']?.should.equal(503);
    span?.status?.code.should.equal(2); // ERROR
  });

  it('honors a spanName override', async function () {
    const { tracer, spans } = fakeTracer();
    const app = createApp();
    use(
      app,
      trace({
        tracer,
        spanName: (ctx) => `route:${ctx.req.method}:${ctx.url.pathname}`,
      })
    );
    get(app, '/x', (ctx) => text(ctx, 'ok'));
    await handle(app, new Request('http://localhost/x'));
    spans[0]?.name.should.equal('route:GET:/x');
  });

  it('wires extract through to parentContext', async function () {
    const { tracer, spans } = fakeTracer();
    const seenHeaders: Headers[] = [];
    const traceparent =
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const app = createApp();
    use(
      app,
      trace({
        tracer,
        extract: (headers) => {
          seenHeaders.push(headers);
          return { traceparent: headers.get('traceparent') };
        },
      })
    );
    get(app, '/x', (ctx) => text(ctx, 'ok'));
    await handle(
      app,
      new Request('http://localhost/x', { headers: { traceparent } })
    );

    seenHeaders.should.have.length(1);
    const span = spans[0];
    (span?.parentContext as { traceparent: string | null }).should.deep.equal({
      traceparent,
    });
  });

  it('merges the attributes option in at startSpan time', async function () {
    const { tracer, spans } = fakeTracer();
    const app = createApp();
    use(
      app,
      trace({ tracer, attributes: { 'service.name': 's200-tests', n: 7 } })
    );
    get(app, '/x', (ctx) => text(ctx, 'ok'));
    await handle(app, new Request('http://localhost/x'));
    spans[0]!.startAttributes!.should.deep.equal({
      'service.name': 's200-tests',
      n: 7,
    });
  });

  it('with no options degrades to a pass-through that still serves', async function () {
    const app = createApp();
    use(app, trace());
    get(app, '/x', (ctx) => text(ctx, 'ok'));
    const res = await handle(app, new Request('http://localhost/x'));
    res.status.should.equal(200);
    (await res.text()).should.equal('ok');
  });
});

/** One instrument invocation captured by the fake meter. */
type Recording = {
  instrument: string;
  value: number;
  attributes: MetricAttributes | undefined;
};

/** One instrument the fake meter was asked to create. */
type CreatedInstrument = {
  name: string;
  kind: 'counter' | 'histogram';
  options: InstrumentOptions | undefined;
};

/** A meter that records every instrument it creates and every call. */
function fakeMeter(): {
  meter: Meter;
  calls: Recording[];
  instruments: CreatedInstrument[];
} {
  const calls: Recording[] = [];
  const instruments: CreatedInstrument[] = [];
  const meter: Meter = {
    createCounter(name, options) {
      instruments.push({ name, kind: 'counter', options });
      return {
        add(value, attributes) {
          calls.push({ instrument: name, value, attributes });
        },
      };
    },
    createHistogram(name, options) {
      instruments.push({ name, kind: 'histogram', options });
      return {
        record(value, attributes) {
          calls.push({ instrument: name, value, attributes });
        },
      };
    },
  };
  return { meter, calls, instruments };
}

/** The calls recorded against one instrument, in order. */
function callsOn(
  calls: readonly Recording[],
  instrument: string
): Recording[] {
  return calls.filter((call) => call.instrument === instrument);
}

/** Net of the active_requests gauge: 0 once every request has unwound. */
function activeBalance(calls: readonly Recording[]): number {
  return callsOn(calls, 'http.server.active_requests').reduce(
    (sum, call) => sum + call.value,
    0
  );
}

describe('metrics', function () {
  it('counts, times and balances a successful request', async function () {
    const { meter, calls, instruments } = fakeMeter();
    const app = createApp();
    use(app, metrics({ meter }));
    get(app, '/x', (ctx) => text(ctx, 'ok'));
    const res = await handle(app, new Request('http://localhost/x'));
    res.status.should.equal(200);

    // Instruments are created once at wiring time, convention-named.
    instruments
      .map((created) => `${created.kind}:${created.name}`)
      .should.deep.equal([
        'counter:http.server.requests',
        'histogram:http.server.request.duration',
        'counter:http.server.active_requests',
      ]);
    instruments[1]?.options?.unit?.should.equal('ms');

    callsOn(calls, 'http.server.requests').should.deep.equal([
      {
        instrument: 'http.server.requests',
        value: 1,
        attributes: { 'http.request.method': 'GET' },
      },
    ]);
    callsOn(calls, 'http.server.active_requests').should.deep.equal([
      { instrument: 'http.server.active_requests', value: 1, attributes: undefined },
      { instrument: 'http.server.active_requests', value: -1, attributes: undefined },
    ]);
    const durations = callsOn(calls, 'http.server.request.duration');
    durations.should.have.length(1);
    durations[0]?.value.should.be.at.least(0);
    durations[0]!.attributes!.should.deep.equal({
      'http.request.method': 'GET',
      'http.response.status_code': 200,
    });
  });

  it('sees the materialized 500 of a throwing handler as the status', async function () {
    const { meter, calls } = fakeMeter();
    const app = createApp();
    use(app, metrics({ meter }));
    get(app, '/x', () => {
      throw new Error('boom');
    });
    const res = await handle(app, new Request('http://localhost/x'));
    res.status.should.equal(500);

    // The in-chain boundary maps the throw before the unwind: no
    // exception ever reaches metrics, the 500 is just the status.
    const durations = callsOn(calls, 'http.server.request.duration');
    durations.should.have.length(1);
    durations[0]?.attributes?.['http.response.status_code']?.should.equal(500);
    activeBalance(calls).should.equal(0);
  });

  it('sees the materialized 404 of an unmatched request', async function () {
    const { meter, calls } = fakeMeter();
    const app = createApp();
    use(app, metrics({ meter }));
    const res = await handle(app, new Request('http://localhost/nope'));
    res.status.should.equal(404);

    callsOn(calls, 'http.server.requests').should.have.length(1);
    callsOn(calls, 'http.server.request.duration')[0]?.attributes?.[
      'http.response.status_code'
    ]?.should.equal(404);
    activeBalance(calls).should.equal(0);
  });

  it('sees the materialized 405 of a wrong-method request', async function () {
    const { meter, calls } = fakeMeter();
    const app = createApp();
    use(app, metrics({ meter }));
    get(app, '/x', (ctx) => text(ctx, 'ok'));
    const res = await handle(
      app,
      new Request('http://localhost/x', { method: 'POST' })
    );
    res.status.should.equal(405);

    callsOn(calls, 'http.server.request.duration')[0]?.attributes?.[
      'http.response.status_code'
    ]?.should.equal(405);
    activeBalance(calls).should.equal(0);
  });

  it('merges the attributes callback over the defaults', async function () {
    const { meter, calls } = fakeMeter();
    const app = createApp();
    use(
      app,
      metrics({
        meter,
        attributes: (ctx) => ({
          'url.path': ctx.url.pathname,
          'http.request.method': 'forced', // an override must win
        }),
      })
    );
    get(app, '/x', (ctx) => text(ctx, 'ok'));
    await handle(app, new Request('http://localhost/x'));

    callsOn(calls, 'http.server.requests')[0]!.attributes!.should.deep.equal({
      'http.request.method': 'forced',
      'url.path': '/x',
    });
    callsOn(calls, 'http.server.request.duration')[0]!.attributes!.should.deep.equal(
      {
        'http.request.method': 'forced',
        'http.response.status_code': 200,
        'url.path': '/x',
      }
    );
  });

  it('records the exact duration of an injected clock', async function () {
    const { meter, calls } = fakeMeter();
    const times = [1_000, 1_042];
    let tick = 0;
    const app = createApp();
    use(
      app,
      metrics({
        meter,
        now: () => times[tick++] ?? Number.NaN,
        attributes: { 'service.name': 's200-tests', tags: ['a', 'b'] },
      })
    );
    get(app, '/x', (ctx) => text(ctx, 'ok'));
    await handle(app, new Request('http://localhost/x'));

    const durations = callsOn(calls, 'http.server.request.duration');
    durations.should.have.length(1);
    durations[0]?.value.should.equal(42);
    durations[0]!.attributes!.should.deep.equal({
      'http.request.method': 'GET',
      'http.response.status_code': 200,
      'service.name': 's200-tests',
      tags: ['a', 'b'],
    });
  });

  it('balances the gauge and records status 0 when a middleware errors below', async function () {
    const { meter, calls } = fakeMeter();
    const app = createApp();
    use(app, metrics({ meter }));
    // An error raised above the in-chain boundary (a middleware, not a
    // handler) is the case where next() rejects at metrics' level.
    use(app, async () => {
      throw new Error('middleware boom');
    });
    get(app, '/x', (ctx) => text(ctx, 'ok'));
    const res = await handle(app, new Request('http://localhost/x'));
    res.status.should.equal(500);

    // The finally still balances the gauge and records — with status 0,
    // since nothing has materialized while the error is on its way out.
    activeBalance(calls).should.equal(0);
    const durations = callsOn(calls, 'http.server.request.duration');
    durations.should.have.length(1);
    durations[0]?.attributes?.['http.response.status_code']?.should.equal(0);
  });

  it('records nothing when the attributes callback throws before next()', async function () {
    const { meter, calls } = fakeMeter();
    const app = createApp();
    use(
      app,
      metrics({
        meter,
        attributes: () => {
          throw new Error('attrs boom');
        },
      })
    );
    get(app, '/x', (ctx) => text(ctx, 'ok'));
    const res = await handle(app, new Request('http://localhost/x'));
    res.status.should.equal(500);

    calls.should.deep.equal([]);
  });

  it('stacks with trace() in either order', async function () {
    for (const first of ['metrics', 'trace'] as const) {
      const { tracer, spans } = fakeTracer();
      const { meter, calls } = fakeMeter();
      const app = createApp();
      use(app, first === 'metrics' ? metrics({ meter }) : trace({ tracer }));
      use(app, first === 'metrics' ? trace({ tracer }) : metrics({ meter }));
      get(app, '/x', (ctx) => text(ctx, 'ok'));
      const res = await handle(app, new Request('http://localhost/x'));
      res.status.should.equal(200);

      spans.should.have.length(1);
      spans[0]?.attributes['http.response.status_code']?.should.equal(200);
      spans[0]?.ended.should.equal(true);
      callsOn(calls, 'http.server.requests').should.have.length(1);
      callsOn(calls, 'http.server.request.duration').should.have.length(1);
      activeBalance(calls).should.equal(0);
    }
  });

  it('with no options degrades to a pass-through that still serves', async function () {
    const app = createApp();
    use(app, metrics());
    get(app, '/x', (ctx) => text(ctx, 'ok'));
    const res = await handle(app, new Request('http://localhost/x'));
    res.status.should.equal(200);
    (await res.text()).should.equal('ok');
  });
});
