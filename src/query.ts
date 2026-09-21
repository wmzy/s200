/**
 * Typed query parsing: `parseQuery` turns the request's query string into
 * a plain record (repeated keys collect into arrays), and `queryParams`
 * wraps any schema function around it as a gate middleware — the query
 * twin of `s200/validate`'s `jsonBody`.
 *
 * @module
 */

import type { Ctx, Middleware } from './types';

/** The record shape `parseQuery` produces: every key optional; repeated
 * keys (`?tag=a&tag=b`) collect into `string[]`. */
export type QueryRecord = Record<string, string | string[]>;

/**
 * Reads the request's query string into a plain record. Keys appearing
 * once are strings; repeated keys become arrays. Allocation is per
 * request — the URL was already parsed on the context, no re-parsing.
 */
export function parseQuery(ctx: Ctx): QueryRecord {
  // Null prototype: `?__proto__=x` must land as a plain own key (assigning
  // it on `{}` would silently touch the prototype instead), and
  // `constructor`/`toString` keys must not shadow inherited members.
  const out = Object.create(null) as QueryRecord;
  for (const [key, value] of ctx.query) {
    const existing = out[key];
    if (existing === undefined) {
      out[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      out[key] = [existing, value];
    }
  }
  return out;
}

export type QueryParamsOptions = {
  /** `ctx.state` slot for the parsed value; default `'validated'` (same as
   * `s200/validate`). */
  readonly key?: string;
};

/**
 * Gate middleware over the query string: `parse(record) => T` decides the
 * value, its result lands on `ctx.state[key]` (typed through the schema —
 * zod/valibot/typebox/hand-rolled all work). A throwing parse rejects the
 * chain like any middleware error: throw an `httpError` for a 4xx answer.
 */
export function queryParams<T>(
  parse: (data: QueryRecord) => T,
  options: QueryParamsOptions = {}
): Middleware {
  const key = options.key ?? 'validated';
  return async (ctx, next) => {
    ctx.state[key] = parse(parseQuery(ctx));
    return next();
  };
}
