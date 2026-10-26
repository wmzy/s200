# Your route table is already an MCP server

MCP became the de facto standard for LLM integration this year — the
TypeScript SDK hit v2 stable, and framework round-ups already list MCP
support as a comparison dimension. The usual answer is a bolt-on server
package: you re-describe every endpoint a second time, as tools, and keep
the two descriptions in sync by discipline. s200's answer is smaller: the
`describeRoute` annotations you wrote for [OpenAPI](/api/openapi) are the
tool list. One batch of data, read twice — no extra annotations, no
sessions, no dependencies. This piece walks the whole path: what flows
out, how a tool call becomes a real request, and where the stateless
design deliberately stops.

## The annotations you already wrote

Everything downstream starts here — a route table plus metadata, all
plain data, no decorator and no code generation:

```ts
import { createApp, get, post } from 's200';
import { describeApp, describeRoute } from 's200/meta';

const app = createApp();

get(app, '/users/:id', (ctx) => { /* … */ });
post(app, '/users', (ctx) => { /* … */ });

describeApp(app, { title: 'Users API', version: '1.0.0' });
describeRoute(app, 'GET', '/users/:id', {
  summary: 'Fetch one user',
  description: 'Returns the user by id.',
  query: { verbose: { schema: { type: 'boolean' } } },
  responses: {
    200: {
      description: 'ok',
      schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    },
  },
});
describeRoute(app, 'POST', '/users', {
  summary: 'Create a user',
  body: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  responses: { 201: { description: 'created' } },
});
```

`s200/openapi` turns exactly this into an OpenAPI 3.1 document — `openapiSpec(app)` walks the route table, converts the `SerializeSchema` DSL to JSON Schema, dedups repeated shapes into `components.schemas`. That emitter is the reference point for everything below, because `s200/mcp` runs the same walk and the same conversion.

## The same data, read as tools

```ts
import { toolManifest } from 's200/mcp';
const { tools } = toolManifest(app);
// { tools: [{
//     name: 'get_users__id',
//     description: 'Fetch one user\n\nReturns the user by id.',
//     inputSchema: { type: 'object', properties: { id: { type: 'string' }, verbose: { type: 'boolean' } },
//                    required: ['id'] },
//   }, {
//     name: 'post_users',
//     description: 'Create a user',
//     inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
//   }] }
```

Each annotated route becomes one tool. The slug is mechanical:
lowercased method, `_`, then the pattern with every character outside
`[A-Za-z0-9]` mapped one-to-one to `_` — `GET /users/:id` becomes
`get_users__id`, `GET /files/*path` becomes `get_files__path`. No
collapsing, so distinct shapes stay distinct; a genuine collision (same
method and alphanumeric skeleton, e.g. `/a-b` vs `/a_b`) gets `_2`,
`_3`, … in registration order. Unannotated routes are skipped by
default — the annotation is the contract, so opting in is per-route;
`{ includeUnannotated: true }` exposes the rest, their description
falling back to `METHOD /pattern`.

The input schema is one flat object merged from three sources in a
fixed order:

1. **Path params** — `{ type: 'string' }`, required unless the segment
   is `:param?`; wildcards are always required.
2. **Query params** — from the annotation; optional by default, but the
   `{ schema, required: true }` marker form lists the name under
   `required`. That marker is one flag with three synchronized views:
   `openapiSpec` emits `parameters[].required: true`, the validation
   gate answers a missing key with a 422, and the tool schema makes the
   argument mandatory. A tool caller cannot be told the route demands
   something the spec does not.
3. **Body** — an object schema flattens its `properties` and `required`
   into the top level; any other shape nests under a required `body`
   key. A multipart `{ form: … }` annotation nests that way too —
   JSON-RPC arguments are JSON, not file parts, so the form degrades to
   one `body` argument carrying its shape.

Schemas convert through `toJsonSchema` (`s200/serialize`) — the same
pass-through the OpenAPI emitter uses. That is the whole relationship
between the two batteries: not shared code bolted onto two formats, but
one annotation store read by two consumers. Docs and tools cannot drift,
because neither has a description of its own.

