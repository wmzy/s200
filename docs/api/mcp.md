# MCP (`s200/mcp`)

The route table is the API surface, so it is also the **tool list**: the same `describeRoute` annotations that drive [`s200/openapi`](/api/openapi) drive an MCP (Model Context Protocol) server — zero dependencies, zero sessions, one function per concern. `toolManifest` compiles the routes into MCP tool definitions, `createMcpHandler` answers the JSON-RPC surface an MCP client speaks, and every `tools/call` round-trips through `handle`, so the app's full middleware chain (auth, rate limits, validation gates) still runs per tool invocation. None of the mainstream frameworks ships a first-class MCP surface; for s200 it falls out of the data.

## The manifest (`toolManifest`)

```ts
import { toolManifest } from 's200/mcp';
const { tools } = toolManifest(app);
// { tools: [{
//     name: 'get_users__id',
//     description: 'Fetch one user\n\nReturns the user by id.',
//     inputSchema: { type: 'object', properties: { id: { type: 'string' }, … }, required: ['id'] },
//   }, …] }
```

`toolManifest(app, options?)` → `McpToolManifest` (`{ tools: readonly McpTool[] }`, JSON-compatible by construction — `McpTool` is `{ name, description?, inputSchema }`). Only `describeRoute`-annotated routes become tools by default; `options.includeUnannotated: true` adds the rest, their `description` falling back to `METHOD /pattern`. The `description` joins `meta.summary` and `meta.description` with a blank line.

**Tool names** — lowercased method, `_`, then the pattern with its leading `/` dropped and every character outside `[A-Za-z0-9]` mapped one-to-one to `_` (no collapsing — distinct shapes stay distinct):

| Route | Tool name |
| --- | --- |
| `GET /users` | `get_users` |
| `GET /users/:id` | `get_users__id` |
| `GET /users/:id/posts` | `get_users__id_posts` |
| `GET /files/*path` | `get_files__path` |
| `GET /` | `get_` |

A collision (same method and alphanumeric skeleton — e.g. `/a-b` vs `/a_b`) gets `_2`, `_3`, … appended in registration order, so names stay unique and deterministic.

**Input schema** — one flat object, three sources merged in a fixed order (later groups overwrite same-named earlier properties, so keep argument names unique across them):

1. **Path params** — `{ type: 'string' }`, required unless `:param?`; wildcards always required.
2. **Query params** (`meta.query`) — optional: a query param is never required at the HTTP layer, and `RouteMeta` declares no per-query required flag.
3. **Body** (`meta.body`) — an object schema flattens its `properties` and `required` into the top level; any other shape nests under a required `body` key.

Schemas convert through `toJsonSchema` (`s200/serialize`) — the same pass-through the OpenAPI emitter uses, covering exactly what the `SerializeSchema` DSL carries (`type`, `properties`/`required`, `items`, `nullable`).

## The handler (`createMcpHandler`)

```ts
import { createMcpHandler } from 's200/mcp';
const mcpHandler = createMcpHandler(app, { serverInfo: { name: 'Users API', version: '1.0.0' } });
post(app, '/mcp', (ctx) => mcpHandler(ctx.req));   // mount it like any route
```

`createMcpHandler(app, options?)` → `(request: Request) => Promise<Response>` — POST-only (anything else answers `405` with `Allow: POST`), the minimal stateless server. `options.serverInfo` defaults to `describeApp`'s `title`/`version`, then `'s200'`/`'1.0.0'`; `options.includeUnannotated` feeds `toolManifest`.

The JSON-RPC surface:

| Method | Reply |
| --- | --- |
| `initialize` | Echoes the client's `protocolVersion` when it is one of the supported revisions, otherwise answers with the latest; `capabilities: { tools: {} }` and `serverInfo` ride along |
| `tools/list` | The manifest's `tools`, no pagination |
| `tools/call` | Resolves `params.name` against the manifest, rebuilds the route's request — path filled from arguments (percent-encoded per segment), declared query names collected into the query string (arrays repeat the key), the body annotation's keys picked back out of the flattened arguments and sent as JSON — then runs it through `handle`. The reply is `{ content: [{ type: 'text', text }], isError: status >= 400 }` |
| notifications (no `id`) | `202 Accepted`, empty body |
| anything else | `-32601` Method not found |

Errors: unreadable body → `-32700`; a batch array or non-object envelope → `-32600` (batching left the spec in revision `2025-06-18`); unknown tool name or bad/missing arguments → `-32602`; a thrown handler → `-32603`. Malformed envelopes (`-32700`/`-32600`) also report HTTP `400`; RPC-level errors ride a `200` — clients read the body, which is always one `application/json` JSON-RPC object.

On the wire, `tools/call` means: `get_users__id` with `{ "id": "7" }` becomes `GET /users/7` against the app itself; `post_users` with `{ "name": "ada" }` becomes `POST /users` with `{"name":"ada"}`. `ALL` routes are invoked as `GET` (and never carry a body — GET/HEAD cannot); the tool name for them starts `all_`.

## Stateless by design

The Streamable HTTP transport allows a plain-JSON subset, and that is what ships: every POST gets exactly one `application/json` reply regardless of the `Accept` header — no SSE stream is ever opened, no `Mcp-Session-Id` is issued, and `GET`/`DELETE` on the endpoint answer `405`. The negotiated revisions are `2025-06-18`, `2025-03-26`, and `2024-11-05` (newer clients fall back to `2025-06-18`, the spec's disconnect-if-unacceptable rule); the post-handshake `MCP-Protocol-Version` header is not enforced — there is no session state to protect. The manifest is rebuilt per request, so routes registered after the handler's creation are served too.

## Beyond the stateless subset

The manifest is plain data, which is the escape hatch: feed `toolManifest(app).tools` into `@modelcontextprotocol/sdk`'s `McpServer` (registering each tool's `inputSchema` and forwarding calls through `handle` yourself) when you need sessions, SSE streaming, progress notifications, or OAuth — s200 stays the source of truth for the tool list either way.
