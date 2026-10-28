/**
 * Schema-driven JSON serializer: `serialize(schema)` compiles a
 * serialization function for a JSON-Schema-shaped subset, `jsonRaw`
 * writes an already-serialized JSON string as a response, and
 * `exampleToSchema` infers the subset from an example value (the one
 * inference layer `s200/codegen` and `s200/openapi` render).
 *
 * The schema is developer-authored code, compiled once at startup through
 * the Function constructor into a function of straight string
 * concatenation. The payoff is the declared SHAPE, not raw speed: the
 * output carries exactly the declared keys (undeclared ones are dropped —
 * `additionalProperties: false` semantics, so an internal field can never
 * leak into a response), the schema drives the input type at compile
 * time, and modern engines' `JSON.stringify` stays competitive
 * (both paths are sub-µs for typical payloads — this is not a speed hack).
 *
 * It is a serialization SHAPE, not a validator: type mismatches are not
 * checked, and `NaN`/`Infinity` serialize as `null` (JSON semantics).
 * Note that `required: [...] as const` (or a whole-schema `as const`) is
 * what lets the array literal drive optionality in the inferred type —
 * without it TypeScript widens the array to `string[]` and every key
 * infers as required.
 *
 * @module
 */

import type { Ctx } from './types';

import { stringResponse } from './respond';

/** Primitive JSON types in the schema subset. */
export type PrimitiveType = 'string' | 'number' | 'integer' | 'boolean' | 'null';

/**
 * The supported schema subset. `type: 'object'` requires `properties`;
 * `required` names the non-optional keys (absent = every key optional).
 * `nullable: true` widens a primitive to `T | null`. An array without
 * `items` leaves its elements unconstrained — the shape {@link
 * exampleToSchema} infers for a mixed-element example; `serialize` passes
 * such an array through `JSON.stringify` verbatim and the validators
 * check array-ness only. `title` is an optional annotation carried into
 * `toJsonSchema` output (and used to name hoisted
 * `components.schemas` entries — see `s200/openapi`).
 */
export type SerializeSchema =
  | {
      readonly type: 'object';
      // eslint-disable-next-line @typescript-eslint/consistent-indexed-object-style -- the index-signature form is required: `Record<string, X>` erases the literal keys, which would flatten the inferred input type to an index signature
      readonly properties: { readonly [key: string]: SerializeSchema };
      readonly required?: readonly string[];
      /** Annotation only — carried into `toJsonSchema` output verbatim;
       * serialization and validation ignore it. */
      readonly title?: string;
    }
  | { readonly type: 'array'; readonly items?: SerializeSchema; readonly title?: string }
  | { readonly type: PrimitiveType; readonly nullable?: boolean; readonly title?: string };

/** The object member of the schema union — named so mapped types can
 * constrain over `properties` access. */
type ObjectSchema = Extract<SerializeSchema, { readonly type: 'object' }>;

/** Adds `null` to `T` when the schema's `nullable` flag is set. */
type Nullable<S extends { readonly nullable?: boolean }, T> = S extends {
  readonly nullable: true;
}
  ? T | null
  : T;

/** Shape of one object schema's declared properties. */
type ObjectProps<S extends ObjectSchema> = {
  [K in keyof S['properties']]: InferSchema<S['properties'][K]>;
};

/**
 * The object shape a schema infers: `required` keys are non-optional,
 * everything else optional. Requires all keys when `required` is absent.
 */
type InferObject<S extends ObjectSchema> =
  S extends { readonly required: readonly (infer R extends string)[] }
    ? {
        [K in keyof ObjectProps<S> as K extends R ? K : never]: ObjectProps<S>[K];
      } & {
        [K in keyof ObjectProps<S> as K extends R ? never : K]?: ObjectProps<S>[K];
      }
    : { [K in keyof ObjectProps<S>]?: ObjectProps<S>[K] };

