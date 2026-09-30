/**
 * Schema-driven JSON serializer: `serialize(schema)` compiles a
 * serialization function for a JSON-Schema-shaped subset, and `jsonRaw`
 * writes an already-serialized JSON string as a response.
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

import { newResponse, utf8Length } from './respond';

/** Primitive JSON types in the schema subset. */
export type PrimitiveType = 'string' | 'number' | 'integer' | 'boolean' | 'null';

/**
 * The supported schema subset. `type: 'object'` requires `properties`;
 * `required` names the non-optional keys (absent = every key optional).
 * `nullable: true` widens a primitive to `T | null`.
 */
export type SerializeSchema =
  | {
      readonly type: 'object';
      // eslint-disable-next-line @typescript-eslint/consistent-indexed-object-style -- the index-signature form is required: `Record<string, X>` erases the literal keys, which would flatten the inferred input type to an index signature
      readonly properties: { readonly [key: string]: SerializeSchema };
      readonly required?: readonly string[];
    }
  | { readonly type: 'array'; readonly items: SerializeSchema }
  | { readonly type: PrimitiveType; readonly nullable?: boolean };

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
      const item = compileValue(schema.items);
      return (value) =>
        `'[' + ${value}.map((item) => ${item('item')}).join(',') + ']'`;
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
    // a label, not an operand).
    return `${comma}${JSON.stringify(`"${key}":`)} + ${compileValue(sub)(member(value, key))}`;
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
      const prop = `(first ? '' : ',') + ${JSON.stringify(`"${key}":`)} + ${compileValue(sub)(member(value, key))}`;
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

/** Recursive checker behind {@link compileValidator}: reports into
 * `issues` and returns — one issue per violated node, in schema traversal
 * order. Never throws: it reads, it does not parse. */
function checkValue(
  schema: SerializeSchema,
  data: unknown,
  path: string,
  issues: ValidationIssue[]
): void {
  switch (schema.type) {
    case 'object': {
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        issues.push({ path, message: `expected object, got ${typeOf(data)}` });
        return;
      }
      const record = data as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        // `undefined` counts as missing — the serializer's own "absent"
        // reading of an optional key, applied to a required one.
        if (record[key] === undefined) {
          issues.push({ path: joinPath(path, key), message: 'required' });
        }
      }
      for (const [key, sub] of Object.entries(schema.properties)) {
        const value = record[key];
        // Undeclared keys are none of the validator's business — the same
        // drop-undeclared contract `serialize` applies on output.
        if (value === undefined) continue;
        checkValue(sub, value, joinPath(path, key), issues);
      }
      return;
    }
    case 'array': {
      if (!Array.isArray(data)) {
        issues.push({ path, message: `expected array, got ${typeOf(data)}` });
        return;
      }
      for (let i = 0; i < data.length; i++) {
        checkValue(schema.items, data[i], joinPath(path, String(i)), issues);
      }
      return;
    }
    default: {
      // Nullable first: `null` satisfies the widened primitive before any
      // type check runs.
      if (schema.nullable === true && data === null) return;
      if (!primitiveOk(schema.type, data)) {
        issues.push({
          path,
          message: `expected ${schema.type}, got ${typeOf(data)}`,
        });
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
    checkValue(schema, data, '', issues);
    return issues;
  };
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
  const headers = new Headers(init?.headers);
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  headers.set('content-length', String(utf8Length(json)));
  ctx.res = newResponse(ctx, json, {
    status: init?.status,
    statusText: init?.statusText,
    headers,
  });
  return ctx.res;
}
