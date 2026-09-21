import type { Handler, MatchResult, Middleware, Route } from '../src/types';

import { describe, it, expectTypeOf } from 'vitest';

import {
  createRoute,
  createSegments,
  matchRoutes,
  matchSegments,
  ParamsOf,
} from '../src/router';

const noop: Handler = () => undefined;

// Matchers return `T | undefined`; narrow once so `.should` typechecks.
function mustMatch<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('expected a match');
  }
  return value;
}

// Narrow the MatchResult union to its route-bearing member.
function mustRoute(
  value: MatchResult | undefined
): Extract<MatchResult, { route: Route }> {
  const match = mustMatch(value);
  if (!('route' in match)) {
    throw new Error('expected a route match, got a method miss');
  }
  return match;
}

describe('createSegments', function () {
  it('parses the root pattern to zero segments', function () {
    createSegments('/').should.deep.equal([]);
  });

  it('parses static, param and terminal wildcard segments', function () {
    createSegments('/a/b').should.deep.equal([
      { _tag: 'static', value: 'a' },
      { _tag: 'static', value: 'b' },
    ]);
    createSegments('/users/:id').should.deep.equal([
      { _tag: 'static', value: 'users' },
      { _tag: 'param', name: 'id', optional: false },
    ]);
    createSegments('/files/*rest').should.deep.equal([
      { _tag: 'static', value: 'files' },
      { _tag: 'wildcard', name: 'rest' },
    ]);
    createSegments('/users/:id?').should.deep.equal([
      { _tag: 'static', value: 'users' },
      { _tag: 'param', name: 'id', optional: true },
    ]);
  });

  it('throws on the empty pattern and patterns without a leading slash', function () {
    (() => createSegments('')).should.throw(/pattern/);
    (() => createSegments('users')).should.throw(/must start with '\/'/);
  });

  it('throws on empty segments: double slash and trailing slash', function () {
    (() => createSegments('/a//b')).should.throw(/empty segment/);
    (() => createSegments('/a/')).should.throw(/empty segment/);
  });

  it('throws on malformed param segments', function () {
    (() => createSegments('/:')).should.throw(/param/);
    (() => createSegments('/a/:bad!')).should.throw(/param/);
    (() => createSegments('/a/:9x:y')).should.throw(/param/);
  });

  it("throws on a ':' in the middle of a static segment", function () {
    (() => createSegments('/a:b')).should.throw(/static segment/);
  });

  it('throws on wildcards that are bare, badly named or not terminal', function () {
    (() => createSegments('/*')).should.throw(/\*/);
    (() => createSegments('/a/*bad!')).should.throw(/wildcard/);
    (() => createSegments('/a/*rest/b')).should.throw(/last segment/);
  });

  it('throws on duplicate capture names across params and wildcards', function () {
    (() => createSegments('/users/:id/posts/:id')).should.throw(
      /duplicate capture name 'id'/
    );
    (() => createSegments('/a/:x/*x')).should.throw(/duplicate capture name 'x'/);
  });
});

describe('createRoute', function () {
  it('normalizes the method to uppercase and keeps ALL', function () {
    createRoute('get', '/a', noop).method.should.equal('GET');
    createRoute('all', '/a', noop).method.should.equal('ALL');
  });

  it('stores the pattern, parsed segments and handler', function () {
    const route = createRoute('GET', '/users/:id', noop);
    route.pattern.should.equal('/users/:id');
    route.segments.should.deep.equal(createSegments('/users/:id'));
    route.handler.should.equal(noop);
  });

  it('throws on an empty method', function () {
    (() => createRoute('', '/a', noop)).should.throw(/method/);
  });

  it('validates the pattern through createSegments', function () {
    (() => createRoute('GET', '/a/', noop)).should.throw(/empty segment/);
  });

  it('accepts dynamic (non-literal) patterns with loose handler typing', function () {
    const pattern = ['/a/', ':id'].join(''); // '/a/:id' but not a literal
    const handler: Handler = (ctx) => ctx.params.id;
    const route = createRoute('GET', pattern, handler);
    route.method.should.equal('GET');
    route.pattern.should.equal('/a/:id');
  });

  it('stores route-scoped middlewares and defaults to an empty chain', function () {
    const mw: Middleware = async (_ctx, next) => next();
    createRoute('GET', '/a', noop).middlewares.should.deep.equal([]);
    const route = createRoute('GET', '/a', noop, [mw]);
    route.middlewares.should.deep.equal([mw]);
  });
});