/** Compile-time input type of a schema. */
export type InferSchema<S extends SerializeSchema> =
  // eslint-disable-next-line @typescript-eslint/consistent-indexed-object-style -- same reason as SerializeSchema: literal keys must survive narrowing
  S extends { readonly type: 'object'; readonly properties: { readonly [key: string]: SerializeSchema } }
    ? InferObject<S>
    : S extends { readonly type: 'array' }
      ? S extends { readonly items: SerializeSchema }
        ? InferSchema<S['items']>[]
        : unknown[]
      : S extends { readonly type: 'string'; readonly nullable?: boolean }
        ? Nullable<S, string>
        : S extends { readonly type: 'number'; readonly nullable?: boolean }
          ? Nullable<S, number>
          : S extends { readonly type: 'integer'; readonly nullable?: boolean }
            ? Nullable<S, number>
            : S extends { readonly type: 'boolean'; readonly nullable?: boolean }
              ? Nullable<S, boolean>
              : null;

/**
 * A `SerializeSchema` as a plain JSON Schema object — the bridge every
 * schema-exposing consumer (`s200/openapi`, `s200/mcp`) reads. Passes
 * through exactly the fields a `SerializeSchema` carries at runtime —
 * `type`, `properties`/`required`, `items`, `nullable` — and nothing
 * more: the DSL has no `enum`/`format`/`description`/bounds markers to
 * forward, so none are invented.
 */
export function toJsonSchema(schema: SerializeSchema): Record<string, unknown> {
  // `title` rides along as a JSON Schema annotation — it names hoisted
  // `components.schemas` entries in `s200/openapi`.
  const title = schema.title !== undefined ? { title: schema.title } : {};
  switch (schema.type) {
    case 'object': {
      const properties: Record<string, unknown> = {};
      for (const [key, sub] of Object.entries(schema.properties)) {
        properties[key] = toJsonSchema(sub);
      }
      return {
        type: 'object',
        properties,
        ...(schema.required !== undefined && schema.required.length > 0
          ? { required: schema.required }
          : {}),
        ...title,
      };
    }
    case 'array':
      // No `items`: elements unconstrained — the bare array shape (what
      // `exampleToSchema` infers for a mixed-element example).
      return schema.items === undefined
        ? { type: 'array', ...title }
        : { type: 'array', items: toJsonSchema(schema.items), ...title };
    default:
      return schema.nullable === true
        ? { type: [schema.type, 'null'], ...title }
        : { type: schema.type, ...title };
  }
}

/** Structural JSON-string equality for the array-items agreement check:
 * two schemas produced by the same recursion stringify identically iff
 * they are structurally equal, key order included. */
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Infers a {@link SerializeSchema} from an example value — the single
 * structural-inference layer behind the example-derived surfaces:
 * `s200/codegen` renders its output through the schema-to-TypeScript
 * walk and `s200/openapi` through {@link toJsonSchema}, so the two
 * views cannot drift. `undefined` means "no schema" — the example
 * carries nothing the DSL can declare.
 *
 * Semantics:
 *
 * - `null`/`string`/`boolean` map directly; numbers split `integer`
 *   from `number` by integrality;
 * - an object declares every key its example shows, all `required`
 *   (optionality is unknowable from an example); keys whose values
 *   infer no schema are dropped;
 * - an array carries `items` only when every element infers the same
 *   schema (structural equality — `1` and `1.5` disagree under the
 *   integrality split); an empty or mixed array stays
 *   `{ type: 'array' }`, its elements unconstrained;
 * - values with no JSON analogue (`undefined`, functions, symbols,
 *   bigints) infer no schema at any depth.
 */
export function exampleToSchema(example: unknown): SerializeSchema | undefined {
  if (example === undefined) return undefined;
  if (example === null) return { type: 'null' };
  switch (typeof example) {
    case 'string':
      return { type: 'string' };
    case 'boolean':
      return { type: 'boolean' };
    case 'number':
      return { type: Number.isInteger(example) ? 'integer' : 'number' };
    case 'object': {
      if (Array.isArray(example)) {
        const schemas = example.map(exampleToSchema);
        const first = schemas[0];
        return first !== undefined && schemas.every((schema) => sameJson(schema, first))
          ? { type: 'array', items: first }
          : { type: 'array' };
      }
      const properties: Record<string, SerializeSchema> = {};
      for (const [key, value] of Object.entries(example as Readonly<Record<string, unknown>>)) {
        const schema = exampleToSchema(value);
        if (schema !== undefined) {
          properties[key] = schema;
        }
      }
      const required = Object.keys(properties);
      return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
    }
    default:
      return undefined;
  }
}

