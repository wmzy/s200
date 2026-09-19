import type { Handler } from '../src/types';

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
      { _tag: 'param', name: 'id' },
    ]);
    createSegments('/files/*rest').should.deep.equal([
      { _tag: 'static', value: 'files' },
      { _tag: 'wildcard', name: 'rest' },
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
});

describe('matchRoutes', function () {
  const getUser = createRoute('GET', '/users/:id', (ctx) => ctx.params.id);
  const postUser = createRoute('POST', '/users', noop);
  const anyPath = createRoute('ALL', '/any/*rest', (ctx) => ctx.params.rest);
  const headUser = createRoute('HEAD', '/users/:id', noop);

  it('returns the first match in registration order', function () {
    const first = createRoute('GET', '/a', noop);
    const second = createRoute('ALL', '/a', noop);
    (mustMatch(matchRoutes([first, second], 'GET', '/a')).route === first)
      .should.be.true;
    (mustMatch(matchRoutes([second, first], 'GET', '/a')).route === second)
      .should.be.true;
  });

  it('skips routes whose method does not match', function () {
    (matchRoutes([postUser], 'GET', '/users') === undefined).should.be.true;
    const posted = mustMatch(matchRoutes([getUser, postUser], 'POST', '/users'));
    (posted.route === postUser).should.be.true;
    posted.params.should.deep.equal({});
  });

  it('matches params and reports them with the route', function () {
    const result = mustMatch(matchRoutes([getUser, postUser], 'GET', '/users/42'));
    (result.route === getUser).should.be.true;
    result.params.should.deep.equal({ id: '42' });
  });

  it("treats 'ALL' routes as matching any method", function () {
    for (const method of ['GET', 'POST', 'DELETE']) {
      const result = mustMatch(matchRoutes([anyPath], method, '/any/deep/path'));
      (result.route === anyPath).should.be.true;
    }
    // ALL matches any method — the pattern still has to match though.
    (matchRoutes([anyPath], 'GET', '/other') === undefined).should.be.true;
  });

  it("matches 'HEAD' requests against GET routes", function () {
    const result = mustMatch(matchRoutes([getUser], 'HEAD', '/users/42'));
    (result.route === getUser).should.be.true;
    result.params.should.deep.equal({ id: '42' });
  });

  it("prefers an exact HEAD route registered earlier, but a GET route wins when it comes first", function () {
    const exactFirst = mustMatch(
      matchRoutes([headUser, getUser], 'HEAD', '/users/1')
    );
    (exactFirst.route === headUser).should.be.true;
    const getFirst = mustMatch(
      matchRoutes([getUser, headUser], 'HEAD', '/users/1')
    );
    (getFirst.route === getUser).should.be.true;
  });

  it('normalizes the incoming method', function () {
    (
      mustMatch(matchRoutes([getUser], 'get', '/users/42')).route === getUser
    ).should.be.true;
  });

  it('returns undefined when nothing matches', function () {
    (
      matchRoutes([getUser, postUser, anyPath], 'PUT', '/none') === undefined
    ).should.be.true;
  });
});
