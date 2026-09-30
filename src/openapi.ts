/**
 * OpenAPI 3.1 emission from the route table itself — the "app is data"
 * story applied to API documentation: no code generation, no execution,
 * no schema library. Every route becomes a path item; {@link RouteMeta}
 * annotations (via `s200/meta`) fill in summaries, query/body schemas, and
 * response shapes, reusing the {@link SerializeSchema} DSL that already
 * compiles serializers and infers types.
 *
 * ```ts
 * const spec = openapiSpec(app, { title: 'Users API', version: '1.0.0' });
 * get(app, '/openapi.json', (ctx) => json(ctx, spec));
 * ```
 *
 * `ALL` routes are skipped (no single method to document); dynamic-pattern
 * routes emit with their pattern verbatim.
 *
 * {@link withRouteValidation} is the runtime twin: the same annotations
 * become request gates — a 422 naming the first violation's path — while
 * `openapiSpec` keeps describing them, one source of truth for both.
 *
 * @module
 */

import type { App } from './app';

import type {
  Ctx,
  Handler,
  Middleware,
  Route,
  RouteDef,
  Segment,
  State,
} from './types';

import { readJson } from './body';
import { httpError } from './errors';
import { describeRoute, getAppMeta, getRouteMeta, type RouteMeta } from './meta';
import { parseQuery } from './query';
import { json } from './respond';
import { createRoute } from './router';
import { compileValidator, type SerializeSchema, type ValidationIssue } from './serialize';

/** The emitted document — OpenAPI 3.1.0, JSON-compatible by construction. */
export type OpenApiDocument = {
  readonly openapi: '3.1.0';
  readonly info: {
    readonly title: string;
    readonly version: string;
    readonly description?: string;
  };
  readonly paths: Record<string, Record<string, unknown>>;
};

/** A `SerializeSchema` as a JSON Schema (OpenAPI 3.1's schema dialect). */
function toJsonSchema(schema: SerializeSchema): Record<string, unknown> {
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
      };
    }
    case 'array':
      return { type: 'array', items: toJsonSchema(schema.items) };
    default:
      return schema.nullable === true
        ? { type: [schema.type, 'null'] }
        : { type: schema.type };
  }
}

/** `/users/:id/*path` → `/users/{id}/{path}` — OpenAPI's path templating. */
function openapiPath(pattern: string): string {
  return pattern
    .split('/')
    .map((part) =>
      part.startsWith(':') || part.startsWith('*') ? `{${part.slice(1)}}` : part
    )
    .join('/');
}

/** Path-level parameters: every `:param`/`*wildcard` capture. */
function pathParameters(segments: readonly Segment[]): unknown[] {
  const out: unknown[] = [];
  for (const segment of segments) {
    if (segment._tag === 'static') continue;
    out.push({
      name: segment.name,
      in: 'path',
      required: segment._tag === 'wildcard' ? true : !segment.optional,
      schema: { type: 'string' },
    });
  }
  return out;
}

/** Query-level parameters from {@link RouteMeta.query}. */
function queryParameters(meta: RouteMeta): unknown[] {
  const out: unknown[] = [];
  for (const [name, schema] of Object.entries(meta.query ?? {})) {
    out.push({
      name,
      in: 'query',
      required: false,
      schema: toJsonSchema(schema),
    });
  }
  return out;
}

/** Responses by status code, from the metadata (or a bare 200). */
function responsesOf(meta: RouteMeta | undefined): Record<string, unknown> {
  const declared = meta?.responses;
  if (declared === undefined) {
    return { 200: { description: 'Successful response' } };
  }
  const out: Record<string, unknown> = {};
  for (const [status, entry] of Object.entries(declared)) {
    out[status] = {
      description: entry.description,
      ...(entry.schema === undefined
        ? {}
        : {
            content: {
              'application/json': { schema: toJsonSchema(entry.schema) },
            },
          }),
    };
  }
  return out;
}

/**
 * Builds the OpenAPI 3.1 document for an app. Routes without metadata are
 * still documented (method + path + parameters, bare 200) — the table is
 * the source of truth; metadata only enriches it.
 */
export function openapiSpec(
  app: App,
  info: {
    readonly title: string;
    readonly version: string;
    readonly description?: string;
  }
): OpenApiDocument {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of app.routes) {
    if (route.method === 'ALL') continue;
    const meta = getRouteMeta(route);
    const path = openapiPath(route.pattern);
    const parameters = [
      ...pathParameters(route.segments),
      ...queryParameters(meta ?? {}),
    ];
    const item: Record<string, unknown> = {
      ...(meta?.summary !== undefined ? { summary: meta.summary } : {}),
      ...(meta?.description !== undefined ? { description: meta.description } : {}),
      ...(meta?.tags !== undefined ? { tags: meta.tags } : {}),
      ...(meta?.deprecated === true ? { deprecated: true } : {}),
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(meta?.body !== undefined
        ? {
            requestBody: {
              content: {
                'application/json': { schema: toJsonSchema(meta.body) },
              },
            },
          }
        : {}),
      responses: responsesOf(meta),
    };
    paths[path] ??= {};
    paths[path][route.method.toLowerCase()] = item;
  }
  return { openapi: '3.1.0', info, paths };
}

