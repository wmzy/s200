/**
 * Route metadata for `s200/openapi`: pure annotations stored off-app in a
 * `WeakMap` keyed by the route objects themselves, so the core `App` shape
 * stays untouched and tree-shaking keeps the metadata out of every
 * non-OpenAPI consumer. `describeRoute`/`describeApp` fill it;
 * `openapiSpec` (in `s200/openapi`) reads it back.
 *
 * Schemas reuse {@link SerializeSchema} (`s200/serialize`) — the same
 * declarative shape that already compiles serializers and infers input
 * types, now also documents the API surface.
 *
 * @module
 */

import type { App } from './app';

import type { Route } from './types';

import { toJsonSchema, type SerializeSchema } from './serialize';

export type RouteMeta = {
  /** Short operation summary (the `summary` field of the path item). */
  readonly summary?: string;
  readonly description?: string;
  /** OpenAPI tags — group operations in the rendered docs. */
  readonly tags?: readonly string[];
  readonly deprecated?: boolean;
  /**
   * Query-string parameter schemas, keyed by parameter name. Each entry
   * is the parameter's {@link SerializeSchema} bare (optional — the
   * default), or the `{ schema, required: true }` marker form when the
   * request must carry the key: `openapiSpec` emits
   * `parameters[].required: true`, `withRouteValidation` answers a
   * missing key with a 422, and `s200/mcp`'s tool input schema lists
   * the name under `required` — one flag, three synchronized views.
   */
  readonly query?: Record<string, QueryParam>;
  /**
   * Path-parameter schemas, keyed by parameter name — the `id` of
   * `/users/:id`. Each entry is the parameter's {@link SerializeSchema}
   * bare, or the `{ schema, required: true }` marker form when an
   * optional segment's absence must still reject. `openapiSpec` emits the
   * entry as the path parameter's JSON Schema (via `toJsonSchema`, with
   * the same dedup/hoist pass as query/body schemas; parameters without
   * an entry keep the bare string schema), and `withRouteValidation`
   * checks the captured value against it — the two views stay
   * isomorphic. The emitted `required` stays segment-driven (`:id`
   * required, `:id?` optional): OpenAPI pins every path parameter to the
   * segment it fills.
   */
  readonly params?: Record<string, QueryParam>;
  /**
   * Request-header parameter schemas, keyed by header name — the same
   * entry forms as {@link query}: the parameter's
   * {@link SerializeSchema} bare (optional — the default), or the
   * `{ schema, required: true }` marker when the request must carry the
   * header. `openapiSpec` emits each entry as a `parameters[]` object
   * with `in: 'header'`, and `withRouteValidation` checks the header's
   * value (`'headers.<name>: …'` on failure) — the two views stay
   * isomorphic. Names compare case-insensitively at runtime (the
   * platform's own header normalization).
   */
  readonly headers?: Record<string, QueryParam>;
  /**
   * Cookie parameter schemas, keyed by cookie name — the same entry forms
   * as {@link query}. `openapiSpec` emits each entry as a
   * `parameters[]` object with `in: 'cookie'`. Spec-only by design:
   * `withRouteValidation` does not gate cookies (parsing the `cookie`
   * header lives in `s200/cookies`, an entry this module must not
   * import, and a second parsing convention here would drift from it) —
   * enforce with the cookies battery or your own gate.
   */
  readonly cookies?: Record<string, QueryParam>;
  /**
   * Request-body annotation (`content: application/json`), or the
   * multipart marker `{ form: … }` for a `multipart/form-data` body —
   * see {@link MultipartBody}.
   */
  readonly body?: SerializeSchema | MultipartBody;
  /** Responses by status code; a missing schema = no content declared. */
  readonly responses?: Record<
    number,
    { readonly description: string; readonly schema?: SerializeSchema }
  >;
  /**
   * OpenAPI security requirements for this operation — one entry per
   * alternative (OR-of-ANDs, exactly OpenAPI's `security` shape); each
   * entry maps a scheme name (declared via `openapiSpec`'s
   * `securitySchemes`) to its required scopes, `[]` when the scheme needs
   * none. Emitted verbatim as the operation's `security`.
   */
  readonly security?: readonly Record<string, readonly string[]>[];
};

export type AppMeta = {
  readonly title?: string;
  readonly version?: string;
  readonly description?: string;
};

