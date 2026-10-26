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
 * Schemas occurring ≥2 times (structural JSON equality) are hoisted into
 * `components.schemas` and referenced with `$ref`s — titled via the DSL's
 * optional `title`, else `Schema1`, `Schema2`, … in first-occurrence
 * order (`refSchemas: false` keeps everything inline). Query entries may
 * mark themselves required (`{ schema, required: true }`): the spec
 * emits `parameters[].required: true` and the validation gate rejects
 * the key's absence with a 422 — the two views stay isomorphic. `params`
 * entries annotate path parameters the same way: the entry's JSON Schema
 * replaces the bare string schema a pattern-only route carries, and the
 * validation gate checks the captured value (a `required` marker rejects
 * an optional segment's absence; the spec's own `required` stays
 * segment-driven, as OpenAPI pins it to the segment). `headers`/`cookies`
 * entries annotate request headers and cookies the same way (`in:
 * 'header'`/`in: 'cookie'`; headers gate at runtime, cookies stay
 * spec-only), and a `{ form: … }` body documents a
 * `multipart/form-data` request — file parts as
 * `{ type: 'string', format: 'binary' }` with `encoding` entries,
 * runtime validation left to `s200/multipart`/`s200/upload`.
 *
 * {@link withRouteValidation} is the runtime twin: the same annotations
 * become request gates — a 422 naming every violation's path — while
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
import {
  describeRoute,
  getAppMeta,
  getRouteMeta,
  isMultipartBody,
  isMultipartFile,
  isQueryRequired,
  multipartFormSchema,
  querySchemaOf,
  type MultipartBody,
  type QueryParam,
  type RouteMeta,
} from './meta';
import { parseQuery } from './query';
import { json } from './respond';
import { createRoute } from './router';
import { compileValidator, toJsonSchema } from './serialize';
import { validationError } from './validate';

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
  /**
   * Hoist repeated schemas into `components.schemas` and reference them
   * with `$ref`s — the default. Pass `false` to keep every schema
   * inline. Hoisting applies to any schema that occurs ≥2 times in the
   * document (structural JSON equality, query/body/response schemas
   * alike): it lands under its `title` when the DSL carries one, else a
   * synthetic `Schema1`, `Schema2`, … in first-occurrence order.
   * Single-use schemas stay inline.
   */
  readonly refSchemas?: boolean;
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
    readonly securitySchemes?: Readonly<Record<string, SecuritySchemeObject>>;
    /** Schemas hoisted by the `refSchemas` dedup (see
     * {@link OpenApiSpecOptions.refSchemas}), named by `title` or
     * synthetic first-occurrence order. */
    readonly schemas?: Readonly<Record<string, unknown>>;
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

/** Path-level parameters: every `:param`/`*wildcard` capture. A
 * {@link RouteMeta.params} entry for the segment's name swaps the bare
 * string schema for the entry's JSON Schema (via `toJsonSchema`,
 * registered as a hoistable schema site like query/body schemas);
 * `required` stays segment-driven — OpenAPI pins every path parameter to
 * the segment it fills (`:id` required, `:id?` optional). */
function pathParameters(segments: readonly Segment[], meta: RouteMeta, sites: SchemaSite[]): unknown[] {
  const out: unknown[] = [];
  for (const segment of segments) {
    if (segment._tag === 'static') continue;
    const entry = meta.params?.[segment.name];
    const param: { name: string; in: string; required: boolean; schema: unknown } = {
      name: segment.name,
      in: 'path',
      required: segment._tag === 'wildcard' ? true : !segment.optional,
      schema: entry === undefined ? { type: 'string' } : toJsonSchema(querySchemaOf(entry)),
    };
    if (entry !== undefined) {
      sites.push({ json: JSON.stringify(param.schema), holder: param });
    }
    out.push(param);
  }
  return out;
}

/**
 * One materialized schema site: the emitted JSON (the structural dedup
 * key) and the object holding it under its `schema` key — the hoist pass
 * swaps the repeated ones to `$ref`s in place.
 */
type SchemaSite = { readonly json: string; readonly holder: { schema: unknown } };

/** `~` and `/` are structural in JSON pointers — escape them in names. */
function escapePointer(name: string): string {
  return name.replaceAll('~', '~0').replaceAll('/', '~1');
}

/** Query-level parameters from {@link RouteMeta.query}: `required` is
 * `true` only where the annotation's marker form says so (`false` is the
 * query default, and the gate enforces exactly this flag). */