describe('ParamsOf (compile-time sanity)', function () {
  it('extracts :param and terminal *wildcard names', function () {
    expectTypeOf<ParamsOf<'/users'>>().toEqualTypeOf<
      // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- a static path maps to the empty mapped type, that IS the contract
      {}
    >();
    expectTypeOf<ParamsOf<'/users/:id'>>().toEqualTypeOf<{ id: string }>();
    expectTypeOf<ParamsOf<'/files/*path'>>().toEqualTypeOf<{ path: string }>();
    expectTypeOf<
      ParamsOf<'/posts/:pid/comments/:cid/*rest'>
    >().toEqualTypeOf<{ pid: string; cid: string; rest: string }>();
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- root pattern maps to the empty mapped type, that IS the contract
    expectTypeOf<ParamsOf<'/'>>().toEqualTypeOf<{}>();
  });

  it('types ctx.params inside a literal-pattern handler', function () {
    const route = createRoute(
      'GET',
      '/posts/:postId/comments/:commentId',
      (ctx) => `${ctx.params.postId}/${ctx.params.commentId}`
    );
    route.method.should.equal('GET');
    // Compile-time only: both names must exist as strings on ctx.params.
    expectTypeOf(route).not.toBeAny();
  });
});

describe('matchSegments', function () {
  it('matches the root exactly', function () {
    mustMatch(matchSegments([], '/')).should.deep.equal({});
    (matchSegments([], '/a') === undefined).should.be.true;
  });

  it('matches static paths exactly', function () {
    mustMatch(matchSegments(createSegments('/a/b'), '/a/b')).should.deep.equal({});
    (matchSegments(createSegments('/a/b'), '/a') === undefined).should.be.true;
    (matchSegments(createSegments('/a/b'), '/a/b/c') === undefined).should.be
      .true;
    (matchSegments(createSegments('/a'), '/A') === undefined).should.be.true;
  });

  it('is strict about trailing slashes', function () {
    (matchSegments(createSegments('/a'), '/a/') === undefined).should.be.true;
    (matchSegments(createSegments('/a/:id'), '/a/') === undefined).should.be
      .true;
    (matchSegments([], '//') === undefined).should.be.true;
  });

  it('captures params segment-wise', function () {
    mustMatch(
      matchSegments(createSegments('/users/:id'), '/users/42')
    ).should.deep.equal({ id: '42' });
    mustMatch(
      matchSegments(
        createSegments('/posts/:pid/comments/:cid'),
        '/posts/7/comments/abc'
      )
    ).should.deep.equal({ pid: '7', cid: 'abc' });
    // Params sit between statics; each consumes exactly one segment.
    (matchSegments(createSegments('/a/:id'), '/x/1') === undefined).should.be
      .true;
  });

  it('lets a terminal wildcard capture the rest, possibly empty', function () {
    mustMatch(
      matchSegments(createSegments('/files/*rest'), '/files/a/b/c.txt')
    ).should.deep.equal({ rest: 'a/b/c.txt' });
    mustMatch(
      matchSegments(createSegments('/files/*rest'), '/files/x')
    ).should.deep.equal({ rest: 'x' });
    mustMatch(
      matchSegments(createSegments('/files/*rest'), '/files/')
    ).should.deep.equal({ rest: '' });
    (matchSegments(createSegments('/files/*rest'), '/other/x') === undefined)
      .should.be.true;
  });

  it('rejects pathnames without a leading slash', function () {
    (matchSegments(createSegments('/a'), 'a') === undefined).should.be.true;
  });

  it('hands captured params to handlers percent-decoded', function () {
    mustMatch(
      matchSegments(createSegments('/users/:id'), '/users/foo%20bar')
    ).should.deep.equal({ id: 'foo bar' });
    // An encoded slash stays inside ONE segment during matching...
    mustMatch(
      matchSegments(createSegments('/files/:name'), '/files/a%2Fb')
    ).should.deep.equal({ name: 'a/b' });
    // ...it captures whole (decoded), while a real slash splits — the
    // surplus segment makes the path a non-match.
    mustMatch(
      matchSegments(createSegments('/a/:x/b'), '/a/1%2F2/b')
    ).should.deep.equal({ x: '1/2' });
    (matchSegments(createSegments('/a/:x/b'), '/a/1/2/b') === undefined).should.be
      .true;
    // Wildcards decode the whole capture.
    mustMatch(
      matchSegments(createSegments('/f/*rest'), '/f/a%20b/c')
    ).should.deep.equal({ rest: 'a b/c' });
  });

  it('keeps malformed escapes raw instead of throwing', function () {
    mustMatch(
      matchSegments(createSegments('/users/:id'), '/users/%zz')
    ).should.deep.equal({ id: '%zz' });
  });
});

