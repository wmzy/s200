# Errors

## Tagged data

Errors are tagged data, checked structurally — no `instanceof` chains across bundle boundaries:

```ts
import { httpError, isHttpError } from 's200';

throw httpError(422, 'Invalid article');

const app = createApp({
  onError: (ctx, error) => {
    const status = isHttpError(error) ? error.status : 500;
    json(ctx, { error: String((error as { message?: string }).message) }, { status });
  },
});
```

A fourth argument tags response headers onto the error — a gate's `WWW-Authenticate` challenge, `Retry-After`, the IETF `RateLimit-*` fields. The default mapping merges them onto the error response, so a rejection can flow into the error boundary (`onError` included) instead of being answered in place:

```ts
throw httpError(401, 'Unauthorized', { error: 'Unauthorized' }, {
  'www-authenticate': 'Basic realm="api"',
});
```

The model is three functions and one rule: `httpError(status, message, body?, headers?)` builds the tagged value (`status` an integer in `[400, 599]`, `body` riding through verbatim instead of the default `{ "error": message }` envelope), `isHttpError(error)` checks the tag structurally, and `toErrorResponse(error)` maps any thrown value to a `Response` — the same mapping the boundary applies, useful when you answer an error in place without a chain. The rule: **throw, don't hand-return** — a thrown `HttpError` reaches `onError` and stamps the unwind; a response you write yourself is just a response.

## Default mapping

Unhandled `HttpError`s render as `{ status, body: { "error": message } }`; anything else is logged via `console.error` and rendered as a generic 500 (never leaking internals). Provide `onError` to own the mapping (and the logging) instead — or just swap the sink, keeping the default mapping:

```ts
const app = createApp({ logError: (error) => log('error', { err: error }) });
```

## The boundary runs inside the chain

The route chain and the 404/405 fallbacks are wrapped in an inner error boundary: a thrown error is mapped to a response — the `HttpError`'s status and message, otherwise an anonymous 500 — *before* the unwind starts. The contract that buys you:

```ts
use(app, async (ctx, next) => {
  await next();
  // ctx.res is set here, always — a 500 from the handler below included.
  logger.info(`${ctx.req.method} ${ctx.url.pathname} → ${ctx.res?.status}`);
});
```

Middleware listed ahead of a crashing handler observes the real error response on the unwind: `logger` logs it, `cors` stamps it, `request-id` names it. This is also why `onError` is an app option and not an after-the-fact hook — it runs as part of the same materialization, inside the chain. A crashing middleware *outside* a route chain (an app-level `use`) is caught by the outer boundary and mapped through the same path.

`onError` declines by not writing: if it returns without materializing a response, the default mapping takes over. Write with the respond helpers (`json(ctx, …, { status })`) so `content-length` rides along; what sits in `ctx.res` when the outermost middleware returns is what the adapter sends.

## Gates throw — so `onError` owns their policy

Every built-in rejection takes the error-boundary path rather than answering in place: `basicAuth`/`bearerAuth` throw a 401 `HttpError` carrying the `WWW-Authenticate` challenge, `jwtAuth` a 401, `rateLimit` a 429 with `Retry-After` plus the IETF `RateLimit-*` fields, `csrf` a 403, the validation gates a 400 (bad JSON) or 422 (schema issues), `timeout` a 503. The practical consequence: your `onError` sees gate rejections and can restyle every one of them — swap the envelope, translate messages, emit one consistent error shape — without configuring each battery. The default mapping already merges each gate's headers, so doing nothing still answers the protocol-correct 401/429/503.

The reverse shape exists deliberately: a middleware that writes a response and returns without calling `next()` short-circuits (CORS preflight 204s, cached revalidations). That bypasses `onError` by design — reserve it for answers that are not errors.

## Declaring error branches with `throws`

`throws(401, 404)` is a zero-cost pass-through middleware that brands the route's error channel: the statuses become the route's declared error branches, so `s200/client`'s response union names them, `s200/openapi` documents them, and `s200/codegen` emits them into generated clients. With example bodies for generated clients and specs — the record form (values stash verbatim, doubling as shape examples):

```ts
get(app, '/users/:id', throws({ 404: { error: 'no such user' } }), (ctx) => …);
```

Declaring a branch is documentation with teeth — pair it with the throw that produces it (`httpError(404, …)` in the handler, or a gate in the chain).

## Validation's 422 shape

The validation gates (`jsonBody`, `queryParams`, and `withRouteValidation` from `s200/openapi`) reject through `validationError(scope, issues)` — one consistent body:

```json
{
  "error": "body.items.2.name: expected string, got number",
  "issues": [{ "path": "body.items.2.name", "message": "expected string, got number" }]
}
```

`error` keeps the first issue's summary (scope-qualified when the gate names the request location), `issues` carries the full list with formatted paths. Success bodies carry no `issues` key anywhere. Assert both keys in tests of your validation config — the full list is the point.

## Client-side narrowing

On the consumer side the union is the contract: `res.status` narrows `res.json()`'s type. With declared branches —

```ts
const client = createClient(app);
const res = await client.get('/users/:id', { id: '7' });
if (res.status === 404) {
  const body = res.json(); // typed as the declared 404 body
}
```

— the same discrimination your tests do with `res.status` on a `request()` response. Undeclared routes answer `unknown` bodies; `throws` is how you make the client's error handling as typed as its happy path.
