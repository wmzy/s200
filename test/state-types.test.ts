/**
 * Type-level tests for the state-inference channel: a middleware branded
 * by `withState<X>` widens the app's `S` through `use`, so downstream
 * middlewares and handlers read the injected keys typed — no hand-written
 * app state interface. Runtime behavior is asserted once (the channel is
 * a pure type cast; dispatch is untouched).
 */

import type { App } from '../src/app';
import type { Middleware, ScopedState, State } from '../src/types';

import { describe, expectTypeOf, it } from 'vitest';

import { createApp, get, handle, mount, post, routes, use } from '../src/app';
import { withState } from '../src/middleware';
import { json } from '../src/respond';

type User = {
  id: number;
  name: string;
};
type MergedSession = {
  sid: string;
};

// The global-merge coexistence case: this file's module augmentation adds
// an optional `mergedSession` key to the default State (koa's DefaultState
// trick) — withState injections must compose with it, not replace it. The
// key name is deliberately not `session`: a test-file augmentation leaks
// into every file of the tsc program, and `session` would collide with
// `s200/session` consumers casting `ctx.state.session` (test/oidc-recipe).
declare module '../src/types' {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- must be an interface: declaration merging only extends interfaces
  interface State {
    mergedSession?: MergedSession;
  }
}

const withUser = withState<{ user: User }>(async (ctx, next) => {
  // The injector's own X keys are visible and writable in its body —
  // it owns initializing them before next().
  ctx.state.user = { id: 7, name: 'zoe' };
  await next();
});
const withTenant = withState<{ tenant: string }>((ctx, next) => {
  ctx.state.tenant = 'acme';
  return next();
});
const plain: Middleware = async (_ctx, next) => {
  await next();
};

