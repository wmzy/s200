/**
 * Standalone client code generation — `generateClient(app)` returns the
 * TypeScript source of a self-contained client module derived from the
 * app's runtime route table (the "app is data" payoff for codegen: no
 * build-time plugin, no reflection — the table is the spec). The emitted
 * module has zero s200 imports: params, path filling and query-string
 * logic are emitted inline, so the generated file runs anywhere web fetch
 * runs, with no s200 in `node_modules`.
 *
 * Types derive from what exists at runtime — the patterns themselves plus
 * `s200/meta` annotations and `throws` declarations: params from each
 * pattern, `init.query` from `meta.query`, `init.body` from `meta.body`,
 * and a status-discriminated response union from `meta.responses` merged
 * with the route's `throws` gates. Handlers' own body brands are
 * compile-time phantoms, so anything undeclared stays `unknown`, and
 * routes with no declarations keep the bare `Promise<Response>`.
 *
 * Output is deterministic — registration order, no timestamps — so it
 * diffs and commits like hand-written source.
 *
 * @module
 */

import type { App } from './app';

import type { Segment } from './types';
import type { SerializeSchema } from './serialize';

import {
  getRouteMeta,
  isMultipartBody,
  isQueryRequired,
  querySchemaOf,
  throwsErrors,
  uniqueName,
} from './meta';

/** Options for {@link generateClient}. */
export type GenerateClientOptions = {
  /** Name of the emitted factory function. @default 'createClient' */
  name?: string;
  /** Baked-in default for the emitted `baseUrl` parameter. */
  baseUrl?: string;
  /** Name of the emitted fetcher parameter. @default 'fetcher' */
  fetcherName?: string;
};

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function capitalize(word: string): string {
  return word === '' ? '' : word[0]!.toUpperCase() + word.slice(1);
}

/**
 * One pattern segment's contribution to a method name: `:id` → `Id`,
 * `:id?` → `Id`, `*path` → `Path`; static segments capitalize each
 * alphanumeric run (`user-list` → `UserList`).
 */
function segmentNamePart(segment: string): string {
  if (segment.startsWith(':')) {
    return capitalize(segment.endsWith('?') ? segment.slice(1, -1) : segment.slice(1));
  }
  if (segment.startsWith('*')) {
    return capitalize(segment.slice(1));
  }
  let part = '';
  for (const piece of segment.split(/[^A-Za-z0-9]+/)) {
    part += capitalize(piece);
  }
  return part;
}

/**
 * camelCase method name: lowercased HTTP method plus capitalized segments
 * (`GET /api/v1/users` → `getApiV1Users`).
 */
function routeMethodName(method: string, pattern: string): string {
  let name = method.toLowerCase().replace(/[^A-Za-z0-9_$]/g, '');
  for (const segment of pattern.split('/')) {
    if (segment !== '') {
      name += segmentNamePart(segment);
    }
  }
  return /^[A-Za-z_$]/.test(name) ? name : `_${name}`;
}

/** Emits a single-quoted TypeScript string literal. */
function tsString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** A property name as emitted TS: bare when it is an identifier,
 * JSON-quoted otherwise (`'content-type'`). */
function propertyKey(key: string): string {
  return IDENTIFIER.test(key) ? key : JSON.stringify(key);
}

/**
 * A `SerializeSchema` as a TypeScript type string — exactly the subset
 * the descriptor carries at runtime: `string`/`number` (`integer`
 * included)/`boolean`/`null`, arrays, and objects whose `required` list
 * drives optionality; `nullable` widens a primitive with `| null`. No
 * other markers exist in the DSL, so none are invented here.
 */
function schemaToTs(schema: SerializeSchema): string {
  switch (schema.type) {
    case 'object': {
      const required = new Set(schema.required ?? []);
      const members = Object.entries(schema.properties).map(
        ([key, sub]) =>
          `${propertyKey(key)}${required.has(key) ? '' : '?'}: ${schemaToTs(sub)}`
      );
      return members.length === 0 ? '{ }' : `{ ${members.join('; ')} }`;
    }
    case 'array': {
      const item = schemaToTs(schema.items);
      return `${item.includes('|') ? `(${item})` : item}[]`;
    }
    case 'string':
      return schema.nullable === true ? 'string | null' : 'string';
    case 'integer':
    case 'number':
      return schema.nullable === true ? 'number | null' : 'number';
    case 'boolean':
      return schema.nullable === true ? 'boolean | null' : 'boolean';
    case 'null':
      return 'null';
  }
}

