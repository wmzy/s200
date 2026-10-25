/**
 * Server-Timing middleware: RFC 8006 §7.2 timing entries per request.
 *
 * @module
 */

import type { Ctx, Middleware, Next } from './types';

import { setHeader } from './respond';

/** Options for {@link timing}. */
export type TimingOptions = {
  /** Name of the total-duration entry; default `total`. */
  readonly total?: string;
};

/** One named span: opened by {@link startTiming}, closed by the stop
 * function it returns (or by {@link timing} at stamp time if never
 * stopped). */
type Span = {
  readonly name: string;
  readonly start: number;
  dur?: number;
};

/** Per-request span lists, weakly keyed so they die with the request
 * context (precedent: `pendingHeaders` in `./respond`). */
const spans = new WeakMap<Ctx, Span[]>();

/**
 * Opens a named timing span and returns the function that closes it:
 *
 * ```ts
 * const stop = startTiming(ctx, 'db');
 * const rows = await query(sql);
 * stop(); // appends db;dur=… to the Server-Timing header
 * ```
 *
 * Spans appear on the header in registration order. A span whose stop
 * function never runs is closed when the header is stamped (its duration
 * then covers up to the unwind). Names must be RFC 7230 tokens — no
 * spaces, commas, or semicolons. Calling `startTiming` without the
 * {@link timing} middleware installed is harmless: the weak entry dies
 * with the request and nothing is stamped. Calling the stop function
 * twice records the first duration only.
 */
export function startTiming(ctx: Ctx, name: string): () => void {
  let list = spans.get(ctx);
  if (list === undefined) {
    list = [];
    spans.set(ctx, list);
  }
  const span: Span = { name, start: performance.now() };
  list.push(span);
  let stopped = false;
  return () => {
    if (!stopped) {
      stopped = true;
      span.dur = performance.now() - span.start;
    }
  };
}

/** Milliseconds with sub-ms precision — one fractional digit, the same
 * format the logger's duration column uses. */
function ms(dur: number): string {
  return dur.toFixed(1);
}

/**
 * Server-Timing middleware: stamps an RFC 8006 §7.2 `Server-Timing`
 * header on the unwind — named spans in registration order, then the
 * total (`total;dur=…`). The stamp goes through {@link setHeader}, so it
 * lands on the handler's response and on the 404/405/500 and mapped-error
 * responses alike: the in-chain boundary materializes every response
 * before the unwind runs. Zero spans registered → the header carries the
 * total alone.
 */
export function timing(options: TimingOptions = {}): Middleware {
  const total = options.total ?? 'total';
  return async (ctx: Ctx, next: Next): Promise<void> => {
    const start = performance.now();
    await next();
    const end = performance.now();
    const list = spans.get(ctx);
    spans.delete(ctx);
    const parts: string[] = [];
    if (list !== undefined) {
      for (const span of list) {
        parts.push(`${span.name};dur=${ms(span.dur ?? end - span.start)}`);
      }
    }
    parts.push(`${total};dur=${ms(end - start)}`);
    setHeader(ctx, 'server-timing', parts.join(', '));
  };
}
