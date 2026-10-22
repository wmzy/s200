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
 * `ALL` routes are skipped (no single method to document) with a
 * once-per-app `console.warn` naming the pattern — the documented usage
 * rebuilds the spec per request, so the warning is deduped for the
 * process lifetime, not per build; dynamic-pattern routes emit with their
 * pattern verbatim.
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
import { compileValidator, toJsonSchema, type ValidationIssue } from './serialize';

/**
 * One named security scheme — OpenAPI 3.1's `Security Scheme Object`
 * shape, kept permissive (s200 emits data, it does not validate it):
 * `type` picks the flavor, the rest of the fields are the ones that
 * flavor reads (`name`/`in` for `apiKey`, `scheme`/`bearerFormat` for
 * `http`, `flows` for `oauth2`, `openIdConnectUrl` for `openIdConnect`).
 */
export type SecuritySchemeObject = {
  readonly type: 'apiKey' | 'http' | 'oauth2' | 'openIdConnect' | 'mutualTLS';
  readonly description?: string;
  readonly name?: string;
  readonly in?: 'query' | 'header' | 'cookie';
  readonly scheme?: string;
  readonly bearerFormat?: string;
  readonly flows?: Record<string, unknown>;
  readonly openIdConnectUrl?: string;
};

/**
 * Options for {@link openapiSpec} (and {@link openapiJson}'s override):
 * the OpenAPI `info` block plus optional document-level `servers` and
 * `securitySchemes` (emitted under `components.securitySchemes`).
 */
export type OpenApiSpecOptions = {
  readonly title: string;
  readonly version: string;
  readonly description?: string;
  /** Connect entries — emitted verbatim as the document's `servers`. */
  readonly servers?: readonly { readonly url: string; readonly description?: string }[];
  /** Named schemes — emitted under `components.securitySchemes` and
   * referenced by `RouteMeta.security` entries. */
  readonly securitySchemes?: Readonly<Record<string, SecuritySchemeObject>>;
};

/** The emitted document — OpenAPI 3.1.0, JSON-compatible by construction. */
export type OpenApiDocument = {
  readonly openapi: '3.1.0';
  readonly info: {
    readonly title: string;
    readonly version: string;
    readonly description?: string;
  };
  readonly servers?: readonly { readonly url: string; readonly description?: string }[];
  readonly components?: {
    readonly securitySchemes: Readonly<Record<string, SecuritySchemeObject>>;
  };
  readonly paths: Record<string, Record<string, unknown>>;
};

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

/**
 * The error branches a route's `throws` gates declare, read off the live
 * middleware chain: each gate's runtime `_errors` stash (status → example
 * body — see `s200`'s `throws`) merges into one record. When two gates
 * name the same status the later registration wins: the type layer unions
 * body shapes, but example values cannot union, and the last declaration
 * is the honest pick.
 */
function throwsErrors(route: Route): Record<number, unknown> {
  const merged: Record<number, unknown> = {};
  for (const middleware of route.middlewares) {
    const declared = (middleware as { readonly _errors?: unknown })._errors;
    if (typeof declared !== 'object' || declared === null) continue;
    for (const [status, example] of Object.entries(
      declared as Readonly<Record<string, unknown>>
    )) {
      const code = Number(status);
      if (Number.isInteger(code) && code >= 100 && code <= 599) {
        merged[code] = example;
      }
    }
  }
  return merged;
}

/** Structural JSON-string equality for the array-items agreement check. */
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A `throws` example body as a JSON Schema: structural inference over the
 * example value — strings/booleans/null map directly, integrality splits
 * `integer` from `number`, arrays describe their `items` when every
 * element agrees (an empty or mixed array stays unconstrained), objects
 * list the keys present. Required-ness is unknowable from an example, so
 * no key is ever `required`. `undefined` means "no body declared" — the
 * status answers with no JSON content.
 */
function exampleToJsonSchema(example: unknown): Record<string, unknown> | undefined {
  if (example === undefined) return undefined;
  if (example === null) return { type: 'null' };
  if (typeof example === 'string') return { type: 'string' };
  if (typeof example === 'boolean') return { type: 'boolean' };
  if (typeof example === 'number') {
    return { type: Number.isInteger(example) ? 'integer' : 'number' };
  }
  if (Array.isArray(example)) {
    const schemas = example.map(exampleToJsonSchema);
    const first = schemas[0];
    return first !== undefined && schemas.every((schema) => sameJson(schema, first))
      ? { type: 'array', items: first }
      : { type: 'array' };
  }
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(example as Readonly<Record<string, unknown>>)) {
    const schema = exampleToJsonSchema(value);
    if (schema !== undefined) {
      properties[key] = schema;
    }
  }
  return { type: 'object', ...(Object.keys(properties).length > 0 ? { properties } : {}) };
}