/**
 * One parameter entry's annotation (the shared form of `RouteMeta.query`,
 * `params`, `headers`, and `cookies` entries): the bare
 * {@link SerializeSchema} (optional — the default, matching the HTTP
 * norm), or the `{ schema, required: true }` marker form when the key
 * must be present. The marker never changes the value's shape — only its
 * presence.
 */
export type QueryParam =
  | SerializeSchema
  | { readonly schema: SerializeSchema; readonly required?: boolean };

/** The query entry's schema, unwrapping the marker form. */
export function querySchemaOf(entry: QueryParam): SerializeSchema {
  return 'schema' in entry ? entry.schema : entry;
}

/** True when the query entry is marked required (`false` for the bare
 * schema form — optional stays the default). */
export function isQueryRequired(entry: QueryParam): boolean {
  return 'schema' in entry && entry.required === true;
}

/**
 * One `multipart/form-data` part's annotation: a text field's
 * {@link QueryParam} (either form), or the `{ file: true, … }` marker for
 * a file part — `required: true` names a part the form must carry, and
 * `contentTypes` allowlists the file's media types (emitted into the
 * OpenAPI `encoding` entry's `contentType`).
 */
export type MultipartField =
  | QueryParam
  | {
      readonly file: true;
      readonly required?: boolean;
      readonly contentTypes?: readonly string[];
    };

/** The file-part marker of a {@link MultipartField}. */
export type MultipartFileField = Extract<MultipartField, { readonly file: true }>;

/**
 * The `multipart/form-data` request-body annotation: one entry per form
 * part under `form`. Distinct from every {@link SerializeSchema} by
 * construction (schemas carry `type`, this marker carries `form`), so
 * {@link isMultipartBody} narrows the {@link RouteMeta.body} union
 * soundly.
 */
export type MultipartBody = {
  readonly form: Record<string, MultipartField>;
};

/** True when the body annotation is the multipart marker. */
export function isMultipartBody(
  body: SerializeSchema | MultipartBody | undefined
): body is MultipartBody {
  return body !== undefined && 'form' in body;
}

/** True when the multipart entry is the file-part marker. */
export function isMultipartFile(entry: MultipartField): entry is MultipartFileField {
  return 'file' in entry;
}

/** True when the multipart entry is marked required — either entry form. */
export function isMultipartRequired(entry: MultipartField): boolean {
  return 'file' in entry ? entry.required === true : isQueryRequired(entry);
}

/**
 * A multipart form as one JSON Schema object: text fields via
 * `toJsonSchema`, file parts as `{ type: 'string', format: 'binary' }`,
 * and the `required` markers collected into the schema's `required`.
 *
 * This is the one place s200 emits a `format` — and it comes from the
 * explicit `file` marker, not from schema conversion: `toJsonSchema`
 * forwards only the fields a `SerializeSchema` carries (the DSL has no
 * `format`/`enum` markers, so it invents none), while `binary` is
 * OpenAPI's standard file-part spelling and belongs to the multipart
 * annotation that declares the file.
 */
export function multipartFormSchema(
  form: Record<string, MultipartField>
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, entry] of Object.entries(form)) {
    properties[name] = isMultipartFile(entry)
      ? { type: 'string', format: 'binary' }
      : toJsonSchema(querySchemaOf(entry));
    if (isMultipartRequired(entry)) required.push(name);
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

// Stored beside the app, never on it: importing s200/meta is the only way
// metadata exists (same pattern as s200/websocket's registry).
const routeMeta = new WeakMap<Route, RouteMeta>();
const appMeta = new WeakMap<App, AppMeta>();

/**
 * Annotates every route registered for `method` (normalized uppercase) and
 * `pattern` on this app. No-op when nothing matches — describe after
 * registration, or re-describe after re-registration.
 */
export function describeRoute(
  app: App,
  method: string,
  pattern: string,
  meta: RouteMeta
): void {
  const normalized = method.toUpperCase();
  for (const route of app.routes) {
    if (route.method === normalized && route.pattern === pattern) {
      routeMeta.set(route, meta);
    }
  }
}

/** Annotates the app itself (the OpenAPI `info` block). */
export function describeApp(app: App, meta: AppMeta): void {
  appMeta.set(app, meta);
}

/** The metadata attached to a route, when `describeRoute` set any. */
export function getRouteMeta(route: Route): RouteMeta | undefined {
  return routeMeta.get(route);
}

/** The app-level annotation, when `describeApp` set one. */
export function getAppMeta(app: App): AppMeta | undefined {
  return appMeta.get(app);
}
