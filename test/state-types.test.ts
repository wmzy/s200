/**
 * Type-level tests for the state-inference channel: a middleware branded
 * by `withState<X>` widens the app's `S` through `use`, so downstream
 * middlewares and handlers read the injected keys typed — no hand-written
 * app state interface. Runtime behavior is asserted once (the channel is
 * a pure type cast; dispatch is untouched).
 */

import type { App } from '../src/app';
import type { Middleware, State } from '../src/types';

import { describe, expectTypeOf, it } from 'vitest';

import { createApp, get, handle, post, routes, use } from '../src/app';
import { withState } from '../src/middleware';
import { json } from '../src/respond';

type User = {
  id: number;
  name: string;
};
type Session = {
  sid: string;
};

// The global-merge coexistence case: this file's module augmentation adds
// an optional `session` key to the default State (koa's DefaultState
// trick) — withState injections must compose with it, not replace it.
declare module '../src/types' {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- must be an interface: declaration merging only extends interfaces
  interface State {
    session?: Session;
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

  it('threads prefix-scoped injections app-wide (the documented trust)', () => {
    // The prefix form cannot narrow S to the prefix's routes — the type is
    // app-wide, the runtime guarantee is the prefix's. Documented contract.
    const scoped = use(createApp(), '/api', withUser);
    expectTypeOf(scoped).branded.toEqualTypeOf<App<State & { user: User }, []>>();
  });

  it('composes with declare-module State merging instead of replacing it', () => {
    const injected = use(createApp(), withUser);
    get(injected, '/s', (ctx) => {
      expectTypeOf(ctx.state.user).toEqualTypeOf<User>();
      expectTypeOf(ctx.state.session).toEqualTypeOf<Session | undefined>();
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

  it('runs but does not thread branded middlewares inside a route chain', () => {
    // Documented boundary: the _state brand is collected by use only. In
    // a route's own chain the middleware runs (state is written at
    // runtime) but the handler keeps the loose State view.
    const app = createApp();
    get(app, '/r', withUser, (ctx) => {
      expectTypeOf(ctx.state.user).toEqualTypeOf<unknown>();
      return new Response('ok');
    });
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