describe('state inference', () => {
  it("flows withState's X into the app's S and downstream handlers", () => {
    const app = createApp();
    const injected = use(app, withUser);
    expectTypeOf(injected).branded.toEqualTypeOf<App<State & { user: User }, []>>();

    get(injected, '/me', (ctx) => {
      expectTypeOf(ctx.state.user).toEqualTypeOf<User>();
      return json(ctx, { name: ctx.state.user.name });
    });

    // A middleware registered after the injector sees the injected keys
    // too — the app's S is the accumulated view.
    use(injected, async (ctx, next) => {
      const u: User = ctx.state.user;
      void u;
      await next();
    });
  });

  it('accumulates injections across middlewares and use calls (intersection, not union)', () => {
    // Several branded middlewares in one call — plus a plain one that
    // must contribute nothing.
    const one = use(createApp(), withUser, plain, withTenant);
    expectTypeOf(one).branded.toEqualTypeOf<App<State & { user: User } & { tenant: string }, []>>();

    // Separate use calls accumulate the same way.
    const two = use(use(createApp(), withUser), withTenant);
    get(two, '/t', (ctx) => {
      expectTypeOf(ctx.state.user).toEqualTypeOf<User>();
      expectTypeOf(ctx.state.tenant).toEqualTypeOf<string>();
      return new Response('ok');
    });
  });

  it('keeps plain middleware chains byte-identical (backward compatible)', () => {
    const app = createApp();
    expectTypeOf(use(app, plain)).branded.toEqualTypeOf<App<State, []>>();
    expectTypeOf(use(app, '/api', plain, plain)).branded.toEqualTypeOf<App<State, []>>();
    // A union-typed first argument (prefix-or-middleware variable) keeps
    // the old behavior: no brand, no change. The value is the middleware
    // at runtime, so dispatch treats it as the global form.
    const maybe: string | typeof plain = plain;
    expectTypeOf(use(app, maybe)).branded.toEqualTypeOf<App<State, []>>();
  });

  it('scopes prefix-scoped injections to the routes under the prefix', () => {
    const scoped = use(createApp(), '/api', withUser);
    // The app-wide S is untouched — only the scoped log grows.
    expectTypeOf(scoped).branded.toEqualTypeOf<
      App<State, [], [ScopedState<'/api', { user: User }>]>
    >();
    get(scoped, '/api/me', (ctx) => {
      expectTypeOf(ctx.state.user).toEqualTypeOf<User>();
      return new Response('ok');
    });
    get(scoped, '/api/users/:id', (ctx) => {
      // Deeper under the prefix — still typed.
      expectTypeOf(ctx.state.user).toEqualTypeOf<User>();
      return new Response('ok');
    });
    // Outside the prefix the keys are invisible — the loose State view.
    get(scoped, '/public', (ctx) => {
      expectTypeOf(ctx.state.user).toEqualTypeOf<unknown>();
      return new Response('ok');
    });
    // Not even a same-stem sibling: /administrator is not under /api.
    get(scoped, '/apiv2', (ctx) => {
      expectTypeOf(ctx.state.user).toEqualTypeOf<unknown>();
      return new Response('ok');
    });
    // App-level middlewares still type against the plain S — the scoped
    // brand is invisible outside the registrar's pattern filter.
    use(scoped, async (ctx, next) => {
      expectTypeOf(ctx.state.user).toEqualTypeOf<unknown>();
      await next();
    });
  });

  it('scopes param prefixes segment-wise (like the runtime guard)', () => {
    const byUser = use(createApp(), '/users/:uid', withUser);
    get(byUser, '/users/:uid/posts', (ctx) => {
      expectTypeOf(ctx.state.user).toEqualTypeOf<User>();
      return new Response('ok');
    });
    get(byUser, '/users', (ctx) => {
      // The prefix needs the param segment — the bare /users route is out.
      expectTypeOf(ctx.state.user).toEqualTypeOf<unknown>();
      return new Response('ok');
    });
  });

  it('intersects multiple scoped entries and composes with app-wide S', () => {
    const base = use(createApp(), withTenant); // app-wide
    const scoped = use(base, '/api', withUser);
    get(scoped, '/api/x', (ctx) => {
      expectTypeOf(ctx.state.user).toEqualTypeOf<User>();
      expectTypeOf(ctx.state.tenant).toEqualTypeOf<string>();
      return new Response('ok');
    });
    get(scoped, '/other', (ctx) => {
      expectTypeOf(ctx.state.user).toEqualTypeOf<unknown>();
      expectTypeOf(ctx.state.tenant).toEqualTypeOf<string>();
      return new Response('ok');
    });
  });

  it('composes with declare-module State merging instead of replacing it', () => {
    const injected = use(createApp(), withUser);
    get(injected, '/s', (ctx) => {
      expectTypeOf(ctx.state.user).toEqualTypeOf<User>();
      expectTypeOf(ctx.state.mergedSession).toEqualTypeOf<MergedSession | undefined>();
      return new Response('ok');
    });
  });

  it('lets an injector consume earlier injections (and enforces the order)', () => {
    const withProfile = withState<{ profile: string }, { user: User }>(async (ctx, next) => {
      // Reads the prior injection, writes its own X.
      ctx.state.profile = `p${ctx.state.user.id}`;
      await next();
    });
    const chained = use(use(createApp(), withUser), withProfile);
    get(chained, '/p', (ctx) => {
      expectTypeOf(ctx.state.user).toEqualTypeOf<User>();
      expectTypeOf(ctx.state.profile).toEqualTypeOf<string>();
      return new Response('ok');
    });
    // Registering the consumer before its dependency is a type error:
    // a fresh app's State does not satisfy { user: User }.
    // @ts-expect-error — { user } is not injected yet
    use(createApp(), withProfile);
  });

  it('threads branded middlewares in a route chain into that route\'s handler', () => {
    const app = createApp();
    get(app, '/r', withUser, (ctx) => {
      // The chain's brand is threaded into the handler — precisely scoped
      // to this route; the app type is untouched.
      expectTypeOf(ctx.state.user).toEqualTypeOf<User>();
      return new Response('ok');
    });
    // Another route on the same app keeps the loose view.
    get(app, '/other', (ctx) => {
      expectTypeOf(ctx.state.user).toEqualTypeOf<unknown>();
      return new Response('ok');
    });
    // Several chain brands intersect into the handler.
    get(app, '/both', withUser, withTenant, (ctx) => {
      expectTypeOf(ctx.state.user).toEqualTypeOf<User>();
      expectTypeOf(ctx.state.tenant).toEqualTypeOf<string>();
      return new Response('ok');
    });
    // Chain brands compose with prefix-scoped brands.
    const scoped = use(createApp(), '/api', withTenant);
    get(scoped, '/api/x', withUser, plain, (ctx) => {
      expectTypeOf(ctx.state.user).toEqualTypeOf<User>();
      expectTypeOf(ctx.state.tenant).toEqualTypeOf<string>();
      return new Response('ok');
    });
    // A branded middleware with an explicit read-type still cannot sit in
    // a route chain (chain middlewares type against S + scoped brands, not
    // against earlier chain brands) — use() composition enforces that order.
    const withProfile = withState<{ profile: string }, { user: User }>(async (_ctx, next) =>
      next()
    );
    // @ts-expect-error — { user } is not visible to chain middleware typing
    get(createApp(), '/p', withProfile, () => new Response('ok'));
    // ...but the same chain through use() composes fine:
    get(use(createApp(), withUser), '/p2', withUser, (ctx) => {
      expectTypeOf(ctx.state.user).toEqualTypeOf<User>();
      return new Response('ok');
    });
  });

  it('threads chain brands to the handler at runtime too (dispatch untouched)', async () => {
    const app = createApp();
    get(app, '/r', withUser, withTenant, (ctx) =>
      json(ctx, { user: ctx.state.user.name, tenant: ctx.state.tenant })
    );
    const res = await handle(app, new Request('http://localhost/r'));
    (await res.json()).should.deep.equal({ user: 'zoe', tenant: 'acme' });
  });

  it('threads state through the routes() builder like the plain use', () => {
    const built = routes(createApp()).use(withUser).use(withTenant);
    built.get('/b', (ctx) => {
      expectTypeOf(ctx.state.user).toEqualTypeOf<User>();
      expectTypeOf(ctx.state.tenant).toEqualTypeOf<string>();
      return new Response('ok');
    });
    expectTypeOf(built.app).branded.toEqualTypeOf<
      App<State & { user: User } & { tenant: string }, []>
    >();
  });

  it('threads scoped injections and chain brands through the routes() builder', () => {
    const built = routes(createApp()).use('/api', withTenant);
    // The builder's app-wide S stays plain; the scoped entry is in the log.
    expectTypeOf(built.app).branded.toEqualTypeOf<
      App<State, [], [ScopedState<'/api', { tenant: string }>]>
    >();
    built.get('/api/x', (ctx) => {
      expectTypeOf(ctx.state.tenant).toEqualTypeOf<string>();
      return new Response('ok');
    });
    built.get('/api/y', withUser, (ctx) => {
      expectTypeOf(ctx.state.user).toEqualTypeOf<User>();
      expectTypeOf(ctx.state.tenant).toEqualTypeOf<string>();
      return new Response('ok');
    });
    built.get('/out', (ctx) => {
      expectTypeOf(ctx.state.tenant).toEqualTypeOf<unknown>();
      return new Response('ok');
    });
  });

  it('mounts carry the sub-app scoped log with joined prefixes', () => {
    const sub = use(createApp(), '/admin', withUser);
    const parent = mount(createApp(), '/v1', sub);
    get(parent, '/v1/admin/x', (ctx) => {
      expectTypeOf(ctx.state.user).toEqualTypeOf<User>();
      return new Response('ok');
    });
    get(parent, '/v1/other', (ctx) => {
      expectTypeOf(ctx.state.user).toEqualTypeOf<unknown>();
      return new Response('ok');
    });
  });

  it('keeps dynamically-typed prefixes and patterns conservative (invisible)', () => {
    // A non-literal prefix cannot be checked at compile time: the runtime
    // scoping still applies, the types stay loose. (The annotations are the
    // point — they widen the literals to `string`.)
    // eslint-disable-next-line @typescript-eslint/no-inferrable-types -- deliberate widening: a dynamic prefix is not a literal type
    const dynamicPrefix: string = '/api';
    const scoped = use(createApp(), dynamicPrefix, withUser);
    get(scoped, '/api/x', (ctx) => {
      expectTypeOf(ctx.state.user).toEqualTypeOf<unknown>();
      return new Response('ok');
    });
    // A dynamic pattern (plain string) is not prefix-matched either.
    const lit = use(createApp(), '/api', withUser);
    // eslint-disable-next-line @typescript-eslint/no-inferrable-types -- deliberate widening: a dynamic pattern is not a literal type
    const pattern: string = '/api/dyn';
    get(lit, pattern, (ctx) => {
      expectTypeOf(ctx.state.user).toEqualTypeOf<unknown>();
      return new Response('ok');
    });
  });

  it('injected state reaches the handler at runtime (identity cast, dispatch untouched)', async () => {
    const app = use(createApp(), withUser);
    get(app, '/me', (ctx) => json(ctx, ctx.state.user));
    const res = await handle(app, new Request('http://localhost/me'));
    (await res.json()).should.deep.equal({ id: 7, name: 'zoe' });
  });

  it('holds a 20-injection × 30-route chain without degenerating (bloat guard)', () => {
    // One key per injector, chained through 20 use calls, then 30 routes
    // on the final app. A pure instantiation smoke: the gate is tsc
    // resolving this file (see docs/guides/middleware.md for the
    // long-chain degradation advice).
    const injectKey = <K extends string>(key: K) =>
      withState<Record<K, number>>(async (ctx, next) => {
        (ctx.state as Record<K, number>)[key] = 1;
        await next();
      });
    const s1 = use(createApp(), injectKey('a1'));
    const s2 = use(s1, injectKey('a2'));
    const s3 = use(s2, injectKey('a3'));
    const s4 = use(s3, injectKey('a4'));
    const s5 = use(s4, injectKey('a5'));
    const s6 = use(s5, injectKey('a6'));
    const s7 = use(s6, injectKey('a7'));
    const s8 = use(s7, injectKey('a8'));
    const s9 = use(s8, injectKey('a9'));
    const s10 = use(s9, injectKey('a10'));
    const s11 = use(s10, injectKey('a11'));
    const s12 = use(s11, injectKey('a12'));
    const s13 = use(s12, injectKey('a13'));
    const s14 = use(s13, injectKey('a14'));
    const s15 = use(s14, injectKey('a15'));
    const s16 = use(s15, injectKey('a16'));
    const s17 = use(s16, injectKey('a17'));
    const s18 = use(s17, injectKey('a18'));
    const s19 = use(s18, injectKey('a18b'));
    const s20 = use(s19, injectKey('a20'));

    const read = (ctx: { state: State & Record<'a1', number> & Record<'a20', number> }) =>
      ctx.state.a1 + ctx.state.a20;
    get(s20, '/r01', (ctx) => new Response(String(read(ctx))));
    get(s20, '/r02', (ctx) => json(ctx, { v: ctx.state.a7 + ctx.state.a13 }));
    get(s20, '/r03', (ctx) => json(ctx, { v: ctx.state.a2 }));
    get(s20, '/r04', (ctx) => json(ctx, { v: ctx.state.a3 }));
    get(s20, '/r05', (ctx) => json(ctx, { v: ctx.state.a4 }));
    get(s20, '/r06', (ctx) => json(ctx, { v: ctx.state.a5 }));
    get(s20, '/r07', (ctx) => json(ctx, { v: ctx.state.a6 }));
    get(s20, '/r08', (ctx) => json(ctx, { v: ctx.state.a8 }));
    get(s20, '/r09', (ctx) => json(ctx, { v: ctx.state.a9 }));
    get(s20, '/r10', (ctx) => json(ctx, { v: ctx.state.a10 }));
    get(s20, '/r11', (ctx) => json(ctx, { v: ctx.state.a11 }));
    get(s20, '/r12', (ctx) => json(ctx, { v: ctx.state.a12 }));
    get(s20, '/r13', (ctx) => json(ctx, { v: ctx.state.a14 }));
    get(s20, '/r14', (ctx) => json(ctx, { v: ctx.state.a15 }));
    get(s20, '/r15', (ctx) => json(ctx, { v: ctx.state.a16 }));
    get(s20, '/r16', (ctx) => json(ctx, { v: ctx.state.a17 }));
    get(s20, '/r17', (ctx) => json(ctx, { v: ctx.state.a18 }));
    get(s20, '/r18', (ctx) => json(ctx, { v: ctx.state.a18b }));
    get(s20, '/r19', (ctx) => json(ctx, { v: ctx.state.a20 }));
    get(s20, '/r20', (ctx) => json(ctx, { v: ctx.state.a1 }));
    get(s20, '/r21', (ctx) => json(ctx, { v: ctx.state.a7 }));
    get(s20, '/r22', (ctx) => json(ctx, { v: ctx.state.a13 }));
    get(s20, '/r23', (ctx) => json(ctx, { v: ctx.state.a2 + ctx.state.a3 }));
    get(s20, '/r24', (ctx) => json(ctx, { v: ctx.state.a4 + ctx.state.a5 }));
    get(s20, '/r25', (ctx) => json(ctx, { v: ctx.state.a6 + ctx.state.a8 }));
    get(s20, '/r26', (ctx) => json(ctx, { v: ctx.state.a9 + ctx.state.a10 }));
    get(s20, '/r27', (ctx) => json(ctx, { v: ctx.state.a11 + ctx.state.a12 }));
    get(s20, '/r28', (ctx) => json(ctx, { v: ctx.state.a14 + ctx.state.a15 }));
    get(s20, '/r29', (ctx) => json(ctx, { v: ctx.state.a17 + ctx.state.a18 }));
    post(s20, '/r30', (ctx) => json(ctx, { v: ctx.state.a1 + ctx.state.a20 }));

    // The chain held end to end: the deepest key is still precisely typed
    // on the final app.
    get(s20, '/last', (ctx) => {
      expectTypeOf(ctx.state.a20).toEqualTypeOf<number>();
      expectTypeOf(ctx.state.a1).toEqualTypeOf<number>();
      return new Response('ok');
    });
  });
});
