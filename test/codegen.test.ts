import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { promisify } from 'node:util';

import { describe, it } from 'vitest';

import { all, createApp, get, post, put } from '../src/app';
import { generateClient } from '../src/codegen';
import { throws } from '../src/errors';
import { describeRoute } from '../src/meta';
import { serve } from '../src/node';
import { json } from '../src/respond';
import { readJson } from '../src/body';

const run = promisify(execFile);

// Node >= 22.6 can type-strip .mts natively; older runtimes cannot import
// the generated module, so the execution half below skips with a note and
// the string-shape assertions above still run.
const stripTypes = (process.features as { typescript?: string | boolean }).typescript;
if (!stripTypes) {
  console.log(
    '[codegen.test] process.features.typescript unavailable on this runtime —' +
      ' skipping generated-module execution (string assertions still run)'
  );
}

const describeExecuted = stripTypes ? describe : describe.skip;

function representativeApp() {
  const app = createApp();
  get(app, '/healthz', () => new Response('ok'));
  get(app, '/api/v1/users', () => new Response('[]'));
  get(app, '/user-list', () => new Response('[]'));
  get(app, '/users/:id', (ctx) => new Response(ctx.params.id));
  // Collides with getUsersId above (static segment spells the same name).
  get(app, '/users/id', () => new Response('static'));
  get(app, '/files/*path', (ctx) => new Response(ctx.params.path));
  post(app, '/echo', () => new Response('ok'));
  put(app, '/users/:id', (ctx) => new Response(ctx.params.id));
  all(app, '/admin/*rest', () => new Response('any'));
  return app;
}

/** The typed fixture: query + responses + a throws gate on one route, a
 * declared body + record-form throws on another, one loose route. */
function typedApp() {
  const app = createApp();
  const users = get(
    app,
    '/users/:id',
    throws(404),
    (ctx) => json(ctx, { id: Number(ctx.params.id), name: 'ada' })
  );
  describeRoute(users, 'GET', '/users/:id', {
    summary: 'Fetch one user',
    query: {
      format: { schema: { type: 'string' }, required: true },
      verbose: { type: 'boolean' },
    },
    responses: {
      200: {
        description: 'ok',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            name: { type: 'string' },
            nickname: { type: 'string', nullable: true },
          },
          required: ['id', 'name'],
        },
      },
    },
  });
  const things = post(app, '/things', throws({ 422: { issues: ['x'] } }), () =>
    new Response('ok')
  );
  describeRoute(things, 'POST', '/things', {
    body: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    responses: {
      201: {
        description: 'created',
        schema: {
          type: 'object',
          properties: { id: { type: 'integer' } },
          required: ['id'],
        },
      },
    },
  });
  get(app, '/plain', () => new Response('ok'));
  return app;
}