function queryParameters(meta: RouteMeta, sites: SchemaSite[]): unknown[] {
  const out: unknown[] = [];
  for (const [name, entry] of Object.entries(meta.query ?? {})) {
    const schema = toJsonSchema(querySchemaOf(entry));
    const param = {
      name,
      in: 'query',
      required: isQueryRequired(entry),
      schema,
    };
    sites.push({ json: JSON.stringify(schema), holder: param });
    out.push(param);
  }
  return out;
}

/** Header- and cookie-level parameters from {@link RouteMeta.headers} /
 * {@link RouteMeta.cookies}: the same entry forms as `query`, emitted
 * with the matching OpenAPI `in`. Only `headers` has a runtime gate —
 * cookies stay spec-only (see `RouteMeta.cookies`). */
function locatedParameters(
  entries: Record<string, QueryParam> | undefined,
  where: 'header' | 'cookie',
  sites: SchemaSite[]
): unknown[] {
  const out: unknown[] = [];
  for (const [name, entry] of Object.entries(entries ?? {})) {
    const schema = toJsonSchema(querySchemaOf(entry));
    const param = {
      name,
      in: where,
      required: isQueryRequired(entry),
      schema,
    };
    sites.push({ json: JSON.stringify(schema), holder: param });
    out.push(param);
  }
  return out;
}

/**
 * The OpenAPI `encoding` object of a multipart form: one entry per file
 * part, its `contentType` from the marker's allowlist (joined `', '` —
 * the spec allows a comma-separated list, and wildcards) or the binary
 * catch-all `application/octet-stream` pinned explicitly (the spec's
 * own default for string parts is `text/plain`, which a file part never
 * is). Text parts keep the default encoding — nothing is emitted.
 */
