/**
 * OpenTelemetry-compatible tracing & metrics middleware — zero deps,
 * duck-typed.
 *
 * @module
 */

import type { Ctx, Middleware, Next } from './types';

/** `SpanStatusCode.ERROR` from @opentelemetry/api. */
const STATUS_ERROR = 2;

/** `SpanStatusCode.UNSET` from @opentelemetry/api. */
const STATUS_UNSET = 1;

/**
 * Minimal structural span — a subset of @opentelemetry/api's `Span`. Any
 * real OTel span satisfies it, so bridging is a lambda (see
 * {@link Tracer}).
 */
export type Span = {
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: { code: number; message?: string }): void;
  recordException(error: unknown): void;
  end(): void;
}

/**
 * Minimal structural tracer — a subset of @opentelemetry/api's `Tracer`.
 * Bridge a real one with a lambda, adapting the parent context position:
 *
 * ```ts
 * import { trace } from 's200/otel';
 * import { propagation } from '@opentelemetry/api';
 *
 * use(app, trace({
 *   tracer: {
 *     startSpan: (name, opts) =>
 *       otelTracer.startSpan(name, { attributes: opts?.attributes }, opts?.parentContext),
 *   },
 *   // W3C trace context stays user-side (zero deps here): read the
 *   // `traceparent` header and hand back whatever your tracer accepts
 *   // as a parent context, e.g.
 *   // '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
 *   extract: (headers) =>
 *     propagation.extract(headers, { get: (c, k) => c.get(k) ?? undefined }),
 * }));
 * ```
 */
export type Tracer = {
  startSpan(
    name: string,
    options?: {
      attributes?: Record<string, string | number | boolean>;
      parentContext?: unknown;
    }
  ): Span;
}

/** Options for {@link trace}. */
export type TraceOptions = {
  /** Tracer to report through; defaults to a built-in no-op. */
  readonly tracer?: Tracer;
  /** Static attributes stamped on every span at `startSpan` time. */
  readonly attributes?: Record<string, string | number | boolean>;
  /** Span name; defaults to `` `${ctx.req.method} ${ctx.url.pathname}` ``. */
  readonly spanName?: (ctx: Ctx) => string;
  /**
   * Distributed-context hook: called with the request headers before
   * `startSpan`; its opaque return value is passed through as
   * `parentContext`. Parsing (e.g. of a W3C `traceparent` header) stays
   * user-side — this module has zero dependencies.
   */
  readonly extract?: (headers: Headers) => unknown;
};

// A span that records nothing — `trace()` without a tracer must cost
// nothing but still satisfy the Span contract.
const noopSpan: Span = {
  /* eslint-disable @typescript-eslint/no-empty-function -- no-op by contract */
  setAttribute() {},
  setStatus() {},
  recordException() {},
  end() {},
  /* eslint-enable @typescript-eslint/no-empty-function */
};

const noopTracer: Tracer = {
  startSpan: () => noopSpan,
};

/**
 * Tracing middleware: one span per request, started before `next()` and
 * finished on the unwind. The in-chain error boundary materializes every
 * response — handler's, 404/405 fallback, or the mapped 500 — before the
 * unwind, so the recorded `http.response.status_code` is always the real
 * one.
 *
 * On the unwind the span gets `http.request.method`, `url.path`,
 * `http.response.status_code` (0 if somehow no response), and
 * `s200.duration_ms` (milliseconds, fractional). Status mapping follows the
 * OTel HTTP semantic conventions: `>= 500` → `{ code: 2 }` (ERROR),
 * anything else → `{ code: 1 }` (UNSET — a 4xx is the client's story, not
 * an errored span; record explicit OK yourself if you want it).
 *
 * When `next()` rejects, the span records the exception, sets ERROR, ends,
 * and rethrows — onion semantics preserved, the boundary still maps the
 * response.
 *
 * `trace()` with no options costs ~nothing: it degrades to a bare
 * pass-through that just calls `next()`.
 */