/**
 * Compiles a schema into a serializer. The returned function emits the
 * declared keys in schema order and drops anything the schema does not
 * declare. Two codegen shapes: all-required objects become one straight
 * concatenation expression; objects with optional keys use a statement
 * body with a runtime `first` flag (a static leading comma is impossible
 * when earlier optionals may be absent).
 */
export function serialize<S extends SerializeSchema>(
  schema: S
): (value: InferSchema<S>) => string {
  let fn: (value: InferSchema<S>) => string;
  if (schema.type === 'object' && hasOptionalKeys(schema)) {
    const body = `var out = '{', first = true; ${objectStmts(schema, 'v')} return out + '}';`;
    fn = new Function('v', body) as (value: InferSchema<S>) => string;
  } else {
    fn = new Function(
      'v',
      `return ${compileValue(schema)('v')};`
    ) as (value: InferSchema<S>) => string;
  }
  return fn;
}

/** Property access expression over the value reference. */
function member(value: string, key: string): string {
  return `${value}[${JSON.stringify(key)}]`;
}

/**
 * Builds a JS expression string that serializes the value held in
 * `value`. Returns constant expressions where the schema pins the output
 * (e.g. `'null'`), so codegen stays cheap. Objects with optional keys
 * compile to an IIFE wrapping the statement form — expression context
 * with statement machinery.
 */
function compileValue(schema: SerializeSchema): (value: string) => string {
  switch (schema.type) {
    case 'null':
      return () => "'null'";
    case 'string':
    case 'integer':
    case 'number':
      // JSON.stringify handles string escaping and maps NaN/Infinity to
      // null (JSON semantics) — the only native call left on the path.
      return (value) => withNullable(schema, value, `JSON.stringify(${value})`);
    case 'boolean':
      return (value) =>
        withNullable(schema, value, `(${value} === true ? 'true' : 'false')`);
    case 'array': {
      // No `items`: elements unconstrained — the whole array passes
      // through `JSON.stringify` verbatim (holes and `undefined` map to
      // `null`, the native rule).
      if (schema.items === undefined) {
        return (value) => `JSON.stringify(${value})`;
      }
      const item = compileValue(schema.items);
      // `Array.from`, not `.map`: map skips holes, which `join` then renders
      // as empty slots (`[,"a"]`). `?? 'null'` matches `JSON.stringify` for
      // an element whose encoded form is `undefined` (undefined/function/
      // symbol) — without it, `join` leaves a trailing comma (`["a",]`).
      return (value) =>
        `'[' + Array.from(${value}, (item) => ${item('item')} ?? 'null').join(',') + ']'`;
    }
    case 'object':
      return hasOptionalKeys(schema)
        ? (value) =>
            `(() => { var out = '{', first = true; ${objectStmts(schema, value)} return out + '}'; })()`
        : (value) => compileObjectExpr(schema, value);
  }
}

/** Wraps an expression with the `value === null` fast path when nullable. */
function withNullable(
  schema: { readonly nullable?: boolean },
  value: string,
  expression: string
): string {
  return schema.nullable === true
    ? `(${value} === null ? 'null' : ${expression})`
    : expression;
}

/** True when any declared property is not required (or required is absent). */
function hasOptionalKeys(schema: ObjectSchema): boolean {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).some(([key]) => !required.has(key));
}

/** The all-required fast path: one concatenation expression, static commas. */
function compileObjectExpr(schema: ObjectSchema, value: string): string {
  const entries = Object.entries(schema.properties);
  if (entries.length === 0) {
    return "'{}'";
  }
  const parts = entries.map(([key, sub], index) => {
    // Separator commas are string operands (`',' + …`), never bare code.
    const comma = index === 0 ? '' : `',' + `;
    // The key prefix embeds its own quotes and colon so the concat chain
    // stays a sequence of `+` operands (a bare `"key":expr` would parse as
    // a label, not an operand). The key is JSON-escaped FIRST (quotes,
    // backslashes, control characters), so the emitted text is a valid
    // JSON member name for any key — the outer stringify only quotes that
    // fragment for the JS source.
    return `${comma}${JSON.stringify(`${JSON.stringify(key)}:`)} + ${compileValue(sub)(member(value, key))}`;
  });
  return `'{' + ${parts.join(' + ')} + '}'`;
}

