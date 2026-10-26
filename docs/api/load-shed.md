# Load Shedding (`s200/load-shed`)

Pressure-gated admission — the `@fastify/under-pressure` role, zero dependencies, no background timers. `loadShed()` checks optional thresholds on entry — event-loop utilization, resident memory, in-flight request count — and when any configured dimension is strictly over, throws a `503` `HttpError` (`{"error":"Service Unavailable"}` with a `Retry-After` advice header) into the app's error boundary: the handler never runs, and the unit spends its remaining budget on requests it already accepted instead of queueing more.

```ts
import { loadShed } from 's200/load-shed';

use(app, loadShed({
  maxEventLoopUtilization: 0.95,
  maxRssBytes: 512 * 1024 * 1024,
  maxInFlight: 200,
  retryAfterSeconds: 2,
  bypass: (ctx) => ctx.url.pathname === '/healthz',
}));
```

## How it decides

- The check runs on entry, before `next()`. The **first** configured dimension strictly over sheds; a reading exactly at the threshold passes.
- A dimension without a threshold is not checked — its sensor is never even read.
- The in-flight count is a **ledger, not a sample**: incremented on entry, decremented in a `finally` when the request settles (handler resolved, handler errored, or shed 503). The incoming request counts — `maxInFlight: 200` lets the 200th concurrent request in and sheds the 201st — and the count recovers the moment the chain drains.
- `bypass` skips the whole gate: the request is neither counted nor checked. Shedding a liveness probe tells the platform the unit is dead exactly when it needed breathing room.
- The 503 is materialized in-chain like every s200 gate, so middlewares registered outside it (logger, cors, request-id) observe the real status on their unwind; a configured `onError` owns the wire answer instead.

`Retry-After` is advice, not a promise: recovery time under pressure is unknowable without a sensor, so the header carries `retryAfterSeconds` (default `1`) and clients that honor it back off one interval and retry.

## `LoadShedOptions`

| Field | Default | Meaning |
| --- | --- | --- |
| `maxEventLoopUtilization` | — | Shed when the event-loop busy ratio is strictly above this (0..1) |
| `maxRssBytes` | — | Shed when resident memory is strictly above this many bytes |
| `maxInFlight` | — | Shed when the in-flight count is strictly above this (the incoming request counts) |
| `retryAfterSeconds` | `1` | The `Retry-After` header on the 503, in seconds (positive integer) |
| `bypass` | — | `(ctx) => boolean` — `true` and the request is neither counted nor checked |
| `sensors` | built-ins | Per-dimension reader overrides — see `LoadShedSensors` |

Invalid bounds throw a plain `Error` at creation (a bad threshold is a programmer error, not a runtime failure): `maxEventLoopUtilization` must be in `(0, 1]`, `maxRssBytes`/`maxInFlight` positive, `retryAfterSeconds` a positive integer.

## Sensors

Every dimension's reader is injectable — tests drive the gate with fake readings instead of manufacturing real load, and multi-instance deployments can point all shards at one shared counter. `LoadShedSensors`:

| Field | Default | Meaning |
| --- | --- | --- |
| `eventLoopUtilization` | incremental `performance.eventLoopUtilization()` diff | `() => number` — busy ratio 0..1 since the previous check; the reading spans exactly the gap between requests (or across background work between them), no timer wakes the loop, and a zero-elapsed diff reads as `0`, never `NaN` |
| `rssBytes` | `process.memoryUsage().rss` | `() => number` — resident set size in bytes |
| `inFlight` | the middleware's own ledger | `() => number` — requests currently in flight; inject to enforce a cap measured upstream or shared across instances (the internal ledger keeps running regardless) |

One sensor per dimension keeps the wiring local — a `s200/unit-metrics` bundle already measures all three, so its `snapshot()` bridges in three lambdas:

```ts
import { createUnitMetrics } from 's200/unit-metrics';
import { loadShed } from 's200/load-shed';

const m = createUnitMetrics();
use(app, m.middleware);
use(app, loadShed({
  maxEventLoopUtilization: 0.95,
  maxRssBytes: 512 * 1024 * 1024,
  sensors: {
    eventLoopUtilization: () => m.snapshot().eventLoopUtilization,
    rssBytes: () => m.snapshot().rss,
    inFlight: () => m.snapshot().inFlight,
  },
}));
```

## Keep the probes alive

Pair `bypass` with the health battery's `createGate` so the probes stay answerable both under pressure and during a graceful drain — shedding traffic and draining connections are different emergencies, and the probe must survive both:

```ts
import { createGate, health, readiness } from 's200/health';
import { loadShed } from 's200/load-shed';

const gate = createGate();
use(app, loadShed({
  maxEventLoopUtilization: 0.95,
  bypass: (ctx) =>
    ctx.url.pathname === '/healthz' || ctx.url.pathname === '/ready',
}));
get(app, '/healthz', health);
get(app, '/ready', readiness({ gate: gate.check }));
```

## Known limits

- The default ELU reading is a diff between consecutive checks — as fresh as the traffic. A unit under no requests at all never re-reads it, so a purely background saturation trips on the first request that does arrive (the diff then covers the busy gap), not before.
- Default sensors are per-process. A cap that must hold across instances needs an injected sensor backed by the shared source of truth.
