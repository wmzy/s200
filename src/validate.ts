/**
 * Validation battery: wraps any injected parse function as a gate
 * middleware, keeping the zero-dependency contract (bring zod, valibot,
 * typebox, or a hand-rolled check — s200 only calls it).
 *
 * @module
 */

import type { Ctx, Middleware } from './types';

import { readJson } from './body';

export type ValidateOptions = {
  /** `ctx.state` slot for the parsed value; default `'validated'`. */
  readonly key?: string;
};

/**
 * Runs `parse(ctx)` ahead of the rest of the chain and stores its result on
 * `ctx.state[key]`. The parse function decides the failure mode — a thrown
 * `HttpError` (or anything else) rejects the chain like any middleware
 * error and reaches the app's error path unchanged.
 */
export function validate(
  parse: (ctx: Ctx) => unknown | Promise<unknown>,
  options: ValidateOptions = {}
): Middleware {
  const key = options.key ?? 'validated';
  return async (ctx, next) => {
    ctx.state[key] = await parse(ctx);
    return next();
  };
}

/**
 * Convenience over {@link validate} for JSON request bodies: reads and
 * parses the cached body, then hands the raw parsed value to `parse` for
 * shape checking. `readJson` rejects invalid JSON with a 400 `HttpError`
 * before the schema ever runs.
 */
export function jsonBody<T>(
  parse: (data: unknown) => T,
  options: ValidateOptions = {}
): Middleware {
  return validate(async (ctx) => parse(await readJson(ctx)), options);
}