describe('generateClient (emitted source)', () => {
  it('synthesizes camelCase names from method + segments, collision-suffixed in registration order', () => {
    const source = generateClient(representativeApp());

    source.should.contain('getHealthz: (init?: ClientInit): Promise<Response> =>');
    source.should.contain('getApiV1Users: (init?: ClientInit): Promise<Response> =>');
    source.should.contain('getUserList: (init?: ClientInit): Promise<Response> =>');
    source.should.contain(
      'getUsersId: (args: { id: string }, init?: ClientInit): Promise<Response> =>'
    );
    // The later /users/id registration collides and takes the _2 suffix;
    // being static it takes no args.
    source.should.contain('getUsersId_2: (init?: ClientInit): Promise<Response> =>');
    source.should.contain(
      'getFilesPath: (args: { path: string }, init?: ClientInit): Promise<Response> =>'
    );
    source.should.contain('postEcho: (init?: ClientInit): Promise<Response> =>');
    // A different method prefix never collides with the GET twin.
    source.should.contain(
      'putUsersId: (args: { id: string }, init?: ClientInit): Promise<Response> =>'
    );

    source.indexOf('getHealthz').should.be.lessThan(source.indexOf('getApiV1Users'));
    source.indexOf('getUsersId:').should.be.lessThan(source.indexOf('getUsersId_2'));
    // The last emitted method still precedes the trailing ALL-route comment.
    source.indexOf('putUsersId').should.be.lessThan(source.indexOf('//   ALL /admin/*rest'));
  });

  it('emits no s200 imports, the local fill/send helpers and baked methods', () => {
    const source = generateClient(representativeApp());

    source.should.not.contain("from 's200'");
    source.should.not.contain('ParamsOf');
    // Each helper is emitted exactly once.
    source.match(/function fill\(/g)?.should.have.length(1);
    source.match(/function send\(/g)?.should.have.length(1);
    source.should.contain("fill('/users/:id', args, base, init?.query)");
    source.should.contain("fill('/users/id', undefined, base, init?.query)");
    source.should.contain("fill('/echo', undefined, base, init?.query)");
    // Every call routes through send; the method is the route's, never the
    // caller's.
    source.should.contain("send(fetcher, fill('/echo', undefined, base, init?.query), init, 'POST')");
    source.should.contain("'GET'");
    source.should.contain("'PUT'");
    source.should.contain('export function createClient(baseUrl: string, fetcher: typeof fetch = fetch)');
    source.should.contain('return Object.freeze({');
  });

  it('skips ALL routes and lists them in a trailing comment', () => {
    const source = generateClient(representativeApp());

    source.should.not.contain('getAllAdminRest');
    source.should.contain('//   ALL /admin/*rest');
    // The listing trails the emitted factory, as documentation.
    source.indexOf('//   ALL /admin/*rest').should.be.greaterThan(
      source.indexOf('export function createClient')
    );
  });

  it('bakes options: factory name, baseUrl default, fetcher param name', () => {
    const app = createApp();
    get(app, '/x', () => new Response('x'));
    const source = generateClient(app, {
      name: 'makeApi',
      baseUrl: 'http://api.local:8080/',
      fetcherName: 'http',
    });

    source.should.contain(
      "export function makeApi(baseUrl: string = 'http://api.local:8080/', http: typeof fetch = fetch)"
    );
    source.should.contain('send(http, fill(');
    // The baked name is the only fetcher reference in method bodies; the
    // send helper's own parameter stays generically named.
    source.should.not.contain('send(fetcher,');
  });

  it('rejects names that are not valid identifiers', () => {
    (() => generateClient(createApp(), { name: 'not-a-name' })).should.throw(/identifier/);
    (() => generateClient(createApp(), { fetcherName: '9http' })).should.throw(/identifier/);
  });

  it('is deterministic across calls', () => {
    generateClient(representativeApp()).should.equal(generateClient(representativeApp()));
    generateClient(typedApp()).should.equal(generateClient(typedApp()));
  });

  it('emits a valid empty module for an app with no routes', () => {
    const source = generateClient(createApp());

    source.should.contain('export function fill(');
    source.should.contain('return Object.freeze({});');
    // No method lines, no call plumbing, no types at all — nothing to call.
    source.should.not.contain(': (init?: ClientInit)');
    source.should.not.contain('function send(');
    source.should.not.contain('Branch<');
  });

  it('states the typed-body contract in the header', () => {
    const source = generateClient(createApp());

    source.should.contain('Promise<Response>');
    source.should.contain('compile-time phantoms');
    source.should.contain('types unknown');
  });
});

describe('generateClient (typed emission)', () => {
  it('derives args, init and response types from pattern, meta and throws gates', () => {
    const source = generateClient(typedApp());

    // Pattern-derived args + meta.query narrowing (a `required` marker
    // drops the `?`; bare entries stay optional sugar).
    source.should.contain(
      'getUsersId: (args: { id: string }, init?: GetUsersIdInit): Promise<GetUsersIdResponse> =>'
    );
    source.should.contain(
      'export type GetUsersIdInit = ClientInit & { query?: { format: string; verbose?: boolean } };'
    );
    // meta.responses (required list drives optionality, nullable widens)
    // merged with the throws(404) envelope branch, statuses ascending.
    source.should.contain(
      'export type GetUsersIdResponse =\n' +
        '  | Branch<200, { id: number; name: string; nickname?: string | null }>\n' +
        '  | Branch<404, { error: string }>;'
    );

    // Declared body: init becomes required and its body the schema shape;
    // the record-form throws branch infers { issues: string[] }.
    source.should.contain('postThings: (init: PostThingsInit): Promise<PostThingsResponse> =>');
    source.should.contain(
      "export type PostThingsInit = Omit<ClientInit, 'body'> & { body: { name: string } };"
    );
    source.should.contain(
      'export type PostThingsResponse =\n' +
        '  | Branch<201, { id: number }>\n' +
        '  | Branch<422, { issues: string[] }>;'
    );

    // Untouched route: today's exact loose shape.
    source.should.contain('getPlain: (init?: ClientInit): Promise<Response> =>');
  });

  it('emits the Branch helper only when a route declares responses', () => {
    generateClient(representativeApp()).should.not.contain('Branch<');
    generateClient(createApp()).should.not.contain('type Branch<');
    generateClient(typedApp()).should.contain(
      "type Branch<S extends number, T> = Omit<Response, 'json' | 'status'> & {"
    );
  });

  it('collides type names with the same suffix as method names', () => {
    const app = createApp();
    get(app, '/users/:id', throws(404), () => new Response('u'));
    get(app, '/users/id', throws(404), () => new Response('u'));
    const source = generateClient(app);

    source.should.contain('export type GetUsersIdResponse =');
    source.should.contain('export type GetUsersId_2Response =');
  });

  it('lets meta.responses win a status a throws gate also declares', () => {
    const app = createApp();
    const route = get(app, '/x', throws(404, 429), () => new Response('x'));
    describeRoute(route, 'GET', '/x', {
      responses: { 404: { description: 'missing', schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } } },
    });
    const source = generateClient(app);

    source.should.contain(
      'export type GetXResponse =\n' +
        '  | Branch<404, { code: string }>\n' +
        '  | Branch<429, { error: string }>;'
    );
  });

  it('compiles the generated module with tsc (typed and empty alike)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 's200-codegen-tsc-'));
    try {
      await writeFile(join(dir, 'client.mts'), generateClient(typedApp()), 'utf8');
      await writeFile(join(dir, 'empty.mts'), generateClient(createApp()), 'utf8');
      await writeFile(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'bundler',
            lib: ['ES2022', 'DOM'],
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            types: [],
          },
          files: ['client.mts', 'empty.mts'],
        }),
        'utf8'
      );
      const tsc = join(process.cwd(), 'node_modules', '.bin', 'tsc');
      try {
        await run(tsc, ['-p', join(dir, 'tsconfig.json')]);
      } catch (error) {
        throw new Error(
          `tsc rejected the generated module:\n${String((error as { stderr?: string }).stderr ?? '')}`,
          { cause: error }
        );
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describeExecuted('generateClient (executed module)', () => {
  it('drives a served app: params echo, query sugar lands, typed POST body round-trips', async () => {
    const app = createApp();
    get(app, '/users/:id', (ctx) => json(ctx, { id: ctx.params.id }));
    get(app, '/posts/:postId?', (ctx) => json(ctx, { id: ctx.params.postId ?? null }));
    get(app, '/search', (ctx) =>
      json(ctx, { q: ctx.query.get('q'), tags: ctx.query.getAll('tag') })
    );
    get(app, '/files/*path', (ctx) => new Response(ctx.params.path));
    const echo = post(app, '/echo', async (ctx) =>
      json(ctx, {
        body: await readJson<{ hello: string }>(ctx),
        type: ctx.req.headers.get('content-type') ?? '',
      })
    );
    describeRoute(echo, 'POST', '/echo', {
      body: {
        type: 'object',
        properties: { hello: { type: 'string' } },
        required: ['hello'],
      },
    });

    const source = generateClient(app, { name: 'makeClient' });
    const dir = await mkdtemp(join(tmpdir(), 's200-codegen-'));
    const server = await serve(app, { port: 0 });
    try {
      const file = join(dir, 'client.mts');
      await writeFile(file, source, 'utf8');
      const mod = (await import(pathToFileURL(file).href)) as {
        makeClient: (baseUrl: string, fetcher?: typeof fetch) => {
          getUsersId: (
            args: { id: string },
            init?: RequestInit & {
              query?: Record<
                string,
                string | number | boolean | readonly (string | number | boolean)[] | undefined
              >;
            }
          ) => Promise<Response>;
          getPostsPostId: (args: { postId?: string }) => Promise<Response>;
          getSearch: (
            init?: RequestInit & {
              query?: Record<
                string,
                string | number | boolean | readonly (string | number | boolean)[] | undefined
              >;
            }
          ) => Promise<Response>;
          getFilesPath: (args: { path: string }) => Promise<Response>;
          postEcho: (init: Omit<RequestInit, 'body'> & { body: { hello: string } }) => Promise<Response>;
        };
      };
      const client = mod.makeClient(server.url);

      // Param value with a space survives URL encoding + server decoding.
      const user = await client.getUsersId({ id: 'foo bar' });
      user.status.should.equal(200);
      (await user.json()).should.deep.equal({ id: 'foo bar' });

      // An absent optional segment drops out: the request hits /posts.
      const post = await client.getPostsPostId({});
      post.status.should.equal(200);
      (await post.json()).should.deep.equal({ id: null });

      // Query sugar: arrays repeat the key, undefined skipped, numbers
      // and booleans stringify — mirrored from s200/client.
      const search = await client.getSearch({
        query: { q: 'a b', tag: ['x', 'y'], page: 2, skip: undefined },
      });
      search.status.should.equal(200);
      (await search.json()).should.deep.equal({ q: 'a b', tags: ['x', 'y'] });

      // Wildcard keeps its slashes, each piece encoded.
      const files = await client.getFilesPath({ path: 'a/b c' });
      files.status.should.equal(200);
      (await files.text()).should.equal('a/b c');

      // POST: the method is baked in; a JSON-shape body is stringified
      // with a default content-type (send mirrors s200/client).
      const echoed = await client.postEcho({ body: { hello: 'world' } });
      echoed.status.should.equal(200);
      (await echoed.json()).should.deep.equal({
        body: { hello: 'world' },
        type: 'application/json',
      });
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns a frozen, method-less object for an empty app', async () => {
    const source = generateClient(createApp());
    const dir = await mkdtemp(join(tmpdir(), 's200-codegen-empty-'));
    try {
      const file = join(dir, 'client.mts');
      await writeFile(file, source, 'utf8');
      const mod = (await import(pathToFileURL(file).href)) as {
        createClient: (baseUrl: string, fetcher?: typeof fetch) => Record<string, unknown>;
      };
      const client = mod.createClient('http://x.test');
      Object.isFrozen(client).should.be.true;
      Object.keys(client).should.deep.equal([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