/**
 * The spec as a JSON response helper — pairs with {@link openapiSpec} for
 * the `/openapi.json` route. Uses the app-level metadata (`describeApp`)
 * when the caller omitted `info`.
 */
export function openapiJson(
  ctx: Ctx,
  app: App,
  info?: {
    readonly title: string;
    readonly version: string;
    readonly description?: string;
  }
): Response {
  const appMeta = getAppMeta(app);
  return json(ctx, openapiSpec(app, {
    title: info?.title ?? appMeta?.title ?? 'API',
    version: info?.version ?? appMeta?.version ?? '0.0.0',
    description: info?.description ?? appMeta?.description,
  }));
}

/** The 422 message: the scope-qualified path of the first issue plus its
 * reason — `'body.items.2.name: expected string, got number'`. Callers
 * arrive only with a non-empty list; the fallbacks keep the helper total
 * under `noUncheckedIndexedAccess`. */
function summarize(scope: string, issues: readonly ValidationIssue[]): string {
  const first = issues[0];
  const path = first?.path ?? '';
  const message = first?.message ?? '';
  return path === '' ? `${scope}: ${message}` : `${scope}.${path}: ${message}`;
}

/**
 * The gate a validated route runs in front of its own middlewares:
 * validators compile once at transform time, then each request is
 * read-and-check with no state writes and no rewrites — conforming input
 * flows on untouched, and the handler's own `readJson`/`parseQuery` hits
 * the same caches.
 */
function validationGate(meta: RouteMeta): Middleware {
  const body = meta.body !== undefined ? compileValidator(meta.body) : undefined;
  const query = Object.entries(meta.query ?? {}).map(
    ([key, schema]) => [key, compileValidator(schema)] as const
  );
  return async (ctx, next) => {
    if (body !== undefined) {
      const issues = body(await readJson(ctx));
      if (issues.length > 0) {
        throw httpError(422, summarize('body', issues));
      }
    }
    if (query.length > 0) {
      const record = parseQuery(ctx);
      for (const [key, validate] of query) {
        const value = record[key];
        // Absent keys pass — query parameters are always optional (the
        // spec emits `required: false` for every one of them).
        if (value === undefined) continue;
        const issues = validate(value);
        if (issues.length > 0) {
          throw httpError(422, summarize(`query.${key}`, issues));
        }
      }
    }
    await next();
  };
}

/**
 * Runtime enforcement of the documentation schemas — a pure data transform
 * in `mount`'s family (replace the route table, never mutate an entry in
 * place) that re-reads every {@link RouteMeta} annotation and rebuilds the
 * routes carrying a `body` or `query` schema with a validation gate in
 * front of the route's own middlewares. Annotations are re-attached to the
 * rebuilt routes, so `openapiSpec` keeps describing the same schemas the
 * gates enforce.
 *
 * Semantics: `body` is read once via `readJson` (cached like any other
 * body read) and checked with `compileValidator`; each annotated `query`
 * key present in the request is checked against its schema. Values are
 * seen verbatim — query strings live in the string domain, so
 * `{ type: 'integer' }` rejects `?page=2`; annotate string shapes or use
 * `s200/query`'s `queryParams` when you want coercion. Any issue rejects
 * the chain with a 422 `HttpError` naming the first violation
 * (`'body.address.city: required'`). Nothing is written to `ctx.state`
 * and nothing is coerced: this is the documented schema's runtime
 * cash-in, not a second typed input channel — for that, use
 * `s200/validate`'s `jsonBody` gate.
 *
 * Ordering contract: `describeRoute` keys metadata by the route objects
 * alive at call time, so describe first, then transform (repeated calls
 * stack gates — harmless, wasteful). A mounted sub-app's annotations must
 * target the parent after `mount`, which rebuilds route objects;
 * unannotated routes are kept by reference — zero rebuild, zero request
 * time cost. App-level middlewares and the snapshot-freeze semantics are
 * untouched: only the `routes` array is replaced.
 */
export function withRouteValidation<
  S extends State = State,
  R extends readonly RouteDef[] = readonly RouteDef[]
>(app: App<S, R>): App<S, R> {
  const rebuilt: Route[] = [];
  const reattach: { method: string; pattern: string; meta: RouteMeta }[] = [];
  let changed = false;
  for (const route of app.routes) {
    const meta = getRouteMeta(route);
    if (
      meta === undefined ||
      (meta.body === undefined && meta.query === undefined)
    ) {
      rebuilt.push(route);
      continue;
    }
    changed = true;
    rebuilt.push(
      createRoute(route.method, route.pattern, route.handler as Handler, [
        validationGate(meta),
        ...route.middlewares,
      ])
    );
    reattach.push({ method: route.method, pattern: route.pattern, meta });
  }
  if (changed) {
    app.routes = Object.freeze(rebuilt);
    for (const { method, pattern, meta } of reattach) {
      // `describeRoute` only walks `app.routes` (method/pattern matching);
      // the cast bridges its default-state signature to this app's `S`.
      describeRoute(app as App, method, pattern, meta);
    }
  }
  return app;
}