/**
 * Statement sequence for an object with optional keys, running against a
 * pre-declared `out`/`first` pair. Preserves schema order; `first` tracks
 * whether any key preceded, so an omitted leading optional never leaves a
 * stray comma.
 */
function objectStmts(schema: ObjectSchema, value: string): string {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties)
    .map(([key, sub]) => {
      const prop = `(first ? '' : ',') + ${JSON.stringify(`${JSON.stringify(key)}:`)} + ${compileValue(sub)(member(value, key))}`;
      const assign = `out += ${prop}; first = false;`;
      return required.has(key)
        ? assign
        : `if (${member(value, key)} !== undefined) { ${assign} }`;
    })
    .join(' ');
}

/** One schema violation: `path` dot-joins the schema-relative location
 * (object keys and array indices, `'items.2.name'`; the root is `''`) and
 * `message` names the violated expectation. */
export type ValidationIssue = {
  readonly path: string;
  readonly message: string;
};

/** `join('items', '2')` → `'items.2'`; the root path stays bare. */
function joinPath(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

/** `typeof` with the two JSON-relevant refinements: `null` and arrays
 * report as their JSON types, not `'object'`. */
function typeOf(data: unknown): string {
  if (data === null) return 'null';
  return Array.isArray(data) ? 'array' : typeof data;
}

/** Primitive predicate — exactly the values the serializer can emit
 * round-trip-cleanly: `integer` demands integrality and finiteness,
 * `number` demands finiteness (the values `JSON.stringify` would map to
 * `null`, breaking the declared shape). */
function primitiveOk(type: PrimitiveType, data: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof data === 'string';
    case 'boolean':
      return typeof data === 'boolean';
    case 'integer':
      return (
        typeof data === 'number' &&
        Number.isInteger(data) &&
        Number.isFinite(data)
      );
    case 'number':
      return typeof data === 'number' && Number.isFinite(data);
    case 'null':
      return data === null;
  }
}

/** The one recursive checker behind {@link compileValidator} and
 * {@link checkSchema}: reports into `issues` and returns — one issue per
 * violated node, in schema traversal order. Never throws: it reads, it
 * does not parse. Parameterized by the three ways its two readers
 * differ: `extend` grows the path (the dot-joined string of the open
 * validator vs the `PropertyKey` walk of the closed one), `report` lifts
 * a violation into the caller's issue type, and `closed` adds the
 * undeclared-key reading — reported after the declared checks, in
 * document order. */
function walkValues<P, I>(
  schema: SerializeSchema,
  data: unknown,
  path: P,
  issues: I[],
  extend: (path: P, key: string | number) => P,
  report: (path: P, message: string) => I,
  closed: boolean
): void {
  switch (schema.type) {
    case 'object': {
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        issues.push(report(path, `expected object, got ${typeOf(data)}`));
        return;
      }
      const record = data as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        // `undefined` counts as missing — the serializer's own "absent"
        // reading of an optional key, applied to a required one.
        if (record[key] === undefined) {
          issues.push(report(extend(path, key), 'required'));
        }
      }
      for (const [key, sub] of Object.entries(schema.properties)) {
        const value = record[key];
        // Undeclared keys are none of the open validator's business — the
        // same drop-undeclared contract `serialize` applies on output;
        // the closed reader reports them below instead.
        if (value === undefined) continue;
        walkValues(sub, value, extend(path, key), issues, extend, report, closed);
      }
      if (closed) {
        // The closed-shape contract: serialize drops undeclared keys on
        // output, so an undeclared key on input is a violation, not
        // noise — reported after the declared checks, in document order.
        for (const key of Object.keys(record)) {
          if (!Object.hasOwn(schema.properties, key)) {
            issues.push(report(extend(path, key), 'undeclared key'));
          }
        }
      }
      return;
    }
    case 'array': {
      if (!Array.isArray(data)) {
        issues.push(report(path, `expected array, got ${typeOf(data)}`));
        return;
      }
      // No `items`: elements unconstrained — array-ness is the whole check.
      if (schema.items === undefined) return;
      for (let i = 0; i < data.length; i++) {
        walkValues(schema.items, data[i], extend(path, i), issues, extend, report, closed);
      }
      return;
    }
    default: {
      // Nullable first: `null` satisfies the widened primitive before any
      // type check runs.
      if (schema.nullable === true && data === null) return;
      if (!primitiveOk(schema.type, data)) {
        issues.push(report(path, `expected ${schema.type}, got ${typeOf(data)}`));
      }
    }
  }
}

