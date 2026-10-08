# Package surface

## The core barrel

Everything is a named export from the core barrel (`s200`) — tree-shaking starts at the import statement (`defineMiddleware`, the third-party battery authoring hook, lives there too).

## Package entries

Each below is a separate package entry — importing one pulls exactly it. Every name links to its section in the [API Reference](/api/core):

- **Core barrel**: [`s200`](/api/core) — `createApp`, the router primitives, the respond/body/static helpers
- **Adapters**: [`s200/node`](/api/node), [`s200/bun`](/api/bun), [`s200/deno`](/api/edge#deno-s200-deno), [`s200/cloudflare`](/api/edge#cloudflare-workers-s200-cloudflare)
- **Security**: [`s200/cors`](/api/security#cors-s200-cors), [`s200/csrf`](/api/security#csrf-s200-csrf), [`s200/auth`](/api/security#auth-s200-auth), [`s200/jwt`](/api/security#jwt-s200-jwt), [`s200/secure-headers`](/api/security#secure-headers-s200-secure-headers), [`s200/rate-limit`](/api/security#rate-limit-s200-rate-limit), [`s200/trust-proxy`](/api/security#trust-proxy-s200-trust-proxy)
- **Request intake**: [`s200/validate`](/api/request#validate-s200-validate), [`s200/query`](/api/request#query-s200-query), [`s200/accepts`](/api/request#accepts-s200-accepts), [`s200/multipart`](/api/request#multipart-s200-multipart), [`s200/upload`](/api/request#upload-s200-upload)
- **Response batteries**: [`s200/serialize`](/api/response-batteries#serialize-s200-serialize), [`s200/etag`](/api/response-batteries#etag-s200-etag), [`s200/compress`](/api/response-batteries#compress-s200-compress), [`s200/streaming`](/api/response-batteries#streaming-s200-streaming)
- **Cookies & sessions**: [`s200/cookies`](/api/cookies-session#cookies-s200-cookies), [`s200/session`](/api/cookies-session#sessions-s200-session)
- **Observability**: [`s200/logger`](/api/observability#logger-s200-logger), [`s200/request-id`](/api/observability#request-id-s200-request-id), [`s200/otel`](/api/observability#otel-s200-otel), [`s200/version`](/api/observability#api-version-s200-version)
- **Data & config**: [`s200/cache`](/api/data#cache-s200-cache), [`s200/config`](/api/data#config-s200-config), [`s200/events`](/api/data#events-s200-events), [`s200/schedule`](/api/data#schedule-s200-schedule)
- **Realtime**: [`s200/websocket`](/api/websocket#registration-s200-websocket), [`s200/websocket/node`](/api/websocket#node-s200-websocket-node), [`s200/websocket/bun`](/api/websocket#bun-s200-websocket-bun)
- **OpenAPI & tooling**: [`s200/route-table`](/api/openapi#route-table-s200-route-table), [`s200/meta`](/api/openapi#metadata-s200-meta), [`s200/openapi`](/api/openapi#openapi-s200-openapi), [`s200/swagger`](/api/openapi#swagger-ui-s200-swagger), [`s200/codegen`](/api/openapi#codegen-s200-codegen), [`s200/client`](/api/openapi#client-s200-client), [`s200/test`](/api/openapi#test-s200-test)
- **Lifecycle**: [`s200/lifecycle`](/api/lifecycle#lifecycle-s200-lifecycle), [`s200/health`](/api/lifecycle#health-s200-health), [`s200/timeout`](/api/lifecycle#timeout-s200-timeout), [`s200/dev`](/api/lifecycle#hot-reload-s200-dev)
- **Sharding & execution**: [`s200/shard`](/api/sharding#shard-s200-shard), [`s200/gateway`](/api/sharding#gateway-s200-gateway), [`s200/shard-dev`](/api/sharding#dev-dispatcher-s200-shard-dev), [`s200/executor`](/api/sharding#executor-s200-executor), [`s200/unit-metrics`](/api/sharding#unit-metrics-s200-unit-metrics)

## Dependencies

The core and every battery except `s200/events` are zero-dependency; `s200/events` adds [`@for-fun/event-emitter`](https://www.npmjs.com/package/@for-fun/event-emitter) as its single dependency.

## JSR

A `jsr.json` is maintained — `pnpm publish:jsr` publishes the built dist to [JSR](https://jsr.io) as `@wmzy/s200`.

Every entry's exports, signatures, and options are documented in the [API Reference](/api/core).
