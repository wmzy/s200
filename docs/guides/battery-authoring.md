# Authoring Batteries

A battery is s200's unit of middleware reuse: an opt-in module behind its own package entry (`s200/cors`, `s200/validate`, …), zero runtime dependencies, built from pure functions — options in, `Middleware` out. The built-ins are the pattern book, and `defineMiddleware` in the core barrel is the labeled front door for packaging your own. This guide walks the two runtime shapes, the type brands that flow into `s200/client`, the structural conventions of the built-ins, and how to publish. For a tour of what ships today, see the [batteries overview](/guides/batteries).

## What a battery is

Four rules every battery follows, built-in or yours:

1. **A separate entry.** `import { cors } from 's200/cors'` pulls one module, never the core barrel. In this repository that is one source file (`src/cors.ts`) wired as one build entry; in your package it is one subpath export.
2. **Zero runtime dependencies.** The framework has none, and a battery may not add any. Everything else is Web Standard (`Request`, `Headers`, `crypto.subtle`, `CompressionStream`, `performance.now()`) or injected by the caller — schemas, stores, clocks, verifiers, sinks.
3. **Pure functions.** A factory takes an options object and returns a `Middleware`. No module-level registration side effects, no classes, no `this` — the app is data, and a battery is a function that produces one more piece of it.
4. **One of two runtime shapes** — a *gate* or an *unwind stamper*, distinguished by how they use `next` (next section). The shapes compose: `requestId` seeds `ctx.state` before `next()` and stamps the header on the unwind; `timeout` narrows `ctx.signal` on the way in and races the chain against its deadline after.

## The two shapes

### Gates: answer in place, never descend

A gate runs request-side work ahead of the chain below it. Rejection is structural — write a response (or throw) and **don't call `next()`**: the handler and every later middleware never run. Two rejection styles, both in the tree:

```ts
// Style 1 — throw an HttpError; the in-chain error boundary renders it
// as a 401 response with the default { "error": message } JSON envelope.
throw httpError(401, 'invalid api key');

// Style 2 — write the rejection in place (what s200/auth does, so it can
// carry the WWW-Authenticate challenge), then return without next().
json(ctx, { error: 'Unauthorized' }, {
  status: 401,
  headers: { 'www-authenticate': challenge },
});
```

Gates in the tree: `basicAuth` / `bearerAuth` (401), `jwtAuth` (401), `rateLimit` (429 + `Retry-After`), `csrf` (403), `jsonBody` / `queryParams` (400 bad JSON, 422 schema issues), `timeout` (503).

Acceptance is the mirror image: do the work (parse, verify, count), store any request-scoped result on `ctx.state`, then `return next()`.

### Unwind stampers: observe and stamp the response

A stamper calls `await next()` first. When it resolves, `ctx.res` **always exists** — the handler's response, the 404/405 fallback, or the error response from the boundary. Stamp headers, replace the response, or just observe it:

```ts
// s200/etag, abridged to its skeleton
export function etag(options: EtagOptions = {}): Middleware {
  const prefix = options.strong === true ? '' : 'W/';
  return async (ctx, next) => {
    await next();
    const res = ctx.res; // Response | undefined by type — the contract fills it
    if (res === undefined || res.body === null) return; // nothing to tag
    if (res.headers.has('etag')) return;      // someone tagged already
    if (res.headers.get('content-length') === null) return; // streamed — skip
    const bytes = new Uint8Array(await res.arrayBuffer());
    const tag = `${prefix}"${hex(await crypto.subtle.digest('SHA-1', bytes))}"`;
    const headers = new Headers(res.headers);
    headers.set('etag', tag);
    ctx.res = newResponse(ctx, bytes, { status: res.status, headers });
  };
}
```

Stampers in the tree: `cors` (allow-origin headers on every response, error bodies included — a browser reading the error needs them), `logger` (logs the real status, 500s included), `etag` (tags and answers 304), `secureHeaders` (the safe baseline), `compress` (encodes byte-backed bodies).

### The contract both shapes stand on