/**
 * Responses by status code: the metadata's declarations (or a bare 200)
 * merged with the `throws` gates' error branches. Neither clobbers the
 * other — a status only one side declares is emitted; on conflict
 * `meta.responses` wins (its description and schema were written for the
 * spec, the gate's example is only an inference seed).
 */
function responsesOf(meta: RouteMeta | undefined, route: Route): Record<string, unknown> {
  const declared = meta?.responses;
  const gates = throwsErrors(route);
  const out: Record<string, unknown> = {};
  if (declared === undefined) {
    out[200] = { description: 'Successful response' };
  }
  for (const [status, entry] of Object.entries(declared ?? {})) {
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
  for (const [status, example] of Object.entries(gates)) {
    if (status in out) continue;
    const schema = exampleToJsonSchema(example);
    out[status] = {
      description: 'Error response',
      ...(schema === undefined
        ? {}
        : {
            content: {
              'application/json': { schema },
            },
          }),
    };
  }
  return out;
}

/** `ALL`-route warnings already emitted, per app — `openapiJson` handlers
 * rebuild the spec on every request, so a per-build set would log on every
 * hit. Weak, so a discarded app is collectable. */
const warnedAllPatterns = new WeakMap<App, Set<string>>();

/**
 * Builds the OpenAPI 3.1 document for an app. Routes without metadata are
 * still documented (method + path + parameters, bare 200) — the table is
 * the source of truth; metadata only enriches it. Error branches declared
 * by `throws` gates on a route's chain become error `responses` (merged
 * with `meta.responses` — meta wins a status both declare), and
 * `meta.security` lands on the operation verbatim.
 *
 * `ALL` routes are skipped — there is no single method to document — and
 * each distinct pattern warns once per app for the process lifetime:
 * `[s200] openapi: route /x uses ALL — expand to explicit methods to
 * document it`. Dynamic-pattern routes emit with their pattern verbatim.
 */
export function openapiSpec(app: App, options: OpenApiSpecOptions): OpenApiDocument {
  const paths: Record<string, Record<string, unknown>> = {};
  let warnedAll = warnedAllPatterns.get(app);
  if (warnedAll === undefined) {
    warnedAll = new Set<string>();
    warnedAllPatterns.set(app, warnedAll);
  }
  for (const route of app.routes) {
    if (route.method === 'ALL') {
      if (!warnedAll.has(route.pattern)) {
        warnedAll.add(route.pattern);
        console.warn(
          `[s200] openapi: route ${route.pattern} uses ALL — expand to explicit methods to document it`
        );
      }
      continue;
    }
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
      ...(meta?.security !== undefined ? { security: meta.security } : {}),
      ...(meta?.body !== undefined
        ? {
            requestBody: {
              content: {
                'application/json': { schema: toJsonSchema(meta.body) },
              },
            },
          }
        : {}),
      responses: responsesOf(meta, route),
    };
    paths[path] ??= {};
    paths[path][route.method.toLowerCase()] = item;
  }
  return {
    openapi: '3.1.0',
    info: {
      title: options.title,
      version: options.version,
      description: options.description,
    },
    ...(options.servers !== undefined && options.servers.length > 0
      ? { servers: options.servers }
      : {}),
    ...(options.securitySchemes !== undefined
      ? { components: { securitySchemes: options.securitySchemes } }
      : {}),
    paths,
  };
}

/**
 * The spec as a JSON response helper — pairs with {@link openapiSpec} for
 * the `/openapi.json` route. Uses the app-level metadata (`describeApp`)
 * when the caller omitted `info`-block fields; every other option
 * (`servers`, `securitySchemes`) passes through verbatim.
 */
export function openapiJson(ctx: Ctx, app: App, options?: OpenApiSpecOptions): Response {
  const appMeta = getAppMeta(app);
  return json(ctx, openapiSpec(app, {
    ...(options === undefined ? {} : options),
    title: options?.title ?? appMeta?.title ?? 'API',
    version: options?.version ?? appMeta?.version ?? '0.0.0',
    description: options?.description ?? appMeta?.description,
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
