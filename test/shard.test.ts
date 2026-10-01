import type { ShardSpec } from '../src/shard';

import { describe, it } from 'vitest';

import { createApp, get, handle, mount, post, use } from '../src/app';
import { getPolicy, matchShard, policy, shardApp, shardSpecs } from '../src/shard';

function makeRequest(path: string, method = 'GET'): Request {
  return new Request(`http://localhost${path}`, { method });
}

function byId(specs: readonly ShardSpec[], id: string): ShardSpec {
  const spec = specs.find((candidate) => candidate.id === id);
  if (spec === undefined) {
    throw new Error(`missing spec '${id}'`);
  }
  return spec;
}

function patterns(spec: ShardSpec): string[] {
  return spec.routes.map((route) => route.pattern);
}

/** Captures what shardSpecs threw; resolves to undefined when it did not. */
function threwOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('policy annotations', function () {
  it('stores and reads a policy per route, normalizing the method', function () {
    const app = createApp();
    get(app, '/users/:id', () => new Response('ok'));
    post(app, '/users', () => new Response('created'));
    policy(app, 'get', '/users/:id', { timeoutMs: 5000, streaming: true });

    (getPolicy(app.routes[0]!) ?? {}).should.deep.equal({ timeoutMs: 5000, streaming: true });
    // Untouched routes read as undefined.
    (getPolicy(app.routes[1]!) === undefined).should.be.true;
  });

  it('is a no-op for unknown patterns and last-write-wins on repeats', function () {
    const app = createApp();
    get(app, '/a', () => new Response('ok'));
    policy(app, 'GET', '/missing', { timeoutMs: 1 });
    (getPolicy(app.routes[0]!) === undefined).should.be.true;

    policy(app, 'GET', '/a', { timeoutMs: 1 });
    policy(app, 'GET', '/a', { memoryMb: 64 });
    (getPolicy(app.routes[0]!) ?? {}).should.deep.equal({ memoryMb: 64 });
  });
});

describe('shardSpecs grouping', function () {
  it('assigns routes by longest prefix; the "/" group adopts the rest', function () {
    const app = createApp();
    get(app, '/a/x', () => new Response('ax'));
    get(app, '/a/b', () => new Response('ab'));
    get(app, '/a/b/y', () => new Response('aby'));
    get(app, '/elsewhere', () => new Response('else'));
    const specs = shardSpecs(app, [
      { id: 'all', prefix: '/' },
      { id: 'a', prefix: '/a' },
      { id: 'ab', prefix: '/a/b' },
      { id: 'never', prefix: '/never' },
    ]);

    // Declaration order; empty groups produce no spec.
    specs.map((spec) => spec.id).should.deep.equal(['all', 'a', 'ab']);
    patterns(byId(specs, 'a')).should.deep.equal(['/a/x']);
    patterns(byId(specs, 'ab')).should.deep.equal(['/a/b', '/a/b/y']);
    patterns(byId(specs, 'all')).should.deep.equal(['/elsewhere']);
    // A group with no policies of its own merges to just the shard stamp.
    byId(specs, 'ab').policy.should.deep.equal({ shard: 'ab' });
  });

  it('emits route-table entries: params and middleware counts, no functions', function () {
    const app = createApp();
    get(
      app,
      '/a/users/:id',
      async (_ctx, next) => {
        await next();
      },
      (ctx) => new Response(ctx.params.id)
    );
    get(app, '/a/list', () => new Response('list'));
    const specs = shardSpecs(app, [{ id: 'a', prefix: '/a' }]);

    byId(specs, 'a').routes.should.deep.equal([
      { method: 'GET', pattern: '/a/users/:id', params: ['id'], middlewareCount: 1 },
      { method: 'GET', pattern: '/a/list', params: [], middlewareCount: 0 },
    ]);
  });

  it('lets a route-level shard id claim a route away from its prefix', function () {
    const app = createApp();
    get(app, '/heavy/big', () => new Response('big'));
    get(app, '/misc/slow', () => new Response('slow'));
    policy(app, 'GET', '/misc/slow', { shard: 'heavy' });
    const specs = shardSpecs(app, [
      { id: 'heavy', prefix: '/heavy' },
      { id: 'rest', prefix: '/' },
    ]);

    // Registration order is kept; the claimed route rides with 'heavy',
    // so 'rest' ends up empty and emits no spec.
    patterns(byId(specs, 'heavy')).should.deep.equal(['/heavy/big', '/misc/slow']);
    specs.map((spec) => spec.id).should.deep.equal(['heavy']);
  });

  it('merges group and route policies: first-seen route values win, maxConcurrency widens', function () {
    const app = createApp();
    get(app, '/g/one', () => new Response('1'));
    get(app, '/g/two', () => new Response('2'));
    get(app, '/g/three', () => new Response('3'));
    policy(app, 'GET', '/g/one', { timeoutMs: 3000, streaming: true, maxConcurrency: 4 });
    policy(app, 'GET', '/g/two', { timeoutMs: 9999, maxConcurrency: 12 });
    // /g/three carries no policy.
    const specs = shardSpecs(app, [
      { id: 'g', prefix: '/g', policy: { timeoutMs: 10000, memoryMb: 256, maxConcurrency: 8 } },
    ]);

    byId(specs, 'g').policy.should.deep.equal({
      shard: 'g',
      timeoutMs: 3000, // first route definition overrides the group base
      memoryMb: 256, // group base fills what no route defines
      streaming: true,
      maxConcurrency: 12, // max(8, 4, 12)
    });
  });

  it('carries the entry path through to the spec', function () {
    const app = createApp();
    get(app, '/w/x', () => new Response('x'));
    const specs = shardSpecs(app, [{ id: 'w', prefix: '/w', entry: './workers/w.ts' }]);
    (byId(specs, 'w').entry ?? '').should.equal('./workers/w.ts');
  });

  it('throws listing routes that match no group', function () {
    const app = createApp();
    get(app, '/lonely', () => new Response('l'));
    get(app, '/lost', () => new Response('lo'));
    const thrown = threwOf(() => shardSpecs(app, [{ id: 'heavy', prefix: '/heavy' }]));
    (thrown instanceof Error).should.be.true;
    const message = (thrown as Error).message;
    message.should.match(/GET \/lonely/);
    message.should.match(/GET \/lost/);
  });

  it('throws on a route claimed by an unknown shard id, even with a fallback', function () {
    const app = createApp();
    get(app, '/x', () => new Response('x'));
    policy(app, 'GET', '/x', { shard: 'ghost' });
    const thrown = threwOf(() => shardSpecs(app, [{ id: 'root', prefix: '/' }]));
    (thrown instanceof Error).should.be.true;
    (thrown as Error).message.should.match(/ghost/);
  });

  it('validates group declarations', function () {
    const app = createApp();
    get(app, '/a', () => new Response('a'));

    const dup = threwOf(() =>
      shardSpecs(app, [
        { id: 'x', prefix: '/a' },
        { id: 'x', prefix: '/b' },
      ])
    );
    (dup instanceof Error).should.be.true;
    (dup as Error).message.should.match(/Duplicate shard id 'x'/);

    const badPrefix = threwOf(() => shardSpecs(app, [{ id: 'x', prefix: 'a' }]));
    (badPrefix instanceof Error).should.be.true;
    (badPrefix as Error).message.should.match(/must start with '\/'/);

    const badId = threwOf(() => shardSpecs(app, [{ id: 'not_ok', prefix: '/a' }]));
    (badId instanceof Error).should.be.true;
    (badId as Error).message.should.match(/dns-safe/);
  });

  it('normalizes trailing-slash prefixes and keeps spec prefixes clean', function () {
    const app = createApp();
    get(app, '/a/x', () => new Response('ax'));
    const specs = shardSpecs(app, [{ id: 'a', prefix: '/a/' }]);
    byId(specs, 'a').prefix.should.equal('/a');
    patterns(byId(specs, 'a')).should.deep.equal(['/a/x']);
  });
});