/**
 * A `throws` example body as a TypeScript type string: structural
 * inference over the runtime value. Every key an example object shows is
 * required (optionality is unknowable from an example), array elements
 * union when they disagree, and values with no JSON analogue (functions,
 * `undefined`) fall back to `unknown`.
 */
function exampleToTs(example: unknown): string {
  if (example === null) {
    return 'null';
  }
  switch (typeof example) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'object': {
      if (Array.isArray(example)) {
        const itemTypes = [...new Set(example.map(exampleToTs))];
        if (itemTypes.length === 0) {
          return 'unknown[]';
        }
        const item = itemTypes.join(' | ');
        return `${item.includes('|') ? `(${item})` : item}[]`;
      }
      const members = Object.entries(example as Readonly<Record<string, unknown>>).map(
        ([key, value]) => `${propertyKey(key)}: ${exampleToTs(value)}`
      );
      return members.length === 0 ? '{ }' : `{ ${members.join('; ')} }`;
    }
    default:
      return 'unknown';
  }
}

/**
 * The inline `args` record for a pattern: every `:param`/`:param?`/
 * `*name` capture as a string member — required except optional params
 * (`/users/:id` → `{ id: string }`, `/posts/:postId?` →
 * `{ postId?: string }`). `undefined` when the pattern captures nothing.
 */
function argsTypeOf(segments: readonly Segment[]): string | undefined {
  const members: string[] = [];
  for (const segment of segments) {
    if (segment._tag === 'static') continue;
    const optional = segment._tag === 'param' && segment.optional ? '?' : '';
    members.push(`${propertyKey(segment.name)}${optional}: string`);
  }
  return members.length === 0 ? undefined : `{ ${members.join('; ')} }`;
}

/** One response branch of a route: its status literal and body type. */
type RouteBranch = { readonly status: number; readonly body: string };

// Emitted-file header: the honest contract — types come from the runtime
// route table plus meta/throws declarations; anything undeclared is
// unknown, routes with no declarations keep the bare Promise<Response>.
const HEADER = [
  '/**',
  ' * Generated by s200/codegen — do not edit by hand.',
  ' *',
  ' * One typed call per route registered at generation time (registration',
  ' * order). Types derive from the route table plus its s200/meta',
  ' * annotations and throws declarations: params from each pattern,',
  ' * init.query from meta.query, init.body from meta.body, and the',
  ' * response union from meta.responses merged with throws gates (meta',
  " * wins a status both declare). Handlers' own body brands are",
  ' * compile-time phantoms: anything neither meta nor throws declares',
  ' * types unknown, and routes with no declarations keep the bare',
  ' * Promise<Response>. JSON-shape bodies are stringified with a default',
  ' * content-type, mirroring s200/client.',
  ' */',
].join('\n');

// Emitted only when at least one route declares responses — the union
// member of every typed method signature.
const BRANCH_TYPE = [
  '/** One status branch of a typed response — the emitted twin of',
  " * s200/client's BranchResponse: `status` narrows to the branch's",
  ' * literal and `json()` resolves to the branch\'s body type (both are',
  " * Omit-readded so the platform's looser signatures cannot win). */",
  "type Branch<S extends number, T> = Omit<Response, 'json' | 'status'> & {",
  '  readonly status: S;',
  '  json(): Promise<T>;',
  '};',
].join('\n');

const QUERY_TYPE = [
  '/** Query-string values: arrays repeat the key, undefined is skipped,',
  ' * numbers and booleans stringify (mirrors s200/client). */',
  'type Query = Record<',
  '  string,',
  '  string | number | boolean | readonly (string | number | boolean)[] | undefined',
  '>;',
].join('\n');

