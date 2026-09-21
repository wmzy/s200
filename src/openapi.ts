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
 * @module
 */

import type { App } from './app';

import type { Ctx, Segment } from './types';

import type { SerializeSchema } from './serialize';

import { getAppMeta, getRouteMeta, type RouteMeta } from './meta';
import { json } from './respond';

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
