/**
 * Validation battery: wraps any injected parse function as a gate
 * middleware, keeping the zero-dependency contract (bring zod, valibot,
 * typebox, or a hand-rolled check — s200 only calls it).
 *
 * It also speaks the vendor-neutral Standard Schema shape
 * (`https://standardschema.dev`): anything carrying a `~standard` prop
 * slots straight into {@link jsonBody} (and into `queryParams` from
 * `s200/query`) — reported issues map to a single 422 `HttpError`
 * carrying the first issue's message.
 *
 * @module
 */

import type { Ctx, Middleware } from './types';

import { readJson } from './body';
import { httpError } from './errors';

export type ValidateOptions = {
  /** `ctx.state` slot for the parsed value; default `'validated'`. */
  readonly key?: string;
};

/** One validation failure as a vendor reports it: a human-readable
 * message plus the optional property path of the offending part. */
export type StandardIssue = {
  readonly message: string;
  readonly path?: readonly PropertyKey[];
};

/** The outcome of a schema's `validate`: `value` on success, `issues` on
 * failure — an empty `issues` array still counts as success. */
export type StandardResult = {
  readonly value?: unknown;
  readonly issues?: readonly StandardIssue[];
};

/**
 * The Standard Schema vendor shape, restated locally: a zero-dependency
 * framework cannot import `@standard-schema/spec`, but the contract is
 * structural — zod, valibot, typebox, and arktype values all satisfy it.
 */
export type StandardSchemaV1 = {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardResult;
  };
}

/**
 * The inference twin of {@link StandardSchemaV1}: same wire shape plus
 * the phantom `types` prop vendors carry for output inference (never
 * read at runtime). The intersection form keeps this a type-level
 * composition — no interface inheritance, per the paradigm gate.
 */
export type StandardSchema<T = unknown> = StandardSchemaV1 & {
  readonly types?: { readonly input: unknown; readonly output: T };
};

/**
 * The output type a standard schema declares through its phantom `types`
 * prop — `unknown` when the schema carries none (the runtime value is
 * still the schema's parsed output either way).
 */
export type OutputOf<S extends StandardSchema> =
  S extends { readonly types?: { readonly output: infer T } } ? T : unknown;

/**
 * The input type a standard schema declares through its phantom `types`
 * prop — what a caller must send, the client-side twin of {@link OutputOf}'s
 * parsed product. `unknown` when the schema carries none.
 */
export type InputOf<S extends StandardSchema> =
  S extends { readonly types?: { readonly input: infer I } } ? I : unknown;

/**
 * Shape predicate for the standard family: anything object-shaped
 * carrying the `~standard` marker counts (the duck-typing the spec
 * itself blesses). Used to pick between the parse-function and schema
 * flavors of {@link jsonBody} / `queryParams`.
 */
export function isStandardSchema(value: unknown): value is StandardSchema {
  return typeof value === 'object' && value !== null && '~standard' in value;
}

/**
 * Generic Standard Schema adapter, exported for other batteries (header
 * gates, form gates, …) that want the same semantics: returns the parsed
 * value, or throws a 422 `HttpError` carrying the first issue's message
 * when the schema reports any issue. An empty `issues` array passes.
 */
export function standardValidate(schema: StandardSchema, data: unknown): unknown {
  const result = schema['~standard'].validate(data);
  const issue = result.issues?.[0];
  if (issue !== undefined) {
    throw httpError(422, issue.message);
  }
  return result.value;
}

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
 * Convenience over {@link validate} for JSON request bodies, in two
 * flavors:
 *
 * - a Standard Schema (anything with a `~standard` prop, detected with
 *   `isStandardSchema`) — {@link standardValidate} runs it, mapping
 *   issues to a 422 `HttpError` with the first message; the value the
 *   handler reads from `ctx.state[key]` is the schema's parsed OUTPUT,
 *   while the gate's `_in` brand carries the schema's INPUT — what a
 *   caller must send;
 * - a plain parse function `(data: unknown) => T` — keeps deciding its
 *   own failure mode, exactly as before.
 *
 * Either way `readJson` rejects invalid JSON with a 400 `HttpError`
 * before the schema ever runs.
 *
 * The return type carries a phantom `_in?: { readonly json: T }` — a
 * type-only intersection, no runtime property. It describes the CALLER's
 * side (what to send), not the handler's: the schema flavor brands it
 * with the schema's input ({@link InputOf}) while the parse flavor's `T`
 * is simultaneously what is sent and what lands on `ctx.state[key]`.
 * Route registrars collect the brand into the route log's `in` channel
 * (`ChainIn`), so the app's client surface can type request bodies the
 * way `json()` brands responses.
 */
export function jsonBody<S extends StandardSchema>(
  schema: S,
  options?: ValidateOptions
): Middleware & { readonly _in?: { readonly json: InputOf<S> } };
export function jsonBody<T>(
  parse: (data: unknown) => T,
  options?: ValidateOptions
): Middleware & { readonly _in?: { readonly json: T } };
export function jsonBody(
  schemaOrParse: StandardSchema | ((data: unknown) => unknown),
  options: ValidateOptions = {}
): Middleware {
  const parse: (data: unknown) => unknown = isStandardSchema(schemaOrParse)
    ? (data) => standardValidate(schemaOrParse, data)
    : schemaOrParse;
  return validate(async (ctx) => parse(await readJson(ctx)), options);
}
