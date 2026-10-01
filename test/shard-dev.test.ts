import type { App } from '../src/app';
import type { ShardSpec } from '../src/shard';

import { describe, it } from 'vitest';

import { createApp, get, post } from '../src/app';
import { createRouteTable } from '../src/route-table';
import { createDispatcher, dispatchPlan } from '../src/shard-dev';

// A real spec, not a hand-rolled literal: the route table is the same pure
// data the gateway generator consumes, so the dispatcher is exercised with
// the artifacts production would see.
function specOf(id: string, prefix: string, app: App): ShardSpec {
  return { id, prefix, routes: createRouteTable(app).routes, policy: {} };
}

describe('createDispatcher (dev shard dispatcher)', function () {
  const catalog = createApp();
  get(catalog, '/cat/items', () => new Response('catalog-list'));
  get(catalog, '/cat/items/:id', (ctx) => new Response(`catalog-${String(ctx.params.id)}`));
  post(catalog, '/cat/items', () => new Response('catalog-create'));

  const jobs = createApp();
  get(jobs, '/heavy/jobs', () => new Response('jobs-list'));

  const aShard = createApp();
  get(aShard, '/a/root', () => new Response('a-root'));

  const abShard = createApp();
  get(abShard, '/a/b/deep', () => new Response('ab-deep'));

  const fallback = createApp();
  get(fallback, '/status', () => new Response('all-good'));
  // Proof target for the segment-boundary case: this route only exists in
  // the fallback app, so answering from it means the request physically
  // reached the fallback, not that some 404 fired.
  get(fallback, '/catalog', () => new Response('fallback-catalog'));

  const entries = [
    { spec: specOf('catalog', '/cat', catalog), app: catalog },
    { spec: specOf('jobs', '/heavy', jobs), app: jobs },
    { spec: specOf('a', '/a', aShard), app: aShard },
    { spec: specOf('a-b', '/a/b', abShard), app: abShard },
  ];

  const dispatch = createDispatcher(entries, fallback);

  it('routes each claimed pathname into its shard app', async function () {
    const list = await dispatch(new Request('http://x/cat/items'));
    list.status.should.equal(200);
    (await list.text()).should.equal('catalog-list');

    const one = await dispatch(new Request('http://x/cat/items/42'));
    one.status.should.equal(200);
    (await one.text()).should.equal('catalog-42');

    const heavy = await dispatch(new Request('http://x/heavy/jobs'));
    heavy.status.should.equal(200);
    (await heavy.text()).should.equal('jobs-list');
  });

  it('an unclaimed pathname falls through to the fallback app', async function () {
    const res = await dispatch(new Request('http://x/status'));
    res.status.should.equal(200);
    (await res.text()).should.equal('all-good');
  });

  it("a prefix claims whole segments only — '/catalog' is not under '/cat'", async function () {
    // Must NOT match the /cat shard: it lands in the fallback, whose own
    // route table resolves it (a distinct route from /status).
    const res = await dispatch(new Request('http://x/catalog'));
    res.status.should.equal(200);
    (await res.text()).should.equal('fallback-catalog');
  });

  it('longest prefix wins: /a/b claims its subtree before /a', async function () {
    const deep = await dispatch(new Request('http://x/a/b/deep'));
    deep.status.should.equal(200);
    (await deep.text()).should.equal('ab-deep');

    const root = await dispatch(new Request('http://x/a/root'));
    root.status.should.equal(200);
    (await root.text()).should.equal('a-root');

    // Exact '/a/b' is claimed by the nested shard too — its app just has
    // no route there, so the 404 is the SHARD's, not the dispatcher's.
    const boundary = await dispatch(new Request('http://x/a/b'));
    boundary.status.should.equal(404);
    JSON.parse(await boundary.text()).should.deep.equal({ error: 'Not Found' });
  });

  it('dispatch is method-blind: same prefix, every method, same shard', async function () {
    const got = await dispatch(new Request('http://x/cat/items'));
    got.status.should.equal(200);
    (await got.text()).should.equal('catalog-list');

    const posted = await dispatch(new Request('http://x/cat/items', { method: 'POST' }));
    posted.status.should.equal(200);
    (await posted.text()).should.equal('catalog-create');

    // A method the catalog app never registered still reaches the catalog
    // shard: its own router answers 405 — the dispatcher never split by
    // method or bounced the request elsewhere.
    const put = await dispatch(new Request('http://x/cat/items', { method: 'PUT' }));
    put.status.should.equal(405);
    JSON.parse(await put.text()).should.deep.equal({ error: 'Method Not Allowed' });
  });

  it('without a fallback, an unclaimed pathname answers 404 {error:"no shard"}', async function () {
    const bare = createDispatcher(entries);
    const res = await bare(new Request('http://x/nope'));
    res.status.should.equal(404);
    (res.headers.get('content-type') ?? '').should.equal('application/json');
    JSON.parse(await res.text()).should.deep.equal({ error: 'no shard' });
  });
});

describe('dispatchPlan', function () {
  it('lists shards longest-prefix-first — the priority matchShard applies', function () {
    const catalog = createApp();
    get(catalog, '/cat', () => new Response('ok'));
    const jobs = createApp();
    get(jobs, '/heavy', () => new Response('ok'));
    const a = createApp();
    get(a, '/a', () => new Response('ok'));
    const ab = createApp();
    get(ab, '/a/b', () => new Response('ok'));

    const plan = dispatchPlan([
      specOf('catalog', '/cat', catalog),
      specOf('jobs', '/heavy', jobs),
      specOf('a', '/a', a),
      specOf('a-b', '/a/b', ab),
    ]);
    plan.should.deep.equal([
      { prefix: '/heavy', id: 'jobs' },
      { prefix: '/cat', id: 'catalog' },
      { prefix: '/a/b', id: 'a-b' },
      { prefix: '/a', id: 'a' },
    ]);
  });
});