- **Responses materialize inside the chain.** The route chain and the 404/405 fallbacks are wrapped in an error boundary; a thrown error is mapped to a response — an `HttpError`'s status and message, otherwise a 500 — *before* the unwind starts. So `await next()` resolving means `ctx.res` is set, always, 500s included. A stamper sees and may overwrite every response; a gate that throws still gets its error response stamped by `cors` and logged by `logger`.
- **A second `next()` before the first settles rejects** — `Error('next() called multiple times')`, faithful to koa-compose.
- **Not calling `next()` short-circuits.** Whatever sits in `ctx.res` when the outermost middleware returns is what the adapter sends.

This is the load-bearing wall for stampers — it is why `cors`, `logger`, and `otel` can promise that error responses are covered too.

## `defineMiddleware`: the published wrapper

```ts
export function defineMiddleware<M extends (ctx: Ctx, next: Next) => Promise<void> | void>(
  mw: M
): M;
```

Identity at runtime, zero cost. What the wrap buys:

1. **The full type survives.** Annotating your factory's return as plain `Middleware` is fine for unbranded batteries, but it erases any phantom brand a registrar could have collected. Wrapping the returned closure in `defineMiddleware` preserves its complete inferred type today, and stays the attachment point for battery tooling (docs generation, contract checks) tomorrow without breaking call sites.
2. **A discoverable contract.** One importable symbol that says "this is a battery" — the front door authors write against and consumers scan for.

```ts
import { defineMiddleware } from 's200';

/** Marks every response, error responses included, as no-store. */
export const noStore = defineMiddleware(async (ctx, next) => {
  await next();
  ctx.res?.headers.set('cache-control', 'no-store');
});
```

## Type brands: `_in` and `_out`

Phantom props — type-only intersections, never present at runtime — are how a middleware's knowledge reaches `createClient` without a byte of wire format. Two channels:

**The response side, `_out`.** Every respond helper returns a branded `Response`; `json` is the type-carrying one:

```ts
export function json<T = unknown, S extends number = 200>(
  ctx: Ctx,
  data: T,
  init?: ResponseInit & { readonly status?: S }
): JsonResponse<T, S>;

// JsonResponse<T, S> = Response & { readonly _out?: T; readonly _status?: S }
```

**The request side, `_in`.** A gate that validates input brands itself with what it proved, so the client can *demand* it. `jsonBody` from `s200/validate`:

```ts
export function jsonBody<T>(
  parse: (data: unknown) => T,
  options?: ValidateOptions
): Middleware & { readonly _in?: { readonly json: T } };
```

**The flow.** Route registrars thread every route into a phantom log carried by the app's own type — `get` / `post` / … append one entry per route:

```ts
App<S, [...R, {
  readonly method: 'GET'; readonly pattern: P;
  readonly in: ChainIn<Ms>;     // every gate's _in brand, intersected
  readonly out: ResolveOut<O>;  // the handler's _out (unknown for plain Responses)
  readonly status: ResolveStatus<O>;
}]>
```

`createClient(app)` reads that log back: response `.json()` resolves to `out` — `unknown`, never `any`, when unbranded — and `.status` narrows to the branded literals. A `json` brand types **and requires** `init.body`; a `query` brand (from `queryParams`) narrows `init.query`. Several gates in one chain intersect: `jsonBody` + `queryParams` yields both a typed body and a typed query on the same route.

### A worked battery, before and after

A complete gate battery, in the shape the built-ins use:

```ts
/**
 * API-key gate: rejects requests whose key is missing or unknown.
 *
 * @module
 */
import { defineMiddleware, httpError } from 's200';
import type { Ctx, Middleware } from 's200';

export type RequireApiKeyOptions = {
  /** Keys that unlock the route. */
  readonly keys: readonly string[];
  /** Header the key arrives in; default `x-api-key`. */
  readonly header?: string;
  /** Revocation or policy hook; default: membership in `keys`. */
  readonly verify?: (key: string, ctx: Ctx) => boolean | Promise<boolean>;
};

export function requireApiKey(options: RequireApiKeyOptions): Middleware {
  const header = options.header ?? 'x-api-key';
  const verify = options.verify ?? ((key: string) => options.keys.includes(key));
  return defineMiddleware(async (ctx, next) => {
    const key = ctx.req.headers.get(header);
    if (key === null || !(await verify(key, ctx))) {
      // Rendered by the in-chain error boundary — the unwind still sees
      // the 401: CORS stamps it, the logger logs it.
      throw httpError(401, 'invalid api key');
    }
    return next();
  });
}
```

