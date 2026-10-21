# The unwind tax: what middleware actually costs

Every framework benchmark you have seen advertises the same thing: the
middleware-free floor. A `GET /` returning `{"message":"hello"}`, zero
middleware, keep-alive client, requests per second. Those numbers are real,
but they measure dispatch plus the adapter floor — and real applications
are not floor-shaped. A production request typically unwinds three to five
middleware links (cors, request-id, logger, auth, cache), and several of
them want to write a response header *after the handler has already run*.

That write is not free — and its cost depends on an architectural choice
each framework made before you wrote a single line: what happens to the
response object when middleware touches it on the way out. This article
walks through the three answers, the measured prices, and the honest
caveats. Full methodology lives in [benchmarks](/benchmarks);
framework-by-framework positioning in [comparison](/comparison).

## The floor is not your app

Our `hello`/`param` benchmark rows — like most published numbers — are
two-route apps with zero middleware. They measure routing dispatch and the
adapter floor: the cost of constructing the framework's request/response
objects and handing bytes to the socket. On that floor, the fastest class
is whichever framework avoids the platform's `Request`/`Response`
constructors — fastify plumbs raw `IncomingMessage`s, elysia ships its own
lightweight classes, and hono's default node adapter replaces the globals
with its own (`hono-patched` in our tables).

Mount a chain, and every link that stamps a header on the way out has to
answer one question: *where is the response right now?* Three answers
exist. Each has a price.

## Three ways to write a header after the handler ran

**Rebuild the response.** hono's middleware writes headers through the
context — `await next(); c.header(…)`. Once the handler's `Response`
exists, each such write re-materializes the response: once per header
write. Five links, five header writes, five rebuilds per request.

**Mutate the response in place.** s200's chain contract guarantees
`ctx.res` already exists when `next()` resolves — handler responses,
fallbacks (404/405/500), and error responses are all materialized
in-chain. So an s200 link simply mutates the existing `Response`'s
headers: `ctx.res.headers.set(…)`. No rebuild, no copy, no store. The same
contract is what lets the logger/cors/request-id batteries observe and
stamp the *real* response on the unwind — errors included.

**Store now, serialize later.** express (`res.setHeader`), fastify
(`reply.header` in hooks), and elysia (`ctx.set.headers[…]`) write into a
header store applied when the response is serialized at the end. No
rebuild either — but there is no Web Standard `Response` mid-chain; the
headers ride the final flush, and what middleware observes on the way out
is the store, not a response object.

None of these is cheating. They are different points on one design grid:
who owns the response, when it exists, what middleware can see. They are
not equally cheap.

## The shapes

The benchmark's `mw` scenario runs the same five-link chain in each
framework's idiomatic middleware — work-equivalent (each link reads the
`x-test` request header and sets one response header; the third also
stores a `performance.now()` delta into the per-request context) but not
mechanically identical. Source of truth: `scripts/bench-http.mjs`.

s200 — the true unwind, header written on the materialized response:

```js
const mwLink = (i) => (ctx, next) => {
  ctx.req.headers.get('x-test');
  return next().then(() => {
    ctx.res.headers.set(`x-mw-${i}`, String(i));
  });
};
use(
  app,
  '/mw',
  mwLink(1),
  mwLink(2),
  (ctx, next) => {
    ctx.req.headers.get('x-test');
    const t0 = performance.now();
    return next().then(() => {
      ctx.state.elapsed = performance.now() - t0;
      ctx.res.headers.set('x-mw-3', '3');
    });
  },
  mwLink(4),
  mwLink(5)
);
get(app, '/mw', (ctx) => json(ctx, { message: 'hello' }));
```

hono — also a true unwind, but the header write goes through the context:

```js
const mwLink = (i) =>
  app.use('/mw/*', async (c, next) => {
    c.req.header('x-test');
    await next();
    c.header(`x-mw-${i}`, String(i));
  });
mwLink(1);
mwLink(2);
app.use('/mw/*', async (c, next) => {
  c.req.header('x-test');
  const t0 = performance.now();
  await next();
  c.header('x-mw-3', '3');
  c.set('elapsed', performance.now() - t0);
});
mwLink(4);
mwLink(5);
app.get('/mw', (c) => c.json({ message: 'hello' }));
```

express — store-and-serialize. Note the `setHeader` happens on the way
*in*; because serialization is deferred to unwind, it is equivalent to
writing at unwind (the third link's timing store still runs after
`next()`):

```js
const mwLink = (i) => (req, res, next) => {
  req.headers['x-test'];
  res.setHeader(`x-mw-${i}`, String(i));
  next();
};
app.use('/mw', mwLink(1), mwLink(2));
app.use('/mw', (req, res, next) => {
  req.headers['x-test'];
  const t0 = performance.now();
  res.setHeader('x-mw-3', '3');
  next();
  req.elapsed = performance.now() - t0;
});
app.use('/mw', mwLink(4), mwLink(5));
app.get('/mw', (_req, res) => res.json({ message: 'hello' }));
```

fastify — async `onRequest` hooks in an encapsulated `register` scope
(fastify hooks are per-plugin), writing into the reply's header store:

```js
await app.register(async (instance) => {
  for (let i = 1; i <= 5; i++) {
    if (i === 3) {
      instance.addHook('onRequest', async (request, reply) => {
        const t0 = performance.now();
        request.headers['x-test'];
        reply.header('x-mw-3', '3');
        request.elapsed = performance.now() - t0;
      });
    } else {
      instance.addHook('onRequest', async (request, reply) => {
        request.headers['x-test'];
        reply.header(`x-mw-${i}`, String(i));
      });
    }
  }
  instance.get('/mw', async () => ({ message: 'hello' }));
});
```

