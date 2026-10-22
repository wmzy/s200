# Response Check (`s200/response-check`)

Runtime enforcement of the documented response contract: the `responses[status].schema` annotations `describeRoute` collects — the same shapes [`s200/openapi`](/api/openapi) documents — become checks the server actually runs, on the unwind, against the materialized response. One source of truth for the spec, the docs, and the behavior: a response that would lie to the client never ships.

```ts
import { responseCheck } from 's200/response-check';

use(app, responseCheck(app));                        // fail: mismatch → 500
use(app, responseCheck(app, { details: true }));     // 500 body names the issue paths
use(app, responseCheck(app, {                        // keep the response, report instead
  onMismatch: 'report',
  onIssue: (issues, ctx) => log.warn('contract drift', { path: ctx.url.pathname, issues }),
}));

describeRoute(app, 'GET', '/users/:id', {
  responses: { 200: { description: 'ok',
    schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } } },
});
```

## What gets checked

On the unwind, a response is checked when all of these hold:

- its route matched (`ctx.route` — 404/405 fallbacks never check);
- the route's annotation declares a schema for the response's status — unannotated routes and statuses pay one lookup;
- the content-type is JSON (`application/json`, parameters ignored, or any `…+json` vendor type);
- the body is byte-backed — an explicit `content-length`, the same detection `s200/etag` uses. Streamed responses (`s200/streaming`, SSE, chunked) are skipped, never buffered; bodyless responses (204/304/HEAD) too.

The body is read once, parsed, and checked with `checkSchema` (`s200/serialize`) — the closed-shape validator whose `additionalProperties: false` reading matches what `serialize` emits on output: **undeclared keys are violations**, not noise. A JSON-typed body that fails to parse is itself a root-level mismatch (`{ path: [], message: 'invalid JSON body' }`).

Whatever the outcome, the response is rebuilt **verbatim** — the read consumed the body, so the same bytes, status, and headers (content-length included) are written back. Conforming responses are byte-identical to what would have shipped without the battery.

## `ResponseCheckOptions`

| Field | Default | Meaning |
| --- | --- | --- |
| `onMismatch` | `'fail'` | `'fail'`: throws `httpError(500, 'Response schema mismatch')` on the unwind — the normal error mapping answers (`onError` included), so the client sees a 500 instead of the lying body. `'report'`: keeps the response and calls `onIssue` |
| `details` | `false` | Attach the issue paths to the `'fail'` 500 body: `{ error, issues: [{ path, message }, …] }` (dot-joined paths, root `''`). **Leaks internal response structure to clients** — keep it for development and staged environments |
| `onIssue` | — | `(issues, ctx) => void` — the `'report'` sink; receives every issue of one response plus its ctx. Never called in `'fail'` mode (the throw already carries the failure through `onError`/`logError`) |

## Interplay

- **`withRouteValidation`** (`s200/openapi`): the request-side twin over the same annotations. `responseCheck` reads the live route off `ctx.route`, so it keeps working across the transform's route rebuilds (annotations are re-attached) — describe, transform, and both gates stay in force.
- **`compress`**: register this battery AFTER it (`use(app, compress()); use(app, responseCheck(app))`) — the unwind runs reverse, so the check reads the uncompressed JSON before compress rewrites it.
- **Client typing**: this battery is a runtime contract only — it never changes `s200/client`'s response types (that is the compile-time `out`/`branches` channel).

## Known limits

- Streamed and content-length-less bodies are skipped by design — a bare `new Response(JSON.stringify(…))` carries no explicit content-length (platforms serialize it lazily); use the respond helpers (`json`/`jsonRaw`), which advertise it.
- The check runs on the unwind, so it observes the final response — a middleware further out could still rewrite it afterwards.
