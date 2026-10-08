# Observability (`s200/logger`, `s200/request-id`, `s200/otel`, `s200/version`)

Request logging, correlation ids, OpenTelemetry-shaped tracing/metrics, and API version negotiation.

## Logger (`s200/logger`)

One line per request through a pluggable `sink`/`format`. The status is always the real one — fallbacks **and error responses** are materialized inside the chain, so the logger sees every request, including 500s.

```ts
use(app, logger());   // ISO-time METHOD path status duration
```

`LoggerOptions`:

| Field | Default | Meaning |
| --- | --- | --- |
| `sink` | `console.log` | `(line: string) => void` |
| `format` | `ISO-time METHOD path status duration` | `(ctx, durationMs) => string` |

## Request id (`s200/request-id`)

Canonical request-correlation id per request: incoming ids are honored (proxies stamp their own), missing ones generated. The id is exposed on `ctx.state.requestId` and stamped onto the response — error responses included.

```ts
use(app, requestId());
```

`RequestIdOptions`:

| Field | Default | Meaning |
| --- | --- | --- |
| `header` | `'x-request-id'` | Request/response header name |
| `generator` | `crypto.randomUUID()` | `() => string` |

## OTel (`s200/otel`)

Two middlewares with **structural** (subset) types — a subset of `@opentelemetry/api`'s `Span`/`Tracer`/`Meter`/`Counter`/`Histogram`, so a real OTel object satisfies them and bridging is a lambda. Zero dependencies: W3C trace-context parsing stays user-side.

### `trace(options?)` — one span per request

Started before `next()`, finished on the unwind (the in-chain error boundary materializes every response first, so the recorded `http.response.status_code` is always the real one). Attributes set on the unwind: `http.request.method`, `url.path`, `http.response.status_code`, `s200.duration_ms`. Status mapping follows the OTel HTTP semantic conventions: `>= 500` → ERROR (`code: 2`), otherwise UNSET. When `next()` rejects, the span records the exception, sets ERROR, ends, and rethrows.

`TraceOptions`:

| Field | Default | Meaning |
| --- | --- | --- |
| `tracer` | built-in no-op | `Tracer` — `startSpan(name, { attributes?, parentContext? }) => Span` |
| `attributes` | — | Static attributes stamped on every span at `startSpan` time |
| `spanName` | `` `${method} ${pathname}` `` | `(ctx) => string` |
| `extract` | — | `(headers: Headers) => unknown` — distributed-context hook; its opaque return passes through as `parentContext` (e.g. parse `traceparent` with your tracer's propagation API) |

```ts
import { trace } from 's200/otel';
import { propagation } from '@opentelemetry/api';
use(app, trace({
  tracer: { startSpan: (name, opts) => otelTracer.startSpan(name, { attributes: opts?.attributes }, opts?.parentContext) },
  extract: (headers) => propagation.extract(headers, { get: (c, k) => c.get(k) ?? undefined }),
}));
```

### `metrics(options?)` — HTTP server metrics

`MetricsOptions`:

| Field | Default | Meaning |
| --- | --- | --- |
| `meter` | built-in no-op | `Meter` — `createCounter(name, opts?) => Counter`, `createHistogram(name, opts?) => Histogram` |
| `attributes` | — | Static record or per-request callback — spread over the defaults, so it can add (`url.route`, `service.name`) or override them |
| `now` | `performance.now` | Clock override |

Structural instrument types: `Counter` = `{ add(value, attributes?) }` (compatible with OTel's `UpDownCounter` — `add(+1)`/`add(-1)` balances the same), `Histogram` = `{ record(value, attributes?) }`. `InstrumentOptions`: `{ description?, unit?, advice?: { explicitBucketBoundaries? } }`. `AttributeValue`: `string | number | boolean | readonly (string | number | boolean)[]`.

## API version (`s200/version`)

NestJS-style version negotiation as a gate middleware. Two header-borne strategies; the resolved version lands on `ctx.state.version` before `next()` runs, and the response carries `Vary` naming the negotiated header so shared caches key per version. URI versioning is deliberately not rebuilt — `mount(app, '/v1', v1App)` is the router-native equivalent.

```ts
use(app, apiVersion({ versions: ['1', '2'], default: '1' }));
// header strategy:  x-api-version: 2
// mediaType strategy: Accept: application/vnd.api+json;version=2
```

`ApiVersionOptions`:

| Field | Default | Meaning |
| --- | --- | --- |
| `strategy` | `'header'` | `'header'` (a dedicated header) or `'mediaType'` (a `version` parameter on the vendor JSON type) |
| `header` | `'x-api-version'` | Header name for the `'header'` strategy |
| `mediaType` | `'vnd.api'` | Vendor subtype for `'mediaType'` — matches `application/<mediaType>+json` entries in Accept |
| `versions` | (required, non-empty) | Supported versions, matched exactly (case-sensitive) |
| `default` | — | Version assumed when the request carries none; without it, a versionless request answers `404 API version required` |

An unsupported version answers `404` in place — the handler never runs.
