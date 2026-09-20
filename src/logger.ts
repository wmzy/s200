/**
 * Request logger middleware: one line per request via a pluggable sink.
 *
 * @module
 */

import type { Ctx, Middleware, Next } from './types';

/**
 * Options for {@link logger}. The default format is
 * `ISO-time METHOD path status duration`; the status is always the real one
 * — the 404/405/500 fallbacks are materialized inside the chain before the
 * unwind, so the logger observes them like any other response.
 */
export type LoggerOptions = {
  readonly sink?: (line: string) => void;
  readonly format?: (ctx: Ctx, durationMs: number) => string;
};

function defaultFormat(ctx: Ctx, durationMs: number): string {
  const status = ctx.res === undefined ? '-' : String(ctx.res.status);
  return `${new Date().toISOString()} ${ctx.req.method} ${ctx.url.pathname} ${status} ${durationMs.toFixed(1)}ms`;
}

/**
 * Request logger middleware: measures the downstream chain and emits one
 * line per request through `sink` (defaults to `console.log`). Register via
 * `use` — the unwind position gives it the status of the written response.
 */
export function logger(options: LoggerOptions = {}): Middleware {
  const { sink = (line) => console.log(line), format = defaultFormat } = options;
  return async (ctx: Ctx, next: Next): Promise<void> => {
    const start = performance.now();
    await next();
    sink(format(ctx, performance.now() - start));
  };
}
