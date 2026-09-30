import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, it } from 'vitest';

import { all, createApp, get, post, put } from '../src/app';
import { readJson } from '../src/body';
import { generateClient } from '../src/codegen';
import { serve } from '../src/node';
import { json, text } from '../src/respond';

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

describe('generateClient (emitted source)', () => {
  it('synthesizes camelCase names from method + segments, collision-suffixed in registration order', () => {
    const source = generateClient(representativeApp());

    source.should.contain('getHealthz: (init?: ClientInit): Promise<Response> =>');
    source.should.contain('getApiV1Users: (init?: ClientInit): Promise<Response> =>');
    source.should.contain('getUserList: (init?: ClientInit): Promise<Response> =>');
    source.should.contain(
      "getUsersId: (args: ParamsOf<'/users/:id'>, init?: ClientInit): Promise<Response> =>"
    );
    // The later /users/id registration collides and takes the _2 suffix;
    // being static it takes no args.
    source.should.contain('getUsersId_2: (init?: ClientInit): Promise<Response> =>');
    source.should.contain(
      "getFilesPath: (args: ParamsOf<'/files/*path'>, init?: ClientInit): Promise<Response> =>"
    );
    source.should.contain('postEcho: (init?: ClientInit): Promise<Response> =>');
    // A different method prefix never collides with the GET twin.
    source.should.contain(
      "putUsersId: (args: ParamsOf<'/users/:id'>, init?: ClientInit): Promise<Response> =>"
    );

    source.indexOf('getHealthz').should.be.lessThan(source.indexOf('getApiV1Users'));
    source.indexOf('getUsersId:').should.be.lessThan(source.indexOf('getUsersId_2'));
    // The last emitted method still precedes the trailing ALL-route comment.
    source.indexOf('putUsersId').should.be.lessThan(source.indexOf('//   ALL /admin/*rest'));
  });

  it('emits the s200 types-only import, the local fill helper and baked methods', () => {
    const source = generateClient(representativeApp());

    source.should.contain("import type { ParamsOf } from 's200';");
    // The helper is emitted exactly once.
    source.match(/function fill\(/g)?.should.have.length(1);
    source.should.contain("fill('/users/:id', args, base, init?.query)");
    source.should.contain("fill('/users/id', undefined, base, init?.query)");
    source.should.contain("fill('/echo', undefined, base, init?.query)");
    // The method is the route's, never the caller's job.
    source.should.contain("{ ...init, method: 'GET' }");
    source.should.contain("{ ...init, method: 'POST' }");
    source.should.contain("{ ...init, method: 'PUT' }");
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
    source.should.contain('http(fill(');
    source.should.not.contain('fetcher(');
  });

  it('rejects names that are not valid identifiers', () => {
    (() => generateClient(createApp(), { name: 'not-a-name' })).should.throw(/identifier/);
    (() => generateClient(createApp(), { fetcherName: '9http' })).should.throw(/identifier/);
  });

  it('is deterministic across calls', () => {
    generateClient(representativeApp()).should.equal(generateClient(representativeApp()));
  });

  it('emits a valid empty module for an app with no routes', () => {
    const source = generateClient(createApp());

    source.should.contain('export function fill(');
    source.should.contain('return Object.freeze({});');
    source.should.not.contain('ParamsOf<');
    // No method lines at all — nothing to call.
    source.should.not.contain(': (init?: ClientInit)');
  });

  it('states the untyped-body contract in the header', () => {
    const source = generateClient(createApp());

    source.should.contain('Promise<Response>');
    source.should.contain("from 's200/client'");
  });
});

describeExecuted('generateClient (executed module)', () => {
  it('drives a served app: params echo, query sugar lands, POST body round-trips', async () => {
    const app = createApp();
    get(app, '/users/:id', (ctx) => json(ctx, { id: ctx.params.id }));
    get(app, '/posts/:postId?', (ctx) => json(ctx, { id: ctx.params.postId ?? null }));
    get(app, '/search', (ctx) =>
      json(ctx, { q: ctx.query.get('q'), tags: ctx.query.getAll('tag') })
    );
    get(app, '/files/*path', (ctx) => text(ctx, ctx.params.path));
    post(app, '/echo', async (ctx) => json(ctx, await readJson<{ hello: string }>(ctx)));

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
          postEcho: (init?: RequestInit) => Promise<Response>;
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

      // POST: the method is baked in; the body round-trips via readJson.
      const echo = await client.postEcho({
        body: JSON.stringify({ hello: 'world' }),
        headers: { 'content-type': 'application/json' },
      });
      echo.status.should.equal(200);
      (await echo.json()).should.deep.equal({ hello: 'world' });
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
