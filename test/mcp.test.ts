import { describe, it } from 'vitest';

import { createApp, get, handle, post } from '../src/app';
import { httpError } from '../src/errors';
import { describeApp, describeRoute } from '../src/meta';
import { createMcpHandler, toolManifest } from '../src/mcp';
import { json } from '../src/respond';

/** The app under test: annotated CRUD routes plus one bare health check. */
function mcpApp() {
  const app = createApp();
  get(app, '/users', (ctx) => json(ctx, { users: ['ada', 'grace'] }));
  get(app, '/users/:id', (ctx) => {
    if (ctx.params.id === 'missing') throw httpError(404, 'user not found');
    return json(ctx, { id: ctx.params.id, verbose: ctx.query.get('verbose') });
  });
  post(app, '/users', async (ctx) => {
    const body = (await ctx.req.json()) as { name?: string };
    return json(ctx, { created: body.name ?? 'anon' }, { status: 201 });
  });
  describeApp(app, { title: 'Users API', version: '7.2.0' });
  describeRoute(app, 'GET', '/users', {
    summary: 'List users',
  });
  describeRoute(app, 'GET', '/users/:id', {
    summary: 'Fetch one user',
    description: 'Returns the user by id.',
    query: { verbose: { type: 'boolean' } },
  });
  describeRoute(app, 'POST', '/users', {
    summary: 'Create a user',
    body: {
      type: 'object',
      properties: { name: { type: 'string' }, role: { type: 'string', nullable: true } },
      required: ['name'],
    },
  });
  get(app, '/health', (ctx) => json(ctx, { ok: true }));
  return app;
}

/** POSTs one JSON-RPC message through the handler. */
async function call(handler: (request: Request) => Promise<Response>, message: unknown) {
  return handler(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof message === 'string' ? message : JSON.stringify(message),
    })
  );
}

describe('toolManifest', () => {
  it('exposes only annotated routes by default, with slugged names', () => {
    const { tools } = toolManifest(mcpApp());
    tools.map((tool) => tool.name).should.deep.equal(['get_users', 'get_users__id', 'post_users']);
    tools.map((tool) => tool.description).should.deep.equal([
      'List users',
      'Fetch one user\n\nReturns the user by id.',
      'Create a user',
    ]);
  });

  it('includeUnannotated adds bare routes with a METHOD /pattern description', () => {
    const { tools } = toolManifest(mcpApp(), { includeUnannotated: true });
    const health = tools.find((tool) => tool.name === 'get_health');
    (health?.description ?? '').should.equal('GET /health');
  });

  it('merges path, query and body into one inputSchema with required', () => {
    const { tools } = toolManifest(mcpApp());
    const fetchOne = tools.find((tool) => tool.name === 'get_users__id');
    fetchOne?.inputSchema.type.should.equal('object');
    fetchOne?.inputSchema.properties.should.deep.equal({
      id: { type: 'string' },
      verbose: { type: 'boolean' },
    });
    (fetchOne?.inputSchema.required ?? []).should.deep.equal(['id']);

    const create = tools.find((tool) => tool.name === 'post_users');
    create?.inputSchema.properties.should.deep.equal({
      name: { type: 'string' },
      role: { type: ['string', 'null'] },
    });
    (create?.inputSchema.required ?? []).should.deep.equal(['name']);
  });
});