**Before** — no gate, unbranded response. The client works but proves nothing:

```ts
import { createApp, get } from 's200';
import { createClient } from 's200/client';

const app = get(createApp(), '/me', (ctx) =>
  new Response(JSON.stringify({ user: 'ada', scopes: ['read'] }), {
    headers: { 'content-type': 'application/json' },
  })
);

const me = await (await createClient(app).get('/me')).json();
//    ^? unknown — the body is real, its shape unproven
```

**After** — the gate in the chain, `json` as the responder:

```ts
import { createApp, get, json } from 's200';
import { createClient } from 's200/client';

const app = get(
  createApp(),
  '/me',
  requireApiKey({ keys: [SECRET] }),
  (ctx) => json(ctx, { user: 'ada', scopes: ['read'] })
);

const me = await (await createClient(app).get('/me')).json();
//    ^? { user: string; scopes: string[] }
```

And the request side — the same route log types what callers must send:

```ts
import { createApp, httpError, json, post } from 's200';
import { jsonBody } from 's200/validate';
import { createClient } from 's200/client';

const app = post(
  createApp(),
  '/users',
  jsonBody((data): { name: string } => {
    if (typeof data !== 'object' || data === null || !('name' in data)) {
      throw httpError(422, 'expected { name: string }');
    }
    return data as { name: string };
  }),
  (ctx) => json(ctx, { ok: true }, { status: 201 })
);

createClient(app).post('/users', { body: { name: 'ada' } });
//                                             ^ typed — and required:
// omit init.body and the call no longer compiles
```

### Branding your own gate

If your gate proves something about the request, declare the brand on the factory's return type. The `_in` phantom is optional, so the raw middleware satisfies it structurally — this is exactly how `jsonBody` and `queryParams` are declared:

```ts
import { httpError, readJson } from 's200';
import type { Ctx, Middleware } from 's200';

export function signedBody<T>(
  parse: (data: unknown) => T,
  verify: (data: unknown, signature: string | null, ctx: Ctx) => boolean
): Middleware & { readonly _in?: { readonly json: T } } {
  return async (ctx, next) => {
    const data = await readJson(ctx);
    const signature = ctx.req.headers.get('x-signature');
    if (!verify(data, signature, ctx)) {
      throw httpError(401, 'bad signature');
    }
    ctx.state.payload = parse(data);
    return next();
  };
}
```

One boundary to know: `createClient` retypes only the `json` and `query` members of `in`. A custom member still flows into the route log, but the client ignores it — reuse the `json` member shape when your gate validates a JSON body.

## Structure conventions

Open any built-in battery and the same skeleton appears. Follow it — consumers read your battery with trained eyes.

**Module `@module` JSDoc.** The file opens with a block comment stating what the battery does, its scope limits, and any order sensitivity, ending in `@module`. `src/cors.ts` documents *why* the stamping runs on the unwind; `src/etag.ts` documents the byte-backed scope (an explicit `content-length`) and what is skipped (streams, 206 range responses).

**Options are `readonly`, defaulted once.** Every member `readonly`; the factory signature is `f(options: XOptions = {})`; defaults resolve at construction, so the per-request closure closes over plain values:

```ts
export type EtagOptions = { readonly strong?: boolean };
```

**Injectable seams.** Anything nondeterministic (time, randomness, storage) or policy-laden (identity, verification, output) is a parameter:

| Seam | Used by | What it buys |
|---|---|---|
| `store` | `rateLimit`, `cache` | state shared across instances behind a small contract (`RateLimitStore.hit`, `CacheStore.get/set/delete`), with an in-process default |
| `now` | `rateLimit` | deterministic tests, replayed clocks |
| `key` | `rateLimit` | identity policy — IP, user id, API key |
| `sink` / `format` | `logger` | where lines go and how they read |
| `verify` | `basicAuth`, `bearerAuth`, `jwtAuth` | the decision is the caller's; the battery is the policy shell |
| schema / `parse` | `validate`, `query` | zod, valibot, typebox injected — never imported |