const CLIENT_INIT_TYPE = [
  "/** RequestInit plus query-string sugar — a structural twin of s200's",
  ' * ClientInit, emitted locally so this module has no s200 imports. */',
  'export type ClientInit = RequestInit & { query?: Query };',
].join('\n');

// Emitted only when at least one method exists — every call routes
// through it. Mirrors s200/client: a JSON-shape body (plain object or
// array — the typed body of a declared route) is stringified and stamped
// with `content-type: application/json` unless one is set; strings and
// structured bodies (streams, blobs, forms, buffers) pass to fetch
// untouched. The method is the route's, never the caller's. When a route
// declares a JSON body the init parameter widens to `TypedInit` so the
// typed `body` rides through (its runtime handling is identical).
const IS_JSON_BODY = [
  '/** Whether a request body is a JSON shape (a plain object or array)',
  " * rather than one of the Web's structured body types. */",
  'function isJsonBody(value: unknown): value is object {',
  '  return (',
  "    typeof value === 'object' &&",
  '    value !== null &&',
  '    !(value instanceof ReadableStream) &&',
  '    !(value instanceof Blob) &&',
  '    !(value instanceof ArrayBuffer) &&',
  '    !(value instanceof URLSearchParams) &&',
  '    !(value instanceof FormData) &&',
  '    !ArrayBuffer.isView(value)',
  '  );',
  '}',
].join('\n');

/** The `send` helper, parameterized by the init type its callers use. */
function sendBlock(initType: string): string {
  return [
    'function send(',
    '  fetcher: typeof fetch,',
    '  url: string,',
    `  init: ${initType} | undefined,`,
    '  method: string',
    '): Promise<Response> {',
    '  if (init !== undefined && isJsonBody(init.body)) {',
    '    const headers = new Headers(init.headers);',
    "    if (!headers.has('content-type')) {",
    "      headers.set('content-type', 'application/json');",
    '    }',
    '    return fetcher(url, { ...init, headers, body: JSON.stringify(init.body), method });',
    '  }',
    '  // Only strings and structured bodies reach here — JSON shapes were',
    '  // intercepted above, so the typed-body view is spent (the cast is',
    '  // the same honest erasure s200/client makes).',
    '  return fetcher(url, { ...(init ?? {}), method } as RequestInit);',
    '}',
  ].join('\n');
}

// Emitted once per module, used by every method. Mirrors s200/client's
// buildPathFn: percent-encoding of substituted values, wildcards keep
// their slashes piece-wise encoded, absent optionals drop out entirely.
const FILL = [
  '/**',
  ' * Fills a route pattern against base: static segments verbatim, :name,',
  ' * :name? and *name substituted from args (URL-encoded; wildcard values',
  ' * keep their slashes, each piece encoded). Absent optional segments drop',
  ' * out entirely — a missing required param throws. The query record is',
  ' * appended as a search string.',
  ' */',
  'export function fill(',
  '  pattern: string,',
  '  args: Record<string, string> | undefined,',
  '  base: string,',
  '  query: Query | undefined',
  '): string {',
  '  let url = base;',
  "  for (const part of pattern.split('/')) {",
  "    if (part === '') {",
  '      continue;',
  '    }',
  "    if (part.startsWith(':')) {",
  "      const optional = part.endsWith('?');",
  '      const name = optional ? part.slice(1, -1) : part.slice(1);',
  '      const value = args === undefined ? undefined : args[name];',
  '      if (value === undefined) {',
  '        if (optional) {',
  '          continue;',
  '        }',
  "        throw new Error(`Missing param '${name}' for route '${pattern}'`);",
  '      }',
  "      url += '/' + encodeURIComponent(value);",
  "    } else if (part.startsWith('*')) {",
  '      const name = part.slice(1);',
  '      const value = args === undefined ? undefined : args[name];',
  '      if (value === undefined) {',
  "        throw new Error(`Missing param '${name}' for route '${pattern}'`);",
  '      }',
  "      url += '/' + value.split('/').map(encodeURIComponent).join('/');",
  '    } else {',
  "      url += '/' + part;",
  '    }',
  '  }',
  '  if (query !== undefined) {',
  '    const search = new URLSearchParams();',
  '    for (const [name, value] of Object.entries(query)) {',
  '      if (value === undefined) {',
  '        continue;',
  '      }',
  '      if (Array.isArray(value)) {',
  '        for (const item of value) {',
  '          search.append(name, String(item));',
  '        }',
  '      } else {',
  '        search.append(name, String(value));',
  '      }',
  '    }',
  '    const qs = search.toString();',
  "    if (qs !== '') {",
  "      url += '?' + qs;",
  '    }',
  '  }',
  '  return url;',
  '}',
].join('\n');