describe('createMcpHandler (JSON-RPC surface)', () => {
  it('answers initialize with an echoed supported version, capabilities and serverInfo', async () => {
    const handler = createMcpHandler(mcpApp());
    const res = await call(handler, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'c', version: '0' } },
    });
    res.status.should.equal(200);
    (res.headers.get('content-type') ?? '').should.equal('application/json');
    const body = (await res.json()) as {
      result: { protocolVersion: string; capabilities: { tools: object }; serverInfo: { name: string; version: string } };
    };
    body.result.protocolVersion.should.equal('2025-03-26');
    body.result.capabilities.should.deep.equal({ tools: {} });
    body.result.serverInfo.should.deep.equal({ name: 'Users API', version: '7.2.0' });
  });

  it('falls back to the latest supported version when the request asks for an unknown one', async () => {
    const handler = createMcpHandler(mcpApp());
    const res = await call(handler, {
      jsonrpc: '2.0',
      id: 'a',
      method: 'initialize',
      params: { protocolVersion: '1999-01-01' },
    });
    const body = (await res.json()) as { result: { protocolVersion: string } };
    body.result.protocolVersion.should.equal('2025-06-18');
  });

  it('honors the serverInfo option over the app meta', async () => {
    const handler = createMcpHandler(mcpApp(), {
      serverInfo: { name: 'custom', version: '9.9.9' },
    });
    const res = await call(handler, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const body = (await res.json()) as { result: { serverInfo: { name: string; version: string } } };
    body.result.serverInfo.should.deep.equal({ name: 'custom', version: '9.9.9' });
  });

  it('answers notifications (no id) with 202 and an empty body', async () => {
    const handler = createMcpHandler(mcpApp());
    const res = await call(handler, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    res.status.should.equal(202);
    (await res.text()).should.equal('');
  });

  it('lists tools with the manifest shape', async () => {
    const handler = createMcpHandler(mcpApp());
    const res = await call(handler, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const body = (await res.json()) as { result: { tools: { name: string }[] } };
    body.result.tools.map((tool) => tool.name).should.deep.equal([
      'get_users',
      'get_users__id',
      'post_users',
    ]);
  });

  it('round-trips a tool call through the real route', async () => {
    const handler = createMcpHandler(mcpApp());
    const res = await call(handler, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'get_users__id', arguments: { id: '7', verbose: 'true' } },
    });
    res.status.should.equal(200);
    const body = (await res.json()) as {
      result: { content: { type: string; text: string }[]; isError: boolean };
    };
    body.result.isError.should.equal(false);
    body.result.content.should.have.length(1);
    body.result.content[0]?.type.should.equal('text');
    JSON.parse(body.result.content[0]?.text ?? '{}').should.deep.equal({ id: '7', verbose: 'true' });
  });

  it('sends the flattened body arguments as JSON and reports the route status', async () => {
    const handler = createMcpHandler(mcpApp());
    const res = await call(handler, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'post_users', arguments: { name: 'ada' } },
    });
    const body = (await res.json()) as { result: { content: { text: string }[]; isError: boolean } };
    body.result.isError.should.equal(false);
    JSON.parse(body.result.content[0]?.text ?? '{}').should.deep.equal({ created: 'ada' });
  });

  it('marks a route-answered 404 as isError', async () => {
    const handler = createMcpHandler(mcpApp());
    const res = await call(handler, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'get_users__id', arguments: { id: 'missing' } },
    });
    const body = (await res.json()) as { result: { content: { text: string }[]; isError: boolean } };
    body.result.isError.should.equal(true);
    JSON.parse(body.result.content[0]?.text ?? '{}').should.deep.equal({ error: 'user not found' });
  });

  it('answers an unknown tool with -32602', async () => {
    const handler = createMcpHandler(mcpApp());
    const res = await call(handler, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'nope', arguments: {} },
    });
    const body = (await res.json()) as { error: { code: number; message: string } };
    body.error.code.should.equal(-32602);
    body.error.message.should.contain('Unknown tool');
  });

  it('answers a missing required path argument with -32602', async () => {
    const handler = createMcpHandler(mcpApp());
    const res = await call(handler, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'get_users__id', arguments: {} },
    });
    const body = (await res.json()) as { error: { code: number } };
    body.error.code.should.equal(-32602);
  });

  it('answers an unknown method with -32601', async () => {
    const handler = createMcpHandler(mcpApp());
    const res = await call(handler, { jsonrpc: '2.0', id: 8, method: 'resources/list' });
    const body = (await res.json()) as { error: { code: number } };
    body.error.code.should.equal(-32601);
  });

  it('answers unreadable JSON with -32700 and a null id', async () => {
    const handler = createMcpHandler(mcpApp());
    const res = await call(handler, '{"jsonrpc":');
    res.status.should.equal(400);
    const body = (await res.json()) as { id: null; error: { code: number } };
    body.should.have.property('id', null);
    body.error.code.should.equal(-32700);
  });

  it('rejects batch arrays with -32600', async () => {
    const handler = createMcpHandler(mcpApp());
    const res = await call(handler, [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
    res.status.should.equal(400);
    const body = (await res.json()) as { error: { code: number; message: string } };
    body.error.code.should.equal(-32600);
    body.error.message.should.contain('2025-06-18');
  });

  it('answers non-POST requests with 405', async () => {
    const handler = createMcpHandler(mcpApp());
    const res = await handler(new Request('http://localhost/mcp', { method: 'GET' }));
    res.status.should.equal(405);
    (res.headers.get('allow') ?? '').should.equal('POST');
  });

  it('serves routes registered after the handler was created', async () => {
    const app = mcpApp();
    const handler = createMcpHandler(app);
    get(app, '/late', (ctx) => json(ctx, { late: true }));
    describeRoute(app, 'GET', '/late', { summary: 'Late route' });
    const res = await call(handler, {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'get_late', arguments: {} },
    });
    const body = (await res.json()) as { result: { content: { text: string }[]; isError: boolean } };
    body.result.isError.should.equal(false);
    JSON.parse(body.result.content[0]?.text ?? '{}').should.deep.equal({ late: true });
  });
});

describe('createMcpHandler (mounted behind a route)', () => {
  it('works wired through post(app, …) with handle', async () => {
    const app = createApp();
    const mcpHandler = createMcpHandler(mcpApp(), { serverInfo: { name: 'inner', version: '1' } });
    post(app, '/mcp', (ctx) => mcpHandler(ctx.req));
    const res = await handle(
      app,
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      })
    );
    res.status.should.equal(200);
    const body = (await res.json()) as { result: { serverInfo: { name: string } } };
    body.result.serverInfo.name.should.equal('inner');
  });
});