describe('matchRoutes', function () {
  const getUser = createRoute('GET', '/users/:id', (ctx) => ctx.params.id);
  const postUser = createRoute('POST', '/users', noop);
  const anyPath = createRoute('ALL', '/any/*rest', (ctx) => ctx.params.rest);
  const headUser = createRoute('HEAD', '/users/:id', noop);

  it('returns the first match in registration order', function () {
    const first = createRoute('GET', '/a', noop);
    const second = createRoute('ALL', '/a', noop);
    (mustRoute(matchRoutes([first, second], 'GET', '/a')).route === first)
      .should.be.true;
    (mustRoute(matchRoutes([second, first], 'GET', '/a')).route === second)
      .should.be.true;
  });

  it('reports the allowed methods when the path matches but the method does not', function () {
    mustMatch(matchRoutes([postUser], 'GET', '/users')).should.deep.equal({
      allowedMethods: ['POST'],
    });
    const posted = mustRoute(matchRoutes([getUser, postUser], 'POST', '/users'));
    (posted.route === postUser).should.be.true;
    posted.params.should.deep.equal({});
  });

  it('matches params and reports them with the route', function () {
    const result = mustRoute(matchRoutes([getUser, postUser], 'GET', '/users/42'));
    (result.route === getUser).should.be.true;
    result.params.should.deep.equal({ id: '42' });
  });

  it("treats 'ALL' routes as matching any method", function () {
    for (const method of ['GET', 'POST', 'DELETE']) {
      const result = mustRoute(matchRoutes([anyPath], method, '/any/deep/path'));
      (result.route === anyPath).should.be.true;
    }
    // ALL matches any method — the pattern still has to match though.
    (matchRoutes([anyPath], 'GET', '/other') === undefined).should.be.true;
  });

  it("matches 'HEAD' requests against GET routes", function () {
    const result = mustRoute(matchRoutes([getUser], 'HEAD', '/users/42'));
    (result.route === getUser).should.be.true;
    result.params.should.deep.equal({ id: '42' });
  });

  it("prefers an exact HEAD route registered earlier, but a GET route wins when it comes first", function () {
    const exactFirst = mustRoute(
      matchRoutes([headUser, getUser], 'HEAD', '/users/1')
    );
    (exactFirst.route === headUser).should.be.true;
    const getFirst = mustRoute(
      matchRoutes([getUser, headUser], 'HEAD', '/users/1')
    );
    (getFirst.route === getUser).should.be.true;
  });

  it('normalizes the incoming method', function () {
    (
      mustRoute(matchRoutes([getUser], 'get', '/users/42')).route === getUser
    ).should.be.true;
  });

  it('returns undefined when nothing matches', function () {
    (
      matchRoutes([getUser, postUser, anyPath], 'PUT', '/none') === undefined
    ).should.be.true;
  });

  it('lists allowed methods in registration order, deduping shadowed duplicates', function () {
    const deleteUser = createRoute('DELETE', '/users/:id', noop);
    const shadowed = createRoute('POST', '/users', noop);
    mustMatch(matchRoutes([getUser, postUser, shadowed, deleteUser], 'PATCH', '/users'))
      .should.deep.equal({ allowedMethods: ['POST'] });
    mustMatch(matchRoutes([getUser, postUser, deleteUser], 'PATCH', '/users/42'))
      .should.deep.equal({ allowedMethods: ['GET', 'DELETE'] });
  });

  it('never lists ALL routes — they match every method and would have won', function () {
    mustMatch(matchRoutes([getUser, anyPath], 'DELETE', '/users/42')).should.deep.equal({
      allowedMethods: ['GET'],
    });
  });

  it('ignores method-compatible routes when building the Allow list', function () {
    // getUser is GET-compatible with the request but misses the path; the
    // Allow list only contains real path hits (postUser, pattern /users).
    mustMatch(matchRoutes([getUser, postUser], 'GET', '/users')).should.deep.equal({
      allowedMethods: ['POST'],
    });
    (
      matchRoutes([getUser, postUser], 'POST', '/other') === undefined
    ).should.be.true;
  });

  it('matches param-first tables by their later static segments (indexed, not scanned)', function () {
    const routes = Array.from({ length: 50 }, (_, i) =>
      createRoute('GET', `/:tenant/resource${i}`, (ctx) => ctx.params.tenant),
    );
    const result = mustRoute(matchRoutes(routes, 'GET', '/acme/resource37'));
    (result.route === routes[37]).should.be.true;
    result.params.should.deep.equal({ tenant: 'acme' });
    // A miss never scans: no candidate key exists for the path's statics.
    (matchRoutes(routes, 'GET', '/acme/nope') === undefined).should.be.true;
  });

  it('matches statics separated by params in any position', function () {
    const deep = createRoute('GET', '/a/:x/b/:y/c', (ctx) => ctx.params.x);
    const table = [createRoute('GET', '/a/z', noop), deep];
    const result = mustRoute(matchRoutes(table, 'GET', '/a/1/b/2/c'));
    (result.route === deep).should.be.true;
    result.params.should.deep.equal({ x: '1', y: '2' });
    // Both static anchors must line up — the index alone is not a match.
    (matchRoutes(table, 'GET', '/a/1/other/2/c') === undefined).should.be.true;
  });

  it('keeps registration order across indexed buckets and plain lists', function () {
    const paramFirst = createRoute('GET', '/:a/x', noop);
    const plain = createRoute('GET', '/p/x', noop);
    const later = createRoute('GET', '/:b/x', noop);
    const table = [paramFirst, plain, later];
    // '/p/x' hits paramFirst (via index), plain, and later — the earliest
    // registration wins.
    (mustRoute(matchRoutes(table, 'GET', '/p/x')).route === paramFirst).should.be
      .true;
    // Remove the param-first route and the plain route wins over the other
    // indexed one.
    (mustRoute(matchRoutes([plain, later], 'GET', '/p/x')).route === plain).should
      .be.true;
  });

  it('builds the 405 Allow list for param-first tables too', function () {
    const getTenant = createRoute('GET', '/:tenant/report', noop);
    const postTenant = createRoute('POST', '/:tenant/report', noop);
    mustMatch(matchRoutes([getTenant, postTenant], 'PATCH', '/acme/report')).should.deep.equal({
      allowedMethods: ['GET', 'POST'],
    });
  });

  it('tolerates a trailing slash when strict is off', function () {
    const route = createRoute('GET', '/a/:id', noop);
    const result = mustRoute(matchRoutes([route], 'GET', '/a/42/', false));
    result.params.should.deep.equal({ id: '42' });
    (matchRoutes([route], 'GET', '/a/42/', true) === undefined).should.be.true;
    // Only ONE trailing empty segment is tolerated — '//' still misses.
    (matchRoutes([route], 'GET', '/a/42//', false) === undefined).should.be.true;
    // Strict stays the default when the flag is omitted.
    (matchRoutes([route], 'GET', '/a/42/') === undefined).should.be.true;
  });
});

