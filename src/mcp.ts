/**
 * MCP (Model Context Protocol) exposure of the route table — `s200/mcp`.
 * The `describeRoute` annotations that drive `s200/openapi` drive an MCP
 * tool list with zero extra bookkeeping: `toolManifest` compiles the
 * routes into MCP tool definitions (inputs straight from the
 * `SerializeSchema` DSL via `toJsonSchema`), and `createMcpHandler`
 * answers the JSON-RPC surface an MCP client needs — `initialize`,
 * `tools/list`, `tools/call` — statelessly, by round-tripping each call
 * through `handle`, so the app's full middleware chain (auth, rate
 * limits, validation gates) still runs per tool invocation.
 *
 * Zero dependencies and zero sessions: every POST is answered with one
 * `application/json` body (`202` with no body for notifications), no SSE
 * stream is ever opened, and no `Mcp-Session-Id` is issued — a client
 * asking for `text/event-stream` still gets the JSON reply. JSON-RPC
 * batch arrays are rejected (`-32600`): the spec removed batching in
 * revision `2025-06-18`.
 *
 * @module
 */

import type { App } from './app';

import type { Route } from './types';

import { paramRequired } from './types';

import { handle } from './app';
import {
  getAppMeta,
  getRouteMeta,
  isMultipartBody,
  multipartFormSchema,
  queryEntries,
  uniqueName,
  type MultipartBody,
  type RouteMeta,
} from './meta';
import { toJsonSchema, type SerializeSchema } from './serialize';
import { appendQuery, fillSegments } from './pattern-fill';

/**
 * Protocol revisions this handler negotiates. `2025-06-18` is the newest
 * one the stateless tools subset needs (batching already removed; no
 * later feature in use). Older clients are met on their own revision;
 * newer ones get ours back and disconnect if they cannot accept it —
 * exactly the spec's negotiation rule.
 */
const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];
const LATEST_PROTOCOL_VERSION = '2025-06-18';

// JSON-RPC 2.0 error codes this handler emits.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/** A JSON Schema value — recursive by construction, JSON-compatible. */
export type JsonSchema = Record<string, unknown>;

/** One MCP tool: a named route with its JSON Schema input contract. */
export type McpTool = {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, JsonSchema>;
    readonly required?: readonly string[];
  };
};

/** {@link toolManifest}'s output — the `tools/list` payload, plain data. */
export type McpToolManifest = { readonly tools: readonly McpTool[] };

/** Options for {@link toolManifest}. */
export type McpOptions = {
  /**
   * Also expose routes without `describeRoute` metadata (default: only
   * annotated routes become tools).
   */
  readonly includeUnannotated?: boolean;
};

/**
 * Options for {@link createMcpHandler}: the manifest options plus the
 * `serverInfo` the `initialize` handshake reports. Unset `serverInfo`
 * falls back to `describeApp`'s `title`/`version`, then `'s200'`/
 * `'1.0.0'`.
 */
export type McpHandlerOptions = McpOptions & {
  readonly serverInfo?: { readonly name: string; readonly version: string };
};

/**
 * The tool-name slug: lowercased method, `_`, then the pattern with its
 * leading `/` dropped and every character outside `[A-Za-z0-9]` mapped
 * one-to-one to `_` (no collapsing — distinct shapes stay distinct):
 *
 * - `GET /users` → `get_users`
 * - `GET /users/:id` → `get_users__id`
 * - `GET /users/:id/posts` → `get_users__id_posts`
 * - `GET /files/*path` → `get_files__path`
 * - `GET /` → `get_`
 *
 * A collision (same method, same alphanumeric skeleton — e.g. `/a-b` and
 * `/a_b`) gets `_2`, `_3`, … appended in registration order, so names
 * stay unique and deterministic.
 */