elysia — its `onRequest` hooks cannot be scoped (they fire for the whole
instance, verified), so the scoped equivalent is a five-link
`guard({ beforeHandle })` chain writing `set.headers`:

```js
const mwLinks = {
  beforeHandle: [1, 2, 3, 4, 5].map((i) =>
    i === 3
      ? (ctx) => {
          const t0 = performance.now();
          ctx.request.headers.get('x-test');
          ctx.set.headers['x-mw-3'] = '3';
          ctx.elapsed = performance.now() - t0;
        }
      : (ctx) => {
          ctx.request.headers.get('x-test');
          ctx.set.headers[`x-mw-${i}`] = String(i);
        }
  ),
};
app.guard(mwLinks, (scoped) => scoped.get('/mw', () => ({ message: 'hello' })));
```

## The numbers

Canonical run against the final 2026-09-30 dist (same machine as the
reference table — AMD Ryzen 7 8745HS, Fedora 42 — now on Node v26.10.0,
so absolute numbers are **not comparable** to the Node 22 reference in
[benchmarks](/benchmarks)):

| framework     | hello (same run) | mw      | mw vs hello |
| ------------- | ---------------- | ------- | ----------- |
| s200          | 10308 req/s      | 9590    | −7%         |
| s200-light    | 14760 req/s      | 13718   | −7%         |
| hono          | 12278 req/s      | 10250   | −17%        |
| hono-patched  | 17904 req/s      | 9313    | −48%        |
| express       | 11840 req/s      | 10841   | −8%         |
| fastify       | 17590 req/s      | 16681   | −5%         |
| elysia        | 16846 req/s      | 15428   | −8%         |

Single `hello` cells wobble up to ~±10% run to run — read single-cell
deltas as approximate and the ordering as the signal.

## Reading the table

The `mw vs hello` column is where the three patterns separate:

- **fastify loses almost nothing** (−5%; ~0–5% across runs): its hook
  chain is plain function calls appending to a header store. The floor
  lead survives middleware.
- **elysia and express pay a modest chain cost** (−8% each): same store
  pattern, a bit more plumbing per link.
- **hono drops −17%** (−17–18% across runs): `c.header()` after
  `await next()` re-materializes the response once per header write.
- **hono-patched collapses −48%** (−46% in other runs): with the cheap
  patched floor there is nothing expensive left to amortize against, so
  the rebuild dominates everything else — and `mw` throughput lands
  *below* unpatched hono (9313 vs 10250). The fastest `hello` row becomes
  the slowest `mw` row; the mw ordering is fastify 16681 > elysia 15428 >
  s200-light 13718 > express 10841 > hono 10250 > s200 9590 >
  hono-patched 9313.
- **s200 drops −7%** (−7–9% across runs): it writes headers after the
  handler like hono does, but mutates the existing `Response` in place —
  no rebuild — landing in express's neighborhood despite the richer
  per-request context. The same in-place path is what the built-in
  batteries use: request-id stamps its header through `setHeader(ctx, …)`,
  which after `await next()` is a direct `ctx.res.headers.set`.
- **s200-light keeps its floor almost untouched** (−7%, within the
  hello-cell noise) and holds the light-vs-normal ratio at **~1.43×**
  under middleware load: cheap `LightHeaders` writes make the chain
  nearly free on top of an already-cheap response — third place on
  absolute `mw` despite a floor below the patched class.

## What this means when choosing a framework

**Do not buy the floor.** If your app is middleware-shaped — cors plus
request-id plus logger plus auth is already four links writing or reading
headers at unwind — the hello-world ranking tells you about the adapter,
not about your workload. hono-patched's ~1.5× floor inverts under this
chain; fastify's survives, because its store-and-serialize never touches
a response object until the end.

**Each pattern buys something with its speed.** Store-and-serialize is
fast and cheap, but middleware never sees a real response — no Web
Standard object to read, clone, or hand to platform APIs mid-chain. The
rebuild pattern keeps the Web Standard surface but pays per header at
unwind. In-place mutation keeps the Web Standard surface *and* makes the
unwind write cheap; its price is paid earlier, in the floor — s200
constructs the platform's real `Response`, which is exactly the cost the
patched class avoids (see [benchmarks](/benchmarks) for the floor
decomposition).

**This is one axis.** Throughput class is a single row of the
[comparison](/comparison) table. Paradigm, typing, batteries, runtime
portability, and ecosystem are the others — a framework that loses 8% on
a chain but saves you a dependency tree may still be the right trade.
The point of this piece is narrower: know which pattern you are buying,
because the benchmark that sold you the framework probably did not test
it.

## The caveats, stated plainly

- **Idiomatic, not identical.** Each framework runs its own native chain
  shape, kept work-equivalent (same reads, writes, and timing store).
  express's link writes headers on the way in (store semantics make it
  unwind-equivalent); elysia's scoped equivalent is a post-routing guard
  because its `onRequest` hooks cannot be scoped. This asymmetry is the
  honesty tax on the table — and on any cross-framework middleware
  benchmark.
- **Snapshots, not guarantees.** One machine, warmed up, one server per
  child process so no framework's global patching contaminates another's
  row. Re-run on your hardware: `node scripts/bench-http.mjs --only mw`.
- **Five links is deliberately heavy.** Shorter chains shift every row
  back toward its own floor; heavier ones (more headers per link, body
  re-wrapping) amplify the rebuild pattern further.
- **A chain writing one header per link is still a friendly workload.**
  It isolates the unwind write; it does not model body transformation,
  streaming, or error paths.