export function trace(options: TraceOptions = {}): Middleware {
  const { tracer = noopTracer, attributes, spanName, extract } = options;
  if (
    tracer === noopTracer &&
    attributes === undefined &&
    spanName === undefined &&
    extract === undefined
  ) {
    return (_ctx: Ctx, next: Next) => next();
  }
  return async (ctx: Ctx, next: Next): Promise<void> => {
    const start = performance.now();
    const parentContext =
      extract === undefined ? undefined : extract(ctx.req.headers);
    const name =
      spanName === undefined
        ? `${ctx.req.method} ${ctx.url.pathname}`
        : spanName(ctx);
    const span = tracer.startSpan(name, { attributes, parentContext });
    try {
      await next();
      span.setAttribute('http.request.method', ctx.req.method);
      span.setAttribute('url.path', ctx.url.pathname);
      span.setAttribute(
        'http.response.status_code',
        ctx.res === undefined ? 0 : ctx.res.status
      );
      span.setAttribute('s200.duration_ms', performance.now() - start);
      span.setStatus({
        code:
          ctx.res !== undefined && ctx.res.status >= 500
            ? STATUS_ERROR
            : STATUS_UNSET,
      });
      span.end();
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: STATUS_ERROR });
      span.end();
      throw error;
    }
  };
}

/**
 * OTel attribute value: a scalar or a homogeneous array — the shape
 * `@opentelemetry/api` accepts, defined locally to stay zero-dep.
 */
export type AttributeValue =
  | string
  | number
  | boolean
  | readonly (string | number | boolean)[];

/** Attributes on a metric recording; keys are convention names. */
export type MetricAttributes = Record<string, AttributeValue>;

/**
 * Instrument creation hints — a subset of `@opentelemetry/api's` options:
 * human text, the unit label, and (for histograms) bucket advice.
 */
export type InstrumentOptions = {
  readonly description?: string;
  readonly unit?: string;
  readonly advice?: { readonly explicitBucketBoundaries?: readonly number[] };
};

/**
 * Minimal structural counter — a subset of @opentelemetry/api's `Counter`
 * (and structurally compatible with its `UpDownCounter`: same `add`).
 */
export type Counter = {
  add(value: number, attributes?: MetricAttributes): void;
};

/** Minimal structural histogram — a subset of @opentelemetry/api's. */
export type Histogram = {
  record(value: number, attributes?: MetricAttributes): void;
};

/**
 * Minimal structural meter — a subset of @opentelemetry/api's `Meter`. Any
 * real OTel meter satisfies it (method parameters check bivariantly, so
 * richer option/attribute types bridge fine), adapting instruments is a
 * lambda:
 *
 * ```ts
 * import { metrics } from 's200/otel';
 * import { metrics as otelMetrics } from '@opentelemetry/api';
 *
 * const m = otelMetrics.getMeter('s200');
 * use(app, metrics({
 *   meter: {
 *     createCounter: (name, opts) =>
 *       // active_requests is an UpDownCounter in OTel; a counter is the
 *       // duck-typed stand-in (add(+1) / add(-1) balances the same).
 *       name === 'http.server.active_requests'
 *         ? m.createUpDownCounter(name, opts)
 *         : m.createCounter(name, opts),
 *     createHistogram: (name, opts) => m.createHistogram(name, opts),
 *   },
 * }));
 * ```
 */
export type Meter = {
  createCounter(name: string, options?: InstrumentOptions): Counter;
  createHistogram(name: string, options?: InstrumentOptions): Histogram;
}

/** Options for {@link metrics}. */
export type MetricsOptions = {
  /** Meter to report through; defaults to a built-in no-op. */
  readonly meter?: Meter;
  /**
   * Extra attributes on every recording — a static record, or a per-request
   * callback. Spread over the defaults, so it can add (`url.route`,
   * `service.name`) or override them.
   */
  readonly attributes?:
    | ((ctx: Ctx) => MetricAttributes)
    | MetricAttributes;
  /** Clock override (tests, deterministic replays); default `performance.now`. */
  readonly now?: () => number;
};

