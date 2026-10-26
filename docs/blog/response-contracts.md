# Don't ship a response that lies: runtime contract checking

Your API documentation makes a promise: this endpoint answers 200 with
an object that has an `id`. Every integration, every SDK, every LLM
tool built on that document inherits the promise — and the moment a
handler ships `{ ident: 7 }`, the promise breaks quietly. The idea of
checking responses against a schema before they ship is not new;
what is new is how long you have had to wait for it in the mainstream
Node frameworks. Fastify has planned "validate response with Ajv
before serializing" for its v6 milestone, and as of late October 2026
that line is still at `6.0.0-alpha.5`; Hono's v5 — itself still in
release candidate — lists response validation as a v5 feature. s200's
[`response-check`](/api/response-check) battery covers that axis today, on the
`SerializeSchema` contract; this piece shows what enforcing
it actually takes: one annotation you already have, one middleware,
and a deliberately narrow scope.

## The contract is data you already have

s200's response contract lives in the same annotation store as
everything else — the `describeRoute` metadata that drives the
[OpenAPI 3.1 document](/api/openapi):

```ts
import { createApp, describeRoute, get, json, use } from 's200';
import { responseCheck } from 's200/response-check';

const app = createApp();

get(app, '/users/:id', (ctx) => json(ctx, { id: Number(ctx.params.id) }));
describeRoute(app, 'GET', '/users/:id', {
  summary: 'Fetch one user',
  responses: {
    200: {
      description: 'ok',
      schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    },
  },
});

use(app, responseCheck(app));
```

That is the whole wiring. `responses[200].schema` was already what
`openapiSpec` documents; now the server enforces it too. One source of
truth for the spec, the docs, and the behavior — the same property
`withRouteValidation` gives the request side, mirrored onto the
response side.

## What gets checked — and what deliberately does not

The check runs on the unwind, against the materialized response, so it
sees exactly what the client will receive. A response is checked only
when all of these hold:

- its route matched (`ctx.route` — 404/405 fallbacks never check);
- the route's annotation declares a schema for the response's actual
  status — unannotated routes and statuses pay one lookup;
- the content-type is JSON (`application/json`, parameters ignored, or
  any `…+json` vendor type);
- the body is byte-backed — an explicit `content-length`, the same
  detection `s200/etag` uses. Streamed responses (`s200/streaming`,
  SSE, chunked) are skipped, never buffered; bodyless responses
  (204/304/HEAD) too.

That last bullet is a contract, not a limitation to work around: the
respond helpers (`json`, `jsonRaw`) advertise an explicit
`content-length`, so a normal JSON route is always checkable, while a
bare `new Response(JSON.stringify(…))` — which platforms serialize
lazily, with no content-length — passes through unchecked. If you want
a route checked, write it with the helpers.

When a response does get checked, the body is read once, parsed, and
validated with `checkSchema` (`s200/serialize`) — the closed-shape
validator whose `additionalProperties: false` reading matches exactly
what `serialize` emits on output: **undeclared keys are violations**,
not noise. A JSON-typed body that fails to parse is itself a root-level
mismatch (`{ path: [], message: 'invalid JSON body' }`) — a response
that claims JSON and ships something else breaks the contract like any
type error does.

Whatever the outcome, the response is rebuilt **verbatim** — the read
consumed the body, so the same bytes, status, and headers
(content-length included) are written back. A conforming response is
byte-identical to what would have shipped without the battery; there is
no "checked" tax on the happy path.

## Fail loud, or report quietly

```ts
use(app, responseCheck(app));                        // fail (default): mismatch → 500
use(app, responseCheck(app, { details: true }));     // 500 body names the issue paths
use(app, responseCheck(app, {                        // keep the response, report instead
  onMismatch: 'report',
  onIssue: (issues, ctx) => log.warn('contract drift', { path: ctx.url.pathname, issues }),
}));
```

The `'fail'` default throws an `httpError(500, 'Response schema
mismatch')` on the unwind — through the normal error mapping, so your
`onError` policy answers it and the client sees a 500 instead of the
lying body. `details: true` attaches the issue paths to that 500 body
(`{ error, issues: [{ path, message }, …] }`) — keep it for development
and staged environments, because the paths name internal response
structure you may not want public. `'report'` keeps the response and
hands every issue to `onIssue` — the drift-detection mode: your
dashboards learn the contract is drifting before your clients do.

Two interplay rules worth knowing:

- **With `compress`**, register the check after it
  (`use(app, compress()); use(app, responseCheck(app))`) — the unwind
  runs reverse, so the check reads the uncompressed JSON before
  compress rewrites it.
- **With route transforms**, the check deliberately reads the *live*
  route off `ctx.route` rather than capturing anything at creation
  time — `withRouteValidation` rebuilds route objects (re-attaching
  annotations), and a captured route would go stale. Describe,
  transform, and both gates stay in force together.

## Honest limits

- The check runs on the unwind, so it observes the final response — a
  middleware registered further out could still rewrite it afterwards.
- It is a runtime contract, not a type layer: it never changes what
  `s200/client`'s callers see (that is the compile-time channel), and
  it does not type your handler's return values.
- Only JSON is checked, by design — HTML, binary, and streaming
  surfaces have no `SerializeSchema` contract to enforce.

The framing to take away: response validation spent years as a roadmap
item because the mainstream frameworks had no single place where "the
documented contract" lived — it had to be reconciled between route
definitions, serializers, and spec emitters first. In s200 the
reconciliation was done once, in the annotation store, so the runtime
gate fell out of it. The API reference has the full surface:
[`s200/response-check`](/api/response-check); the request-side twin and
the spec emitter it shares data with live under
[OpenAPI & tooling](/api/openapi).