/**
 * The read-side twin of {@link serialize}: compiles the same schema DSL
 * into a validator instead of a serializer. Coverage mirrors the
 * serializer's subset one-for-one — `type`, `properties`/`required`,
 * `items`, `nullable` — with no new schema capability:
 *
 * - type mismatches report at the offending node;
 * - `nullable: true` admits `null` before the type check;
 * - a missing (or `undefined`) `required` key reports at its own path;
 * - objects and arrays recurse; extra keys the schema does not declare
 *   are ignored, the exact shape contract `serialize` enforces on output.
 *
 * The returned function collects every violation as a
 * {@link ValidationIssue} — an empty list means conforming — and never
 * throws or rewrites: callers decide what an issue means.
 */
export function compileValidator(
  schema: SerializeSchema
): (data: unknown) => readonly ValidationIssue[] {
  return (data) => {
    const issues: ValidationIssue[] = [];
    // Open reading: dot-joined string paths, undeclared keys ignored.
    walkValues(
      schema,
      data,
      '',
      issues,
      (path, key) => joinPath(path, String(key)),
      (path, message) => ({ path, message }),
      false
    );
    return issues;
  };
}

/** One closed-schema violation: `path` walks from the root (object keys
 * and array indices — `['items', 1, 'name']`; the root itself is `[]`)
 * and `message` names the violated expectation. */
export type SchemaIssue = {
  readonly path: readonly PropertyKey[];
  readonly message: string;
};

/**
 * The closed-shape twin of {@link compileValidator}: checks `value`
 * against the schema in one pass and returns every violation as a
 * {@link SchemaIssue} (an empty list means conforming). Coverage is the
 * same DSL subset — `type`, `properties`/`required`, `items`,
 * `nullable` — with one deliberate difference: **undeclared object keys
 * are violations** (`additionalProperties: false` reading, matching what
 * `serialize` emits on output), where `compileValidator` ignores them
 * (the request-gate reading — clients send extra keys all the time).
 * `path` is the key walk from the root (`['items', 1, 'name']`, `[]` at
 * the root), not a dot-joined string. Never throws or rewrites.
 */
export function checkSchema(
  schema: SerializeSchema,
  value: unknown
): readonly SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  // Closed reading: PropertyKey-walk paths, undeclared keys reported
  // after the declared checks, in document order.
  const root: readonly PropertyKey[] = [];
  walkValues(
    schema,
    value,
    root,
    issues,
    (path, key) => [...path, key],
    (path, message) => ({ path, message }),
    true
  );
  return issues;
}

/**
 * Writes an already-serialized JSON string as the response body: sets
 * `content-type: application/json` (init headers win), advertises the
 * exact `content-length`, and returns the written response. The pair with
 * {@link serialize} replaces `json(ctx, data)` on hot paths:
 *
 * ```ts
 * const toUser = serialize({
 *   type: 'object',
 *   properties: { id: { type: 'integer' }, name: { type: 'string' } },
 *   required: ['id', 'name'],
 * });
 * get(app, '/users/:id', (ctx) => jsonRaw(ctx, toUser({ id: 1, name: 'a' })));
 * ```
 */
export function jsonRaw(ctx: Ctx, json: string, init?: ResponseInit): Response {
  // stringResponse is the shared string-body tail: light requests keep
  // their zero-copy LightHeaders view (a raw `new Headers(init)` would
  // bypass it), and the null-body statuses (1xx/204/304) inherit the same
  // no-content-length guard as json/text/html/send.
  return stringResponse(ctx, json, init, 'application/json');
}