describe('optional params', function () {
  it('matches with the param present and absent', function () {
    const route = createRoute('GET', '/users/:id?', noop);
    const withId = mustRoute(matchRoutes([route], 'GET', '/users/42'));
    withId.params.should.deep.equal({ id: '42' });
    const without = mustRoute(matchRoutes([route], 'GET', '/users'));
    (without.params.id === undefined).should.be.true;
    Object.keys(without.params).should.deep.equal([]);
  });

  it('tries consuming first, then backtracks past a static segment', function () {
    const route = createRoute('GET', '/x/:a?/y', noop);
    mustRoute(matchRoutes([route], 'GET', '/x/y')).params.should.deep.equal({});
    mustRoute(matchRoutes([route], 'GET', '/x/1/y')).params.should.deep.equal({ a: '1' });
    (matchRoutes([route], 'GET', '/x/y/z') === undefined).should.be.true;
  });

  it('resolves chained optional params greedily', function () {
    const route = createRoute('GET', '/a/:x?/:y?', noop);
    mustRoute(matchRoutes([route], 'GET', '/a')).params.should.deep.equal({});
    mustRoute(matchRoutes([route], 'GET', '/a/1')).params.should.deep.equal({ x: '1' });
    mustRoute(matchRoutes([route], 'GET', '/a/1/2')).params.should.deep.equal({ x: '1', y: '2' });
    (matchRoutes([route], 'GET', '/a/1/2/3') === undefined).should.be.true;
  });

  it('backtracks a failed consume without leaking earlier keys', function () {
    // Consuming b as '2' fails at the static 'c'; the retry must skip a
    // and re-read b from position 0, not leave stale captures behind.
    const route = createRoute('GET', '/:a?/:b/c', noop);
    const result = mustRoute(matchRoutes([route], 'GET', '/2/c'));
    result.params.should.deep.equal({ b: '2' });
    (result.params.a === undefined).should.be.true;
  });

  it('decodes captured values and tolerates a trailing slash like params', function () {
    const route = createRoute('GET', '/users/:id?', noop);
    mustRoute(matchRoutes([route], 'GET', '/users/foo%20bar')).params.should.deep.equal({
      id: 'foo bar',
    });
    // Strict: '/users/' keeps its empty trailing segment, which the
    // optional param may skip but the matcher may not leave unconsumed.
    (matchRoutes([route], 'GET', '/users/') === undefined).should.be.true;
    // Non-strict trims the trailing slash and matches with id absent.
    mustRoute(matchRoutes([route], 'GET', '/users/', false)).params.should.deep.equal({});
  });

  it('rejects malformed optional syntax at registration', function () {
    (() => createRoute('GET', '/x/:?', noop)).should.throw(/':\?'/);
    (() => createRoute('GET', '/x/:id??', noop)).should.throw(/':id\?\?'/);
    (() => createRoute('GET', '/x/:a-b?', noop)).should.throw(/':a-b\?'/);
    (() => createRoute('GET', '/x/:id?/y/:id?', noop)).should.throw(/duplicate capture name/);
  });

  it('types optional params as optional keys', function () {
    expectTypeOf<ParamsOf<'/users/:id?'>>().branded.toEqualTypeOf<{ id?: string }>();
    expectTypeOf<ParamsOf<'/a/:x?/b/:y'>>().branded.toEqualTypeOf<{ x?: string; y: string }>();
  });
});