function multipartEncoding(form: MultipartBody['form']): Record<string, unknown> {
  const encoding: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(form)) {
    if (!isMultipartFile(entry)) continue;
    encoding[name] = {
      contentType:
        entry.contentTypes !== undefined && entry.contentTypes.length > 0
          ? entry.contentTypes.join(', ')
          : 'application/octet-stream',
    };
  }
  return encoding;
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
function responsesOf(
  meta: RouteMeta | undefined,
  route: Route,
  sites: SchemaSite[]
): Record<string, unknown> {
  const declared = meta?.responses;
  const gates = throwsErrors(route);
  const out: Record<string, unknown> = {};
  if (declared === undefined) {
    out[200] = { description: 'Successful response' };
  }
  for (const [status, entry] of Object.entries(declared ?? {})) {
    if (entry.schema === undefined) {
      out[status] = { description: entry.description };
      continue;
    }
    const media: { schema: unknown } = { schema: toJsonSchema(entry.schema) };
    sites.push({ json: JSON.stringify(media.schema), holder: media });
    out[status] = {
      description: entry.description,
      content: { 'application/json': media },
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
 *
 * `headers`/`cookies` annotations land as `parameters[]` entries with
 * `in: 'header'`/`in: 'cookie'` (the marker form's `required` rides
 * along, exactly like query entries), and a multipart `{ form: … }` body
 * emits as a `multipart/form-data` request body: text parts through
 * `toJsonSchema`, file parts (`{ file: true }`) as
 * `{ type: 'string', format: 'binary' }` with an `encoding` entry whose
 * `contentType` is the marker's allowlist (comma-joined) or the pinned
 * `application/octet-stream`. The binary `format` comes from the file
 * marker, not from schema conversion — `toJsonSchema` forwards only what
 * a `SerializeSchema` carries and invents no `format`/`enum`.
 *
 * Repeated schemas are deduplicated: any query/body/response schema
 * that occurs ≥2 times (structural JSON equality) is hoisted into
 * `components.schemas` and referenced with `$ref`s — named by the
 * schema's `title` when the DSL carries one, else `Schema1`, `Schema2`,
 * … in first-occurrence order. `refSchemas: false` keeps everything
 * inline. `components.securitySchemes` merges into the same
 * `components` object untouched.
 */
export function openapiSpec(app: App, options: OpenApiSpecOptions): OpenApiDocument {
  const paths: Record<string, Record<string, unknown>> = {};
  // Every schema site materialized below lands here; the hoist pass
  // turns the repeated ones into `components.schemas` `$ref`s.
  const sites: SchemaSite[] = [];
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
      ...pathParameters(route.segments, meta ?? {}, sites),
      ...queryParameters(meta ?? {}, sites),
      ...locatedParameters(meta?.headers, 'header', sites),
      ...locatedParameters(meta?.cookies, 'cookie', sites),
    ];
    let requestBody: Record<string, unknown> | undefined;
    const body = meta?.body;
    if (isMultipartBody(body)) {
      // The multipart media object carries the form schema beside its
      // `encoding` (file parts only); the schema is a hoistable site
      // exactly like a JSON body's.
      const media: { schema: unknown; encoding?: unknown } = {
        schema: multipartFormSchema(body.form),
      };
      const encoding = multipartEncoding(body.form);
      if (Object.keys(encoding).length > 0) media.encoding = encoding;
      sites.push({ json: JSON.stringify(media.schema), holder: media });
      requestBody = { content: { 'multipart/form-data': media } };
    } else if (body !== undefined) {
      const media: { schema: unknown } = { schema: toJsonSchema(body) };
      sites.push({ json: JSON.stringify(media.schema), holder: media });
      requestBody = { content: { 'application/json': media } };
    }
    const item: Record<string, unknown> = {
      ...(meta?.summary !== undefined ? { summary: meta.summary } : {}),
      ...(meta?.description !== undefined ? { description: meta.description } : {}),
      ...(meta?.tags !== undefined ? { tags: meta.tags } : {}),
      ...(meta?.deprecated === true ? { deprecated: true } : {}),
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(meta?.security !== undefined ? { security: meta.security } : {}),
      ...(requestBody !== undefined ? { requestBody } : {}),
      responses: responsesOf(meta, route, sites),
    };
    paths[path] ??= {};
    paths[path][route.method.toLowerCase()] = item;
  }
  // The dedup: group sites by structural JSON equality, hoist every
  // group of ≥2 under one name (its `title` when the DSL carries one,
  // else `Schema1`, `Schema2`, … in first-occurrence order — so builds
  // are reproducible), and swap each site's schema for the `$ref`.
  // Colliding names (same `title`, different JSON) get `_2`, `_3`, … in
  // registration-order, mirroring `s200/mcp`'s tool slugs.
  const schemas: Record<string, unknown> = {};
  if (options.refSchemas !== false) {
    const groups = new Map<string, SchemaSite[]>();
    for (const site of sites) {
      const group = groups.get(site.json);
      if (group === undefined) groups.set(site.json, [site]);
      else group.push(site);
    }
    const taken = new Set<string>();
    let seq = 0;
    for (const [json, group] of groups) {
      if (group.length < 2) continue;
      const parsed = JSON.parse(json) as { title?: unknown };
      const base =
        typeof parsed.title === 'string' && parsed.title !== ''
          ? parsed.title
          : `Schema${(seq += 1)}`;
      let name = base;
      let n = 2;
      while (taken.has(name)) {
        name = `${base}_${n}`;
        n += 1;
      }
      taken.add(name);
      schemas[name] = parsed;
      const ref = { $ref: `#/components/schemas/${escapePointer(name)}` };
      for (const { holder } of group) holder.schema = ref;
    }
  }
  const components: Record<string, unknown> = {
    ...(options.securitySchemes !== undefined
      ? { securitySchemes: options.securitySchemes }
      : {}),
    ...(Object.keys(schemas).length > 0 ? { schemas } : {}),
  };
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
    ...(Object.keys(components).length > 0 ? { components } : {}),
    paths,
  };
}

/**
 * The spec as a JSON response helper — pairs with {@link openapiSpec} for
 * the `/openapi.json` route. Uses the app-level metadata (`describeApp`)
 * when the caller omitted `info`-block fields; every other option
 * (`servers`, `securitySchemes`, `refSchemas`) passes through verbatim.
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

/**
 * The gate a validated route runs in front of its own middlewares:
 * validators compile once at transform time, then each request is
 * read-and-check with no state writes and no rewrites — conforming input
 * flows on untouched, and the handler's own `readJson`/`parseQuery` hits
 * the same caches.
 */
