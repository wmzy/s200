/**
 * Typed query parsing: `parseQuery` turns the request's query string into
 * a plain record (repeated keys collect into arrays), and `queryParams`
 * wraps any schema function — or a Standard Schema — around it as a gate
 * middleware: the query twin of `s200/validate`'s `jsonBody`.
 *
 * @module
 */

import type { Ctx, Middleware } from './types';

import {
  isStandardSchema,
  standardValidate,
  type InputOf,
  type StandardSchema,
} from './validate';

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
 * The shapes a `queryParams` schema may read: the parsed query record's
 * values, or any narrower read (numbers, booleans, optional keys). The
 * unannotated callback still gets {@link QueryRecord}.
 */
export type QueryInput = Record<
  string,
  string | number | boolean | readonly (string | number | boolean)[] | undefined
>;

/**
 * Gate middleware over the query string, in two flavors:
 *
 * - a Standard Schema (anything with a `~standard` prop, detected with
 *   `isStandardSchema`) — `standardValidate` runs it over the parsed
 *   record, mapping issues to a 422 `HttpError` with the first message;
 *   the parsed product lands on `ctx.state[key]` while the phantom
 *   `types` prop's input side brands the gate (see below);
 * - a parse function `parse(record) => T` decides the
 *   value, its result lands on `ctx.state[key]` (typed through the schema —
 *   zod/valibot/typebox/hand-rolled all work). A throwing parse rejects the
 *   chain like any middleware error: throw an `httpError` for a 4xx answer.
 *
 * `Q` (the callback's parameter) is inferable, so annotating the callback
 * — `queryParams((q: { page?: string }) => …)` — both types the read and
 * brands the returned middleware with a phantom `_in?: { readonly query:
 * Q }` (type-only, no runtime property). Registrars collect the brand
 * into the route log's `in` channel (`ChainIn`); an unannotated callback
 * keeps the plain {@link QueryRecord}. The schema flavor brands the same
 * slot with the schema's INPUT ({@link InputOf}) — what a caller must
 * send — while the value the handler reads from `ctx.state[key]` stays
 * the schema's parsed output, matching how a `jsonBody` schema splits
 * its input and output types.
 */
export function queryParams<S extends StandardSchema>(
  schema: S,
  options?: QueryParamsOptions
): Middleware & { readonly _in?: { readonly query: InputOf<S> } };
export function queryParams<Q extends QueryInput = QueryRecord, T = unknown>(
  parse: (q: Q) => T,
  options?: QueryParamsOptions
): Middleware & { readonly _in?: { readonly query: Q } };
export function queryParams(
  schemaOrParse: StandardSchema | ((q: never) => unknown),
  options: QueryParamsOptions = {}
): Middleware {
  const key = options.key ?? 'validated';
  return async (ctx, next) => {
    const record = parseQuery(ctx);
    ctx.state[key] = isStandardSchema(schemaOrParse)
      ? standardValidate(schemaOrParse, record)
      : // The parsed record is the runtime input; `Q` is the callback's
        // declared (narrower) view of it — the cast is the type-level seam.
        (schemaOrParse as (q: QueryRecord) => unknown)(record);
    return next();
  };
}
