/**
 * Request logger middleware: one line per request via a pluggable sink.
 *
 * @module
 */

import type { Ctx, Middleware, Next } from './types';

/**
 * Options for {@link logger}. The default format is
 * `ISO-time METHOD path status duration`; `status` is `-` when the chain
 * wrote no response — the default 404/405/500 fallbacks are written after
 * the chain unwinds, so no middleware can observe them.
 */
export type LoggerOptions = {
  readonly sink?: (line: string) => void;
  readonly format?: (ctx: Ctx, durationMs: number) => string;
};

function defaultFormat(ctx: Ctx, durationMs: number): string {
  const status = ctx.res === undefined ? '-' : String(ctx.res.status);
  return `${new Date().toISOString()} ${ctx.req.method} ${new URL(ctx.req.url).pathname} ${status} ${durationMs.toFixed(1)}ms`;
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