**State slots.** Request-scoped hand-offs live on `ctx.state` under a documented key (`validated`, `requestId`, `jwt`, `csrfToken`). Stay on the default `State` and your `Middleware` plugs into any app, including per-app `createApp<MyState>()` ones.

**Reuse, but not through the barrel.** `csrf` needs cookie reads and form parsing, so it imports `getCookie` / `setCookie` from the cookies module and `readForm` from the body module — sibling modules directly, never the core barrel. In-repo, a barrel import would drag the whole core into the battery's entry and defeat the separate entry; direct sibling imports let the build share one core chunk across entries. In your package the same discipline applies one level up: import from the narrowest published entry (`s200/cookies`, not a kitchen-sink re-export), because tree-shaking starts at the import statement.

## Testing

Drive the app through `request()` from `s200/test` — it dispatches through `handle()` in-process with full semantics: scoped middlewares, fallbacks, the error boundary. No network, no server, real `Response`s.

```ts
import { describe, expect, it } from 'vitest';
import { createApp, get, json } from 's200';
import { request } from 's200/test';
import { requireApiKey } from './require-api-key.js';

describe('requireApiKey', () => {
  const app = get(
    createApp(),
    '/me',
    requireApiKey({ keys: ['k'] }),
    (ctx) => json(ctx, { ok: true })
  );

  it('rejects a missing key with 401', async () => {
    const res = await request(app, '/me');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid api key' });
  });

  it('accepts a listed key', async () => {
    const res = await request(app, '/me', { headers: { 'x-api-key': 'k' } });
    expect(res.status).toBe(200);
  });
});
```

`testClient(app)` covers the typed round-trip when your battery brands routes. The injected seams are what keep tests deterministic — pass a fake `now`, an in-memory `store`, a canned `verify`, and nothing needs timers or network to wiggle.

## Publishing

**Naming.** `s200-<thing>` unscoped, or `@you/s200-<thing>` — the prefix is what a user scans for.

**Peer, not dependency.** The host provides the runtime:

```json
{
  "name": "s200-api-key",
  "type": "module",
  "sideEffects": false,
  "exports": {
    ".": {
      "import": { "types": "./dist/index.d.mts", "default": "./dist/index.mjs" },
      "require": { "types": "./dist/index.d.ts", "default": "./dist/index.cjs" }
    }
  },
  "peerDependencies": { "s200": "*" }
}
```

The dual `import` / `require` shape mirrors the built-ins' entries; `"sideEffects": false` keeps the module tree-shakable. If your battery wants zod or a signing library, the s200 pattern is stronger than a peer dependency: make it a *parameter* (`verify`, a schema) and import nothing — that is how `validate` stays zero-dependency while speaking zod, valibot, and typebox through Standard Schema.

Size expectations come with the territory: built-in batteries ship between roughly 0.5 and 1.6 kB gzipped, each guarded by its own size-limit budget. Aim for the same order.

**Upstream inclusion.** Batteries that earn generality graduate into the framework. That wiring is a maintainer job — a `package.json` exports subpath, a `vite.config.mts` lib entry, and a size-limit budget per entry: the three lines that keep "import one, pay for one" honest. Bring the battery and its request-driven tests; the repository does the wiring.

## Checklist

Walk the list before publishing:

- Zero runtime dependencies — `dependencies` is empty; peers at most.
- Data + functions — no `class`, no `this`, no `new` of your own types (platform constructors are fine; the repo enforces this on itself with `pnpm check:paradigm`).
- Own entry — importing the battery pulls only it; no re-export of the core barrel.
- Options `readonly` and defaulted once, at construction.
- Nondeterminism and policy injected: `store`, `now`, `key`, `verify`, `sink`, …
- Shape chosen and documented in the `@module` header — gate (answers in place, the chain below never runs) or stamper (`ctx.res` after `await next()`, always set).
- Request-scoped data on `ctx.state` under a documented key.
- Respond through `json` / `text` / `html` so `_out`, `_status`, and `content-length` ride along; brand your gate's `_in` if it proves something about the request.
- Tests drive `request(app, …)`; seams faked, no timers or sockets.
- The rejection contract is named — status, body shape, headers — for gates; the skip conditions are named for stampers.