// Instruments that record nothing — `metrics()` without a meter must cost
// nothing but still satisfy the Counter/Histogram contracts.
const noopCounter: Counter = {
  /* eslint-disable @typescript-eslint/no-empty-function -- no-op by contract */
  add() {},
  /* eslint-enable @typescript-eslint/no-empty-function */
};

const noopHistogram: Histogram = {
  /* eslint-disable @typescript-eslint/no-empty-function -- no-op by contract */
  record() {},
  /* eslint-enable @typescript-eslint/no-empty-function */
};

const noopMeter: Meter = {
  createCounter: () => noopCounter,
  createHistogram: () => noopHistogram,
};

/**
 * Metrics middleware: counts and times every request through the chain.
 *
 * Instruments, named per the OTel HTTP semantic conventions:
 * - `http.server.requests` — counter, +1 per request as it enters;
 * - `http.server.active_requests` — counter, +1 before `next()` and -1 in a
 *   `finally`, so the gauge balances even when the chain throws;
 * - `http.server.request.duration` — histogram in **milliseconds** (the
 *   `unit: 'ms'` hint says so; the OTel convention default is seconds —
 *   rescale in your backend view if you need `'s'`).
 *
 * Attributes follow the same conventions: `http.request.method` (uppercased)
 * and `http.response.status_code` — always the materialized status, because
 * the in-chain error boundary writes the 404/405/500 before the unwind, so
 * even mapped errors are classified by their real status. There is no
 * separate error counter: slice on `http.response.status_code >= 500`.
 *
 * `attributes` resolves before anything is counted, so a throwing callback
 * records nothing and propagates — same pre-`next()` behavior as
 * {@link trace} (a request that never started has no duration). When
 * `next()` itself rejects (an error raised above the boundary — a
 * middleware, not a handler), the `finally` still balances
 * `active_requests` and records the duration with status 0 (nothing
 * materialized yet), then rethrows.
 *
 * `metrics()` with no options costs ~nothing: no-op instruments, and with no
 * `attributes` either it degrades to a bare pass-through.
 */
export function metrics(options: MetricsOptions = {}): Middleware {
  const { attributes } = options;
  // Bound lazily: a detached `performance.now` loses its receiver in Node.
  const now = options.now ?? ((): number => performance.now());
  const meter = options.meter ?? noopMeter;
  if (meter === noopMeter && attributes === undefined) {
    return (_ctx: Ctx, next: Next) => next();
  }
  const requests = meter.createCounter('http.server.requests', {
    description: 'Total number of HTTP server requests handled.',
  });
  const duration = meter.createHistogram('http.server.request.duration', {
    unit: 'ms',
    description: 'Duration of HTTP server requests.',
  });
  const active = meter.createCounter('http.server.active_requests', {
    description: 'Number of active HTTP server requests.',
  });
  return async (ctx: Ctx, next: Next): Promise<void> => {
    // Resolve custom attributes first: a throwing callback must leave
    // every instrument untouched.
    const custom =
      attributes === undefined
        ? undefined
        : typeof attributes === 'function'
          ? attributes(ctx)
          : attributes;
    const method = ctx.req.method.toUpperCase();
    const start = now();
    requests.add(1, { 'http.request.method': method, ...custom });
    active.add(1);
    try {
      await next();
    } finally {
      active.add(-1);
      duration.record(now() - start, {
        'http.request.method': method,
        // 0 when nothing materialized (a middleware error still on its
        // way out) — same sentinel trace() uses.
        'http.response.status_code':
          ctx.res === undefined ? 0 : ctx.res.status,
        ...custom,
      });
    }
  };
}
