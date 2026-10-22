# Serverless Adapters (`s200/aws-lambda`, `s200/vercel`)

AWS Lambda and Vercel invoke the app behind a platform-specific entry — these adapters build that entry from `handle`, so the same app deploys to either unchanged.

## AWS Lambda (`s200/aws-lambda`)

For API Gateway HTTP APIs and Lambda function URLs — payload format **v2 only** (the REST API v1 event and its `multiValueHeaders` are not supported).

```ts
// src/lambda.ts
import { createLambdaHandler } from 's200/aws-lambda';
export const handler = createLambdaHandler(app);
```

Point the function at `<file>.handler` — a function URL or an HTTP API Lambda proxy integration both speak v2. `createLambdaHandler(app)` returns `(event, context?) => Promise<LambdaResultV2>`; the `context` parameter is accepted and ignored (the v2 result shape has no use for it). The event/result types (`LambdaEventV2`, `LambdaResultV2`, `LambdaHandler`) are exported and fully structural — no `@types/aws-lambda` dependency.

### Event mapping

| Event field (v2)                | Request side                                                            |
| ------------------------------- | ----------------------------------------------------------------------- |
| `requestContext.http.method`    | request method                                                          |
| `headers` (v2 lowercases names) | request headers                                                         |
| `cookies`                       | joined with `"; "` into one `Cookie` header                             |
| `host` header                   | URL host (`https://` scheme; falls back to `localhost`)                 |
| `rawPath` / `rawQueryString`    | URL path and query, passed through un-re-encoded                        |
| `body` + `isBase64Encoded`      | request body — base64-decoded when flagged; absent `body` means no body |

Only the fields above are read — `routeKey`, `version`, and the rest of `requestContext` pass through unused.

### Result mapping

| Response                                      | Result field (v2)                                       |
| --------------------------------------------- | ------------------------------------------------------- |
| status                                        | `statusCode`                                            |
| each `Set-Cookie`                             | one `cookies` array entry — never merged into `headers` |
| other headers (duplicates merged with `", "`) | flat `headers` record                                   |
| textual body                                  | `body` string, `isBase64Encoded: false`                 |
| any other body                                | base64 `body`, `isBase64Encoded: true`                  |
| null body (204/304, …)                        | no `body`                                               |

Textual means `text/*`, JSON (including `+json` suffixes), JavaScript, XML (including `+xml`), and `application/x-www-form-urlencoded` — plus an absent `content-type`. Any `content-encoding` other than `identity` forces base64: the [compress](/api/response-batteries) battery's gzip turns text types binary.

[`onFinish`](/api/node#onfinish) callbacks run when the adapter finishes buffering the result — `{ aborted: false }`, unless the response body itself failed mid-read (`{ aborted: true }`, and the error rethrows for the runtime to report).

## Vercel (`s200/vercel`)

Both the Edge Runtime and Node.js — including Fluid Compute — use the plain Web Standard handler shape:

```ts
// api/index.ts
import { createVercelHandler } from 's200/vercel';
export default createVercelHandler(app);
```

`createVercelHandler(app)` → `(request: Request) => Promise<Response>` — `handle` under the platform's entry name, carrying the same wiring as the other edge adapters: the runtime's request signal (client disconnect on the Edge Runtime) threads into `ctx.signal` via feature detection, and [`onFinish`](/api/node#onfinish) callbacks ride the response body — cancel → `{ aborted: true }`, completion → `{ aborted: false }`, exactly once.

For the Edge Runtime, opt the route in with `export const config = { runtime: 'edge' };`. Node.js needs nothing — it is the default runtime.

## Limitations

- Lambda: payload v2 only — the REST API v1 event and `multiValueHeaders` are not translated (use an HTTP API or function URL).
- Connection upgrades (`s200/websocket`) need a long-lived socket, which serverless platforms do not offer — the upgrade path is unreachable on both adapters.