## Mounting the server

```ts
import { post } from 's200';
import { createMcpHandler } from 's200/mcp';

const mcpHandler = createMcpHandler(app, {
  serverInfo: { name: 'Users API', version: '1.0.0' },
});
post(app, '/mcp', (ctx) => mcpHandler(ctx.req));
```

That is the entire server. `createMcpHandler` returns
`(request: Request) => Promise<Response>` — a function you mount behind
any POST route, guarded by whatever middleware wraps it. The JSON-RPC
surface it answers:

| Method | Reply |
| --- | --- |
| `initialize` | Echoes the client's `protocolVersion` when it is one of the supported revisions, otherwise answers with the latest; `capabilities: { tools: {} }` and `serverInfo` ride along |
| `tools/list` | The manifest's `tools`, no pagination |
| `tools/call` | Resolves `params.name`, rebuilds the route's request, and runs it through `handle` — see below |
| notifications (no `id`) | `202 Accepted`, empty body |
| anything else | `-32601` Method not found |

`serverInfo` defaults to `describeApp`'s `title`/`version` — the app's
own metadata, read a third time — then to `'s200'`/`'1.0.0'`. The
negotiated protocol revisions are `2025-06-18`, `2025-03-26`, and
`2024-11-05`; a newer client gets `2025-06-18` back and disconnects if
it cannot accept it, which is the spec's own negotiation rule.

## Every tool call is a real request

The part worth understanding is `tools/call`. The handler resolves the
tool name against the manifest, rebuilds the HTTP request the call
stands for — path filled from the arguments (percent-encoded per
segment), declared query names collected into the query string (arrays
repeat the key), the body annotation's keys picked back out of the
flattened arguments and sent as JSON — and runs it through `handle`,
the app's own dispatch contract.

On the wire, `get_users__id` with `{ "id": "7" }` becomes
`GET /users/7` against the app itself; `post_users` with
`{ "name": "ada" }` becomes `POST /users` with `{"name":"ada"}`. And
because it is the app that answers, **the full middleware chain still
runs per tool invocation** — auth, rate limits, validation gates. An
MCP client is just another client with worse intentions than your
average browser: it gets no bypass, and it gets your 401s and 429s as
honestly as curl does. The reply shape is MCP's standard envelope:
`{ content: [{ type: 'text', text }], isError: status >= 400 }`.

Errors map cleanly onto JSON-RPC: an unreadable body is `-32700`; a
batch array or non-object envelope is `-32600` (batching left the spec
in revision `2025-06-18`); an unknown tool name or missing required
argument is `-32602`; a thrown handler is `-32603`.

## Stateless, and what that buys

The Streamable HTTP transport allows a plain-JSON subset, and that is
what ships: every POST gets exactly one `application/json` reply
regardless of the `Accept` header — no SSE stream is ever opened, no
`Mcp-Session-Id` is issued, and GET/DELETE on the endpoint answer 405.
There is no session state to protect, so the post-handshake
`MCP-Protocol-Version` header is not enforced either.

Statelessness has two practical payoffs. First, the manifest is rebuilt
per request (the walk is cheap — a few dozen routes), so routes
registered after the handler's creation are served too; you never ship
a stale tool list. Second, there is nothing to break under a restart or
a load balancer — any instance answers any call.

When the stateless subset is not enough, the manifest is plain data,
which is the escape hatch: feed `toolManifest(app).tools` into
`@modelcontextprotocol/sdk`'s `McpServer`, registering each tool's
`inputSchema` and forwarding calls through `handle` yourself, when you
need sessions, SSE streaming, progress notifications, or OAuth. s200
stays the source of truth for the tool list either way — the SDK build
starts from the same annotations, not from a second description.

That is the whole story: none of the mainstream frameworks ships a
first-class MCP surface today, and the reason s200 does is not that it
worked harder at MCP — it never had to describe the API twice. The
route table was already there; the annotations were already there; the
tool list is just what they look like from the side. Full surface in
the [MCP API reference](/api/mcp); the annotation store itself in
[OpenAPI & tooling](/api/openapi).