/**
 * Emits a standalone, typed TypeScript client module for `app`'s current
 * route table: one frozen-object method per registered route — args
 * typed from the pattern, `init` narrowed by `meta.query`/`meta.body`,
 * the response a status-discriminated union of `meta.responses` plus the
 * `throws` gates' error branches (meta wins a status both declare; a
 * declared body makes `init` required). Routes without declarations keep
 * today's exact loose shape: `(args, init?) => Promise<Response>`. `ALL`
 * routes are skipped (the runtime table cannot know which method you
 * want) and listed in a trailing comment instead.
 */
export function generateClient(app: App, options: GenerateClientOptions = {}): string {
  const factoryName = options.name ?? 'createClient';
  const fetcherName = options.fetcherName ?? 'fetcher';
  for (const [option, value] of [
    ['name', factoryName],
    ['fetcherName', fetcherName],
  ] as const) {
    if (!IDENTIFIER.test(value)) {
      throw new Error(
        `generateClient: options.${option} must be a valid TypeScript identifier, got '${value}'`
      );
    }
  }

  const used = new Set<string>();
  const methods: string[] = [];
  const typeDecls: string[] = [];
  const skippedAll: string[] = [];
  let typedResponses = false;
  let typedBodies = false;
  for (const route of app.routes) {
    if (route.method === 'ALL') {
      skippedAll.push(route.pattern);
      continue;
    }
    const name = uniqueName(routeMethodName(route.method, route.pattern), used);
    used.add(name);
    const typeBase = capitalize(name);
    const meta = getRouteMeta(route);

    // — init: meta.query narrows the query sugar, meta.body retypes (and
    // demands) the body — s200/client's rules, emitted as named types.
    // A `required` marker makes the query key non-optional, matching the
    // spec's `parameters[].required` and the gate's 422. A multipart
    // annotation types the body as `FormData` — the client's structured-
    // body rule: platform body types ride to fetch untouched.
    const bodyType =
      meta?.body === undefined
        ? undefined
        : isMultipartBody(meta.body)
          ? 'FormData'
          : schemaToTs(meta.body);
    if (bodyType !== undefined) {
      typedBodies = true;
    }
    const queryMembers = Object.entries(meta?.query ?? {}).map(
      ([key, entry]) =>
        `${propertyKey(key)}${isQueryRequired(entry) ? '' : '?'}: ${schemaToTs(querySchemaOf(entry))}`
    );
    const hasQuery = queryMembers.length > 0;
    let initParam = 'init?: ClientInit';
    if (bodyType !== undefined || hasQuery) {
      const initType =
        bodyType === undefined
          ? `ClientInit & { query?: { ${queryMembers.join('; ')} } }`
          : `Omit<ClientInit, 'body'${hasQuery ? " | 'query'" : ''}> & { body: ${bodyType}${
              hasQuery ? `; query?: { ${queryMembers.join('; ')} }` : ''
            } }`;
      typeDecls.push(`export type ${typeBase}Init = ${initType};`);
      // A declared body makes init required — the route reads a body,
      // the caller must send one.
      initParam = `init${bodyType === undefined ? '?' : ''}: ${typeBase}Init`;
    }

    // — responses: meta.responses merged with the throws gates' branches
    // (meta wins a status both declare — same rule the spec emitter
    // applies), one Branch member per status, ascending.
    const branches: RouteBranch[] = [];
    const metaStatuses = new Set<number>();
    for (const [status, entry] of Object.entries(meta?.responses ?? {})) {
      const code = Number(status);
      metaStatuses.add(code);
      branches.push({
        status: code,
        body: entry.schema === undefined ? 'unknown' : schemaToTs(entry.schema),
      });
    }
    for (const [status, example] of Object.entries(throwsErrors(route))) {
      const code = Number(status);
      if (metaStatuses.has(code)) continue;
      branches.push({ status: code, body: exampleToTs(example) });
    }
    let responseType = 'Response';
    if (branches.length > 0) {
      typedResponses = true;
      branches.sort((a, b) => a.status - b.status);
      const members = branches.map((branch) => `Branch<${branch.status}, ${branch.body}>`);
      typeDecls.push(
        members.length === 1
          ? `export type ${typeBase}Response = ${members[0]};`
          : `export type ${typeBase}Response =\n${members
              .map((member) => `  | ${member}`)
              .join('\n')};`
      );
      responseType = `${typeBase}Response`;
    }

    const patternLiteral = tsString(route.pattern);
    const methodLiteral = tsString(route.method);
    const argsType = argsTypeOf(route.segments);
    // The branch view over the real Response — the same honest-erasure
    // cast s200/client makes: the runtime value is a Response, the union
    // is its type-level narrowing.
    const call = `send(${fetcherName}, fill(${patternLiteral}, ${
      argsType === undefined ? 'undefined' : 'args'
    }, base, init?.query), init, ${methodLiteral})`;
    methods.push(
      `    ${name}: (${argsType === undefined ? '' : `args: ${argsType}, `}${initParam}): Promise<${responseType}> =>\n` +
        `      ${responseType === 'Response' ? call : `${call} as Promise<${responseType}>`},`
    );
  }

  const total = app.routes.length;
  const skippedNote =
    skippedAll.length === 0
      ? ''
      : ` (${skippedAll.length} ALL-method route${skippedAll.length === 1 ? '' : 's'} listed below)`;
  const factoryDoc = `/** Generated from ${total} route${total === 1 ? '' : 's'}${skippedNote}. */`;
  const baseUrlDefault = options.baseUrl === undefined ? '' : ` = ${tsString(options.baseUrl)}`;
  const factory: string[] = [
    `export function ${factoryName}(baseUrl: string${baseUrlDefault}, ${fetcherName}: typeof fetch = fetch) {`,
  ];
  if (methods.length > 0) {
    factory.push(
      "  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;",
      '  return Object.freeze({',
      ...methods,
      '  });',
    );
  } else {
    factory.push(
      '  // No method-specific routes were registered at generation time.',
      '  return Object.freeze({});',
    );
  }
  factory.push('}');

  const parts: string[] = [HEADER];
  if (typedResponses) {
    parts.push(BRANCH_TYPE);
  }
  parts.push(QUERY_TYPE, CLIENT_INIT_TYPE);
  // send/isJsonBody are referenced by method bodies only — an app with no
  // method routes must not carry dead weight. A declared JSON body widens
  // the init parameter with TypedInit (the runtime path is identical).
  if (methods.length > 0) {
    if (typedBodies) {
      parts.push(
        [
          '/** A ClientInit whose `body` is a declared JSON shape — the typed',
          ' * bodies of routes with a `body` annotation. */',
          "type TypedInit = Omit<ClientInit, 'body'> & { body: unknown };",
        ].join('\n')
      );
      parts.push(IS_JSON_BODY, sendBlock('ClientInit | TypedInit'));
    } else {
      parts.push(IS_JSON_BODY, sendBlock('ClientInit'));
    }
  }
  parts.push(FILL);
  if (typeDecls.length > 0) {
    parts.push(typeDecls.join('\n\n'));
  }
  parts.push(`${factoryDoc}\n${factory.join('\n')}`);
  if (skippedAll.length > 0) {
    parts.push(
      [
        '// ALL-method routes are skipped above — the runtime table cannot know',
        '// which HTTP method you want for them. Call fetch (or your own',
        '// fetcher) directly for these:',
        ...skippedAll.map((pattern) => `//   ALL ${pattern}`),
      ].join('\n')
    );
  }
  return `${parts.join('\n\n')}\n`;
}