function validationGate(meta: RouteMeta): Middleware {
  // A multipart annotation documents the form, it does not gate the
  // body: multipart runtime validation (content-type, part caps, file
  // allowlists) is `s200/multipart`'s `streamForm` / `s200/upload`'s
  // `uploadForm` — the gate never reads (and never JSON-parses) it.
  const jsonBody = isMultipartBody(meta.body) ? undefined : meta.body;
  const body = jsonBody !== undefined ? compileValidator(jsonBody) : undefined;
  const query = Object.entries(meta.query ?? {}).map(
    ([key, entry]) =>
      [key, compileValidator(querySchemaOf(entry)), isQueryRequired(entry)] as const
  );
  const params = Object.entries(meta.params ?? {}).map(
    ([key, entry]) =>
      [key, compileValidator(querySchemaOf(entry)), isQueryRequired(entry)] as const
  );
  // Header entries gate exactly like query entries — one
  // case-insensitive `headers.get` read, values in the string domain
  // (repeated headers arrive comma-joined, the platform's own rule).
  const headers = Object.entries(meta.headers ?? {}).map(
    ([key, entry]) =>
      [key, compileValidator(querySchemaOf(entry)), isQueryRequired(entry)] as const
  );
  return async (ctx, next) => {
    if (body !== undefined) {
      const issues = body(await readJson(ctx));
      if (issues.length > 0) {
        throw validationError('body', issues);
      }
    }
    if (query.length > 0) {
      const record = parseQuery(ctx);
      for (const [key, validate, required] of query) {
        const value = record[key];
        // Absent keys pass — optional is the query default. A `required`
        // marker flips it: the spec's `parameters[].required: true` and
        // the gate reject the same requests (422, `validationError`).
        if (value === undefined) {
          if (required) {
            throw validationError(`query.${key}`, [{ path: '', message: 'required' }]);
          }
          continue;
        }
        const issues = validate(value);
        if (issues.length > 0) {
          throw validationError(`query.${key}`, issues);
        }
      }
    }
    if (params.length > 0) {
      // The captured params record — every matched segment is present;
      // only an optional segment (`:id?`) can leave a key absent, and a
      // `required` marker rejects exactly that absence (422), mirroring
      // the query branch. Values are seen verbatim (the string domain).
      for (const [key, validate, required] of params) {
        const value = ctx.params[key];
        if (value === undefined) {
          if (required) {
            throw validationError(`params.${key}`, [{ path: '', message: 'required' }]);
          }
          continue;
        }
        const issues = validate(value);
        if (issues.length > 0) {
          throw validationError(`params.${key}`, issues);
        }
      }
    }
    if (headers.length > 0) {
      // Absent headers pass — optional is the HTTP default; a `required`
      // marker flips it, exactly like the query branch, and the spec's
      // `parameters[].required: true` describes the same rejection.
      for (const [key, validate, required] of headers) {
        const value = ctx.req.headers.get(key);
        if (value === null) {
          if (required) {
            throw validationError(`headers.${key}`, [{ path: '', message: 'required' }]);
          }
          continue;
        }
        const issues = validate(value);
        if (issues.length > 0) {
          throw validationError(`headers.${key}`, issues);
        }
      }
    }
    await next();
  };
}

/**
 * Runtime enforcement of the documentation schemas — a pure data transform
 * in `mount`'s family (replace the route table, never mutate an entry in
 * place) that re-reads every {@link RouteMeta} annotation and rebuilds
 * the routes carrying a `body`, `query`, `params`, or `headers` schema
 * with a validation gate in front of the route's own middlewares.
 * Annotations are re-attached to the rebuilt routes, so `openapiSpec`
 * keeps describing the same schemas the gates enforce.
 *
 * Semantics: `body` is read once via `readJson` (cached like any other
 * body read) and checked with `compileValidator`; each annotated `query`
 * key present in the request is checked against its schema, and a key
 * marked required (`{ schema, required: true }` — the flag the spec
 * emits as `parameters[].required`) answers its absence with the same
 * 422 `validationError` (`'query.<key>: required'`); each annotated
 * `params` key is checked against its schema the same way
 * (`'params.<key>: …'` — a captured path parameter is always present, so
 * only an optional segment's absence can trip the marker); each
 * annotated `headers` key is checked against its schema with one
 * case-insensitive `headers.get` read (`'headers.<name>: …'`; absent
 * passes unless the marker says required). Two deliberate non-gates:
 * `cookies` entries document only — parsing the `cookie` header belongs
 * to `s200/cookies` (an entry this module must not import; a second
 * parsing convention would drift from it), so enforcement stays with the
 * batteries; and a multipart `{ form: … }` body documents the form
 * without reading it — multipart runtime validation (content-type, part
 * caps, file allowlists) is `s200/multipart`'s `streamForm` /
 * `s200/upload`'s `uploadForm`, and the gate never JSON-parses the
 * request. Values are seen verbatim — query strings and headers live in
 * the string domain, so `{ type: 'integer' }` rejects `?page=2`;
 * annotate string shapes or use `s200/query`'s `queryParams` when you
 * want coercion. Any issue rejects the chain with a 422 `HttpError`
 * built by `validationError` from `s200/validate`: `error` names the
 * first violation (`'body.address.city: required'`) and the body's
 * `issues` array carries the full list, each entry's path
 * scope-qualified the same way. Nothing is written to `ctx.state`
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
      (meta.body === undefined &&
        meta.query === undefined &&
        meta.params === undefined &&
        meta.headers === undefined)
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