describe('shardApp', function () {
  it('extracts a group as a standalone app and remounts equivalently', async function () {
    const parent = createApp();
    const guardHits: string[] = [];
    use(parent, '/a', async (ctx, next) => {
      guardHits.push(ctx.url.pathname);
      await next();
    });
    get(parent, '/a/x', () => new Response('ax'));
    get(parent, '/a/b/y', () => new Response('aby'));
    get(parent, '/c/z', () => new Response('cz'));

    const shard = shardApp(parent, { id: 'a', prefix: '/a' });
    // Absolute patterns, group subtree only; middlewares carried wholesale.
    shard.routes.map((route) => route.pattern).should.deep.equal(['/a/x', '/a/b/y']);
    shard.middlewares.length.should.equal(1);

    const rebuilt = createApp();
    mount(rebuilt, '', shard);
    (await handle(rebuilt, makeRequest('/a/x'))).status.should.equal(200);
    (await handle(rebuilt, makeRequest('/a/b/y'))).status.should.equal(200);
    (await handle(rebuilt, makeRequest('/c/z'))).status.should.equal(404);
    // The scoped middleware guard ran only for the shard's own paths.
    guardHits.should.deep.equal(['/a/x', '/a/b/y']);
  });

  it('honors explicit claims: claimed routes ride along, claimed-elsewhere stay behind', function () {
    const parent = createApp();
    get(parent, '/a/x', () => new Response('ax'));
    get(parent, '/a/y', () => new Response('ay'));
    get(parent, '/solo', () => new Response('solo'));
    policy(parent, 'GET', '/a/y', { shard: 'elsewhere' });
    policy(parent, 'GET', '/solo', { shard: 'a' });

    const shard = shardApp(parent, { id: 'a', prefix: '/a' });
    shard.routes.map((route) => route.pattern).should.deep.equal(['/a/x', '/solo']);
  });

  it('keeps policy annotations alive on the reused route objects', function () {
    const parent = createApp();
    get(parent, '/a/x', () => new Response('ax'));
    policy(parent, 'GET', '/a/x', { timeoutMs: 1234 });
    const shard = shardApp(parent, { id: 'a', prefix: '/a' });
    (getPolicy(shard.routes[0]!) ?? {}).should.deep.equal({ timeoutMs: 1234 });
  });
});

describe('matchShard', function () {
  const spec = (id: string, prefix: string): ShardSpec => ({
    id,
    prefix,
    routes: [],
    policy: { shard: id },
  });
  const specs = [spec('root', '/'), spec('heavy', '/heavy'), spec('jobs', '/heavy/jobs')];

  it('prefers the longest prefix', function () {
    matchShard(specs, '/heavy')?.id.should.equal('heavy');
    matchShard(specs, '/heavy/jobs')?.id.should.equal('jobs');
    matchShard(specs, '/heavy/jobs/y')?.id.should.equal('jobs');
  });

  it('matches on whole path segments and tolerates trailing slashes', function () {
    // '/heavier' is not under '/heavy' — segment boundaries only.
    matchShard(specs, '/heavier')?.id.should.equal('root');
    matchShard(specs, '/heavy/')?.id.should.equal('heavy');
  });

  it('returns undefined when nothing matches and no "/" spec exists', function () {
    const noRoot = specs.filter((candidate) => candidate.id !== 'root');
    (matchShard(noRoot, '/none') === undefined).should.be.true;
    // The '/' spec alone matches everything.
    matchShard([spec('root', '/')], '/anything/x')?.id.should.equal('root');
  });
});