function toolSlug(method: string, pattern: string): string {
  const body = pattern.replace(/^\//, '').replace(/[^A-Za-z0-9]/g, '_');
  return `${method.toLowerCase()}_${body}`;
}

/** The tool description: summary and long text joined by a blank line,
 * falling back to `METHOD /pattern` for unannotated routes. */
function descriptionOf(meta: RouteMeta | undefined, route: Route): { description?: string } {
  const text =
    meta === undefined
      ? `${route.method} ${route.pattern}`
      : [meta.summary, meta.description]
          .filter((part): part is string => part !== undefined && part !== '')
          .join('\n\n');
  return text === '' ? {} : { description: text };
}

/**
 * One route's tool input schema — one flat object, three sources merged
 * in a fixed order (later groups overwrite same-named earlier
 * properties, so keep argument names unique across them):
 *
 * 1. path params — `{ type: 'string' }`, required unless `:param?`;
 *    wildcards are always required.
 * 2. query params from the annotation — optional unless the entry uses
 *    the marker form (`{ schema, required: true }`): the same flag
 *    `openapiSpec` emits as `parameters[].required` and
 *    `withRouteValidation` enforces with a 422, listed here under
 *    `required` so tool callers send it.
 * 3. the body annotation — an object schema flattens its `properties`
 *    and `required` into the top level; any other shape nests under a
 *    required `body` key. A multipart `{ form: … }` annotation nests the
 *    same way (JSON-RPC arguments are JSON, not file parts — the form
 *    keeps its shape, file parts as binary strings, and the invocation
 *    rides as JSON; the route answers with its real status).
 *
 * `required` is deduplicated in first-seen order (path params before
 * query names before body names): a name declared by both — `PUT
 * /users/:id` whose body also requires `id` — appears once, since JSON
 * Schema requires `required` entries to be unique.
 */
function toolInputSchema(route: Route, meta: RouteMeta | undefined): McpTool['inputSchema'] {
  const properties: Record<string, JsonSchema> = {};
  // Insertion-ordered: path params first, then the body's names. A `Set`
  // keeps each name once — `required` is a JSON Schema array with
  // `uniqueItems`, so a body property that repeats a path parameter's
  // name must not appear twice.
  const required = new Set<string>();
  for (const segment of route.segments) {
    if (segment._tag === 'static') continue;
    properties[segment.name] = { type: 'string' };
    if (paramRequired(segment)) required.add(segment.name);
  }
  if (meta?.query !== undefined) {
    // `required` (the Set) shadows nothing here: the walk's flag is
    // destructured under its own name.
    for (const { name, schema, required: isRequired } of queryEntries(meta.query)) {
      properties[name] = toJsonSchema(schema);
      if (isRequired) required.add(name);
    }
  }
  const body = meta?.body;
  if (isMultipartBody(body)) {
    // A multipart form cannot flatten: JSON-RPC arguments are JSON, not
    // file parts, so the form degrades to one required `body` argument
    // carrying the form's shape (file parts as binary strings). The
    // invocation is sent as JSON and the route answers with its real
    // status (a multipart runtime reports the 415) — the honest degrade.
    properties.body = multipartFormSchema(body.form);
    required.add('body');
  } else if (body?.type === 'object') {
    for (const [name, schema] of Object.entries(body.properties)) {
      properties[name] = toJsonSchema(schema);
    }
    for (const name of body.required ?? []) required.add(name);
  } else if (body !== undefined) {
    properties.body = toJsonSchema(body);
    required.add('body');
  }
  return required.size > 0
    ? { type: 'object', properties, required: [...required] }
    : { type: 'object', properties };
}

/**
 * The one walk behind both exports: routes → tools plus the name → route
 * reverse map `tools/call` resolves through. Rebuilt per use (cheap — a
 * few dozen routes), so routes registered after the handler's creation
 * are still served; the two views share the walk, so they can never
 * drift.
 */
function compileTools(
  app: App,
  options: McpOptions
): { readonly tools: McpTool[]; readonly routes: ReadonlyMap<string, Route> } {
  const tools: McpTool[] = [];
  const routes = new Map<string, Route>();
  for (const route of app.routes) {
    const meta = getRouteMeta(route);
    if (meta === undefined && options.includeUnannotated !== true) continue;
    const name = uniqueName(toolSlug(route.method, route.pattern), routes);
    routes.set(name, route);
    tools.push({ name, ...descriptionOf(meta, route), inputSchema: toolInputSchema(route, meta) });
  }
  return { tools, routes };
}

/**
 * Compiles the app's route table into MCP tool definitions — the same
 * "app is data" payoff as `s200/openapi`, for LLM clients instead of API
 * docs. Only `describeRoute`-annotated routes become tools by default;
 * pass `{ includeUnannotated: true }` to expose the rest (their
 * description falls back to `METHOD /pattern`). The result is plain
 * JSON-compatible data — hand it to `@modelcontextprotocol/sdk` when the
 * stateless handler below is not enough.
 */
export function toolManifest(app: App, options: McpOptions = {}): McpToolManifest {
  return { tools: compileTools(app, options).tools };
}

/**
 * The JSON body a tool call sends: an object-typed body annotation picks
 * its own keys back out of the flattened arguments; any other shape
 * reads the whole `body` argument. A multipart annotation reads the
 * whole `body` argument too — its fields ride as JSON (the honest
 * degrade; see `toolInputSchema`).
 */
function bodyOf(
  declared: SerializeSchema | MultipartBody | undefined,
  args: Record<string, unknown>
): unknown {
  if (declared === undefined || isMultipartBody(declared) || declared.type !== 'object') {
    return args.body;
  }
  const body: Record<string, unknown> = {};
  for (const key of Object.keys(declared.properties)) {
    if (args[key] !== undefined) body[key] = args[key];
  }
  return body;
}

/**
 * Builds the HTTP request one tool call stands for, or `undefined` when
 * a required path argument is missing (`-32602`). The shared pattern
 * fill (`pattern-fill`) encodes each capture per segment — wildcards
 * piecewise, so a multi-segment capture like `'a/b'` builds
 * `/files/a/b`, the canonical browser-shaped URL (the router decodes
 * both that and the old packed `/files/a%2Fb` to the same capture).
 * Declared query names are collected into the query string (arrays
 * repeat the key, `null`/absent skip); the body annotation's keys ride
 * as JSON whenever the method may carry one — GET/HEAD never do, and
 * `ALL` routes are invoked as GET.
 */
function invocationRequest(
  route: Route,
  meta: RouteMeta | undefined,
  args: Record<string, unknown>
): Request | undefined {
  const filled = fillSegments(route.segments, (name) => {
    const value = args[name];
    return value === undefined || value === null ? undefined : String(value);
  });
  if (filled === undefined) {
    return undefined;
  }
  const search = new URLSearchParams();
  if (meta?.query !== undefined) {
    appendQuery(
      search,
      Object.keys(meta.query).map((name) => [name, args[name]] as const),
      { skipNull: true }
    );
  }
  const method = route.method === 'ALL' ? 'GET' : route.method;
  // The root pattern (`[]`) fills to '' — its request still names the
  // root path.
  const path = filled === '' ? '/' : filled;
  const qs = search.toString();
  const url = qs === '' ? `http://localhost${path}` : `http://localhost${path}?${qs}`;
  const headers = new Headers();
  let body: string | undefined;
  if (meta?.body !== undefined && method !== 'GET' && method !== 'HEAD') {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(bodyOf(meta.body, args));
  }
  return new Request(url, body === undefined ? { method, headers } : { method, headers, body });
}

/** One JSON-RPC reply envelope: `application/json`, HTTP 200 unless the
 * caller says otherwise (malformed envelopes also report 400). */
function rpcReply(id: unknown, body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, ...body }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** One JSON-RPC success reply — always `200`, `application/json`. */
function rpcResult(id: unknown, result: unknown): Response {
  return rpcReply(id, { result });
}

/** One JSON-RPC error reply. `status` stays 200 for RPC-level errors;
 * malformed envelopes (parse/invalid request) report HTTP 400 as well. */
function rpcError(id: unknown, code: number, message: string, status = 200): Response {
  return rpcReply(id, { error: { code, message } }, status);
}

/**
 * The minimal MCP server as one function: `(request) => Promise<Response>`,
 * ready to mount behind any route (`post(app, '/mcp', (ctx) =>
 * mcpHandler(ctx.req))`).
 *
 * POST-only (anything else answers `405`); stateless JSON mode — one
 * `application/json` reply per request, `202` with no body for
 * notifications, no SSE stream and no `Mcp-Session-Id`, whatever the
 * `Accept` header offers. The JSON-RPC surface:
 *
 * - `initialize` — negotiates {@link SUPPORTED_PROTOCOL_VERSIONS}: a
 *   supported requested version is echoed, anything else gets our
 *   latest; `capabilities: { tools: {} }` and `serverInfo` ride along.
 * - `tools/list` — {@link toolManifest}'s tools, no pagination.
 * - `tools/call` — resolves the tool name against the manifest, rebuilds
 *   the route's request (path/query/body from the flattened arguments),
 *   and runs it through `handle`, so every middleware still applies. The
 *   reply is `{ content: [{ type: 'text', text }], isError: status >= 400 }`.
 *
 * Errors: unknown method → `-32601`; unknown tool name or bad/missing
 * arguments → `-32602`; unreadable body → `-32700`; a batch array or
 * non-object envelope → `-32600` (batching left the spec in
 * `2025-06-18`); a thrown handler → `-32603`.
 */
export function createMcpHandler(
  app: App,
  options: McpHandlerOptions = {}
): (request: Request) => Promise<Response> {
  const appMeta = getAppMeta(app);
  const serverInfo = options.serverInfo ?? {
    name: appMeta?.title ?? 's200',
    version: appMeta?.version ?? '1.0.0',
  };
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
    }
    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      return rpcError(null, PARSE_ERROR, 'Parse error', 400);
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return rpcError(
        null,
        INVALID_REQUEST,
        'Expected a single JSON-RPC request object',
        400
      );
    }
    const message = parsed as Record<string, unknown>;
    if (Array.isArray(message)) {
      return rpcError(
        null,
        INVALID_REQUEST,
        'Batch requests are not supported (removed in protocol revision 2025-06-18)',
        400
      );
    }
    // JSON-RPC notifications (no id) get no protocol answer.
    if (message.id === undefined) {
      return new Response(null, { status: 202 });
    }
    const { id } = message;
    if (typeof message.method !== 'string') {
      return rpcError(id, INVALID_REQUEST, 'Invalid request: method must be a string', 400);
    }
    const params = (message.params ?? {}) as Record<string, unknown>;
    switch (message.method) {
      case 'initialize': {
        const requested = params.protocolVersion;
        const protocolVersion =
          typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : LATEST_PROTOCOL_VERSION;
        return rpcResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo });
      }
      case 'tools/list':
        return rpcResult(id, { tools: compileTools(app, options).tools });
      case 'tools/call': {
        if (typeof params.name !== 'string') {
          return rpcError(id, INVALID_PARAMS, 'Invalid params: tools/call needs params.name');
        }
        const rawArguments = params.arguments;
        if (
          rawArguments !== undefined &&
          (typeof rawArguments !== 'object' || rawArguments === null || Array.isArray(rawArguments))
        ) {
          return rpcError(id, INVALID_PARAMS, 'Invalid params: params.arguments must be an object');
        }
        const args = (rawArguments ?? {}) as Record<string, unknown>;
        const { routes } = compileTools(app, options);
        const route = routes.get(params.name);
        if (route === undefined) {
          return rpcError(id, INVALID_PARAMS, `Unknown tool: ${params.name}`);
        }
        const invocation = invocationRequest(route, getRouteMeta(route), args);
        if (invocation === undefined) {
          return rpcError(
            id,
            INVALID_PARAMS,
            `Invalid params: ${params.name} is missing a required path argument`
          );
        }
        let response: Response;
        try {
          response = await handle(app, invocation);
        } catch {
          return rpcError(id, INTERNAL_ERROR, 'Internal error');
        }
        const text = await response.text();
        return rpcResult(id, {
          content: [{ type: 'text', text }],
          isError: response.status >= 400,
        });
      }
      default:
        return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${message.method}`);
    }
  };
}
