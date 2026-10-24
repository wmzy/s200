/**
 * Validation battery: wraps any injected parse function as a gate
 * middleware, keeping the zero-dependency contract (bring zod, valibot,
 * typebox, or a hand-rolled check — s200 only calls it).
 *
 * It also speaks the vendor-neutral Standard Schema shape
 * (`https://standardschema.dev`): anything carrying a `~standard` prop
 * slots straight into {@link jsonBody} (and into `queryParams` from
 * `s200/query`) — reported issues map to a single 422 `HttpError` whose
 * body carries every issue with its path (`error` keeps the first
 * message).
 *
 * @module
 */

import type { Ctx, Middleware } from './types';

import { readJson } from './body';
import { httpError, type HttpError } from './errors';

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

/** One issue as a 422 rejection body carries it: `path` is the key walk
 * from the validated root — object keys dotted, array indices bracketed
 * (`'a.b[0]'`), `''` when the issue carries no path — and `message` is
 * the vendor's own reason. */
export type ReportedIssue = {
  readonly path: string;
  readonly message: string;
};

/** `['a', 'b', 0]` → `'a.b[0]'`: object keys join with dots, numeric
 * indices bracket themselves; a missing or empty path formats as `''`
 * (the issue sits at the validated root). */
export function formatIssuePath(path: readonly PropertyKey[] | undefined): string {
  if (path === undefined) return '';
  let out = '';
  for (const key of path) {
    if (typeof key === 'number') {
      out += `[${String(key)}]`;
    } else {
      out += out === '' ? String(key) : `.${String(key)}`;
    }
  }
  return out;
}

/**
 * The 422 every framework validation gate throws — one shape from one
 * place, shared with `withRouteValidation` in `s200/openapi`. The body
 * keeps the `error` compat key — the first issue's one-line summary,
 * scope-qualified (`'body.items.2.name: expected string, got number'`)
 * when `scope` names the request location, the raw first message
 * otherwise — and adds `issues`, the full list, each entry's `path`
 * qualified the same way. Raw issues arrive in either dialect the
 * framework speaks: Standard Schema (`path` an optional key array,
 * formatted by {@link formatIssuePath}) or the serialize validator's
 * pre-joined strings. Callers arrive only with a non-empty list; the
 * first-issue fallback keeps the helper total under
 * `noUncheckedIndexedAccess`.
 */
export function validationError(
  scope: string | undefined,
  issues: readonly {
    readonly path?: readonly PropertyKey[] | string;
    readonly message: string;
  }[]
): HttpError & {
  readonly body: { readonly error: string; readonly issues: readonly ReportedIssue[] };
} {
  const qualify = (path: string): string =>
    scope === undefined ? path : path === '' ? scope : `${scope}.${path}`;
  const reported: ReportedIssue[] = issues.map((issue) => ({
    path: qualify(typeof issue.path === 'string' ? issue.path : formatIssuePath(issue.path)),
    message: issue.message,
  }));
  const first = reported[0];
  const summary =
    first === undefined
      ? ''
      : scope === undefined
        ? first.message
        : `${first.path}: ${first.message}`;
  // The cast is honest erasure: `httpError` brands `body` optional (the key
  // is absent when callers pass none), but this call always passes one, so
  // the returned error's `body` is the envelope below — required, not `?`.
  return httpError(422, summary, { error: summary, issues: reported }) as ReturnType<
    typeof validationError
  >;
}

/**
 * Generic Standard Schema adapter, exported for other batteries (header
 * gates, form gates, …) that want the same semantics: returns the parsed
 * value, or throws a 422 `HttpError` when the schema reports any issue —
 * `error` keeps the first issue's message while the body's `issues`
 * array carries every issue with its formatted path ({@link
 * validationError}). An empty `issues` array passes.
 */
export function standardValidate(schema: StandardSchema, data: unknown): unknown {
  const result = schema['~standard'].validate(data);
  const issues = result.issues;
  if (issues !== undefined && issues.length > 0) {
    throw validationError(undefined, issues);
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
 *   issues to a 422 `HttpError` (`error` keeps the first message, the
 *   body's `issues` array carries the full list with paths); the value the
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

/**
 * Declares the request headers a route reads — a type-level gate in the
 * `throws` mold (`s200/errors`): the middleware is a pure pass-through,
 * no header is checked. The declaration exists so the route log's `in`
 * channel can carry the keys to `s200/client`, which types (and demands)
 * them as `init.headers` — a `Record<string, string>` with every named
 * key required. Enforcement stays with middleware: `validate(parse)`
 * reading `ctx.req.headers` (or any auth battery) is the runtime twin.
 *
 * ```ts
 * get(app, '/me', requiresHeaders('authorization'), (ctx) => {
 *   const auth = ctx.req.headers.get('authorization');   // enforcement is yours
 *   …
 * });
 * ```
 *
 * Several `requiresHeaders` gates on one route intersect their key sets
 * (via `ChainIn`), like every other input brand.
 */
export function requiresHeaders<K extends string>(
  ...keys: K[]
): Middleware & { readonly _in?: { readonly headers: Record<K, string> } };
export function requiresHeaders(): Middleware {
  // Deliberately takes no runtime input and checks nothing (a zero-arg
  // implementation satisfies the variadic overload): the keys are a
  // declaration for the type checker, not a validation.
  return (_ctx, next) => next();
}

/**
 * Declares the structured request-body type a route reads — `bodyShape<
 * FormData>()` on an upload route, `bodyShape<Blob>()`/`bodyShape<
 * ArrayBuffer>()`/`bodyShape<ReadableStream>()` on binary routes. The
 * `throws`-mold type-level gate: pure pass-through, nothing parsed. The
 * declaration brands the route log's `in` channel with `{ body: T }` so
 * `s200/client` types (and demands) `init.body` as exactly `T` instead of
 * the loose `BodyInit`.
 *
 * The client decides how the value travels from the RUNTIME value, not
 * from the declared type: a plain object or array is `JSON.stringify`ed
 * and sent with `content-type: application/json` (an explicit
 * content-type wins), while strings and platform body types (`FormData`,
 * `Blob`, `ArrayBuffer`, typed-array views, `URLSearchParams`,
 * `ReadableStream`) go to fetch untouched. Runtime reading stays with the
 * handler (`s200/multipart`'s `streamForm`, `s200/upload`'s
 * `uploadForm`, or a raw `ctx.req.body` stream).
 */
export function bodyShape<T>(): Middleware & { readonly _in?: { readonly body: T } } {
  // The type parameter is the whole gate — no runtime input exists.
  return (_ctx, next) => next();
}
