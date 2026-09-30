import type { App } from '../src/app';
import type { RouteDef, State } from '../src/types';

import { describe, expectTypeOf, it } from 'vitest';

import { createApp, get, handle, mount, post } from '../src/app';
import { throws } from '../src/errors';
import { queryParams } from '../src/query';
import { json } from '../src/respond';
import { jsonBody, type StandardSchemaV1 } from '../src/validate';

/**
 * Extracts the `in` channel of the LAST route in an app's phantom log.
 * The registrars append each def at the tail, so the last def is the one
 * just registered. (client.test.ts asserts `out` through the client's call
 * signatures; `in` has no client surface yet, so this reads the phantom
 * log directly.)
 */
type LastIn<A> = A extends App<State, infer R>
  ? R extends readonly [...RouteDef[], infer D extends RouteDef]
    ? D extends { readonly in: infer I }
      ? I
      : never
    : never
  : never;

/**
 * Extracts the `errors` channel of the LAST route in an app's phantom
 * log — the throws-gate twin of {@link LastIn}.
 */
type LastErrors<A> = A extends App<State, infer R>
  ? R extends readonly [...RouteDef[], infer D extends RouteDef]
    ? D extends { readonly errors: infer E }
      ? E
      : never
    : never
  : never;

describe('route input types', () => {
  it('flows jsonBody\'s parse type into the route log as { json: T }', () => {
    const app = createApp();
    const full = post(
      app,
      '/users',
      jsonBody((data: unknown) => {
        const body = data as { name: unknown };
        if (typeof body.name !== 'string') throw new Error('name required');
        return { name: body.name, id: 7 };
      }),
      (ctx) => json(ctx, ctx.state.validated)
    );

    expectTypeOf<LastIn<typeof full>>().toEqualTypeOf<{
      readonly json: { name: string; id: number };
    }>();

    // The wrong shape must not fit — the brand is precise, not `any`.
    // @ts-expect-error -- { name: string } is not { name: string; id: number }
    const bad: LastIn<typeof full> = { json: { name: 'ada' } };
    full.routes.length.should.equal(1);
    void bad;
  });

  it('flows an annotated queryParams callback into the log as { query: Q }', () => {
    const app = createApp();
    const full = get(
      app,
      '/list',
      queryParams((q: { page?: string }) => q),
      () => new Response('ok')
    );

    expectTypeOf<LastIn<typeof full>>().toEqualTypeOf<{
      readonly query: { page?: string };
    }>();
    void full;
  });

  it('intersects multiple gates instead of unioning their inputs', () => {
    const app = createApp();
    const full = post(
      app,
      '/both',
      jsonBody((data: unknown) => data as { id: number }),
      queryParams((q: { page?: string }) => q),
      () => new Response('ok')
    );

    // A union of function-shaped inputs is not an overload set — the
    // merged input is the intersection, both keys reachable.
    expectTypeOf<LastIn<typeof full>>().toEqualTypeOf<
      { readonly json: { id: number } } & { readonly query: { page?: string } }
    >();
    const both: LastIn<typeof full> = { json: { id: 1 }, query: { page: '2' } };
    void both; void full;
  });

  it('keeps gate-less routes unknown (no never poisoning, no stray keys)', () => {
    const app = createApp();
    const full = get(app, '/plain', () => new Response('ok'));

    expectTypeOf<LastIn<typeof full>>().toEqualTypeOf<unknown>();
    // unknown accepts any value — including one shaped like a real input.
    const anything: LastIn<typeof full> = { json: { id: 1 } };
    void anything; void full;
  });

  it('carries in through mount alongside out', () => {
    const sub = createApp();
    const subFull = post(
      sub,
      '/items',
      jsonBody((data: unknown) => data as { title: string }),
      (ctx) => json(ctx, ctx.state.validated)
    );
    const app = createApp();
    const mounted = mount(app, '/v1', subFull);

    expectTypeOf<LastIn<typeof mounted>>().toEqualTypeOf<{
      readonly json: { title: string };
    }>();
    void mounted;
  });

  it('jsonBody still parses a valid body at runtime (behavior unchanged)', async () => {
    const app = createApp();
    post(
      app,
      '/echo',
      jsonBody((data: unknown) => {
        const body = data as { name: unknown };
        if (typeof body.name !== 'string') throw new Error('name required');
        return { name: body.name };
      }),
      (ctx) => json(ctx, { echoed: ctx.state.validated })
    );

    const res = await handle(
      app,
      new Request('http://localhost/echo', {
        method: 'POST',
        body: JSON.stringify({ name: 'ada' }),
      })
    );
    res.status.should.equal(200);
    (await res.json()).should.deep.equal({ echoed: { name: 'ada' } });
  });

  it('jsonBody still answers invalid JSON with a 400 (behavior unchanged)', async () => {
    const app = createApp();
    post(
      app,
      '/echo',
      jsonBody(() => ({ unreachable: true })),
      () => new Response('unreached')
    );

    const res = await handle(
      app,
      new Request('http://localhost/echo', {
        method: 'POST',
        body: '{nope',
      })
    );
    res.status.should.equal(400);
  });

  it('queryParams still hands the parsed record to the callback at runtime', async () => {
    const app = createApp();
    get(
      app,
      '/search',
      queryParams((q) => q),
      (ctx) => json(ctx, { page: ctx.state.validated })
    );

    const res = await handle(app, new Request('http://localhost/search?page=2'));
    res.status.should.equal(200);
    (await res.json()).should.deep.equal({ page: { page: '2' } });
  });

  it('brands the schema flavor with the schema INPUT, not its output', () => {
    // A transforming schema: callers send `{ iso }`, handlers receive the
    // parsed `{ epoch }` — the `in` channel describes the caller's side.
    const isoSchema: StandardSchemaV1 & {
      readonly types?: {
        readonly input: { readonly iso: string };
        readonly output: { readonly epoch: number };
      };
    } = {
      '~standard': {
        version: 1,
        vendor: 's200-test',
        validate: (value) => ({
          value: { epoch: Date.parse((value as { iso: string }).iso) },
        }),
      },
    };
    const app = createApp();
    const full = post(app, '/dates', jsonBody(isoSchema), (ctx) =>
      json(ctx, ctx.state.validated)
    );

    expectTypeOf<LastIn<typeof full>>().toEqualTypeOf<{
      readonly json: { readonly iso: string };
    }>();
    // The parsed OUTPUT must not pass as the caller's input shape.
    // @ts-expect-error -- { epoch: number } is the schema's output side
    const bad: LastIn<typeof full> = { json: { epoch: 42 } };
    void bad; void full;
  });

  it('brands the queryParams schema flavor with its input too', () => {
    const pageSchema: StandardSchemaV1 & {
      readonly types?: {
        readonly input: { readonly page?: string };
        readonly output: { readonly page: number };
      };
    } = {
      '~standard': {
        version: 1,
        vendor: 's200-test',
        validate: (q) => ({
          value: { page: Number((q as { page?: string }).page ?? '1') },
        }),
      },
    };
    const app = createApp();
    const full = get(app, '/page', queryParams(pageSchema), () => new Response('ok'));

    expectTypeOf<LastIn<typeof full>>().toEqualTypeOf<{
      readonly query: { readonly page?: string };
    }>();
    void full;
  });

  it('collects throws gates into the route log\'s errors channel', () => {
    const app = createApp();
    const full = get(app, '/maybe', throws(401, 404), () => new Response('ok'));

    expectTypeOf<LastErrors<typeof full>>().toEqualTypeOf<{
      readonly 401: { error: string };
      readonly 404: { error: string };
    }>();
    void full;
  });

  it('merges multiple throws gates (statuses + structured shapes)', () => {
    const unprocessable: { 422: { issues: string[] } } = { 422: { issues: [] } };
    const app = createApp();
    const full = get(
      app,
      '/merge',
      throws(401),
      throws(unprocessable),
      () => new Response('ok')
    );

    expectTypeOf<LastErrors<typeof full>>().toEqualTypeOf<
      { readonly 401: { error: string } } & { 422: { issues: string[] } }
    >();
    void full;
  });

  it('keeps throw-less routes an empty record on the errors channel', () => {
    const app = createApp();
    const full = get(app, '/plain', () => new Response('ok'));

    expectTypeOf<LastErrors<typeof full>>().toEqualTypeOf<Record<never, never>>();
    void full;
  });

  it('carries errors through mount alongside in and out', () => {
    const sub = createApp();
    const subFull = get(sub, '/items', throws(404), () => new Response('ok'));
    const app = createApp();
    const mounted = mount(app, '/v1', subFull);

    expectTypeOf<LastErrors<typeof mounted>>().toEqualTypeOf<{
      readonly 404: { error: string };
    }>();
    void mounted;
  });
});
