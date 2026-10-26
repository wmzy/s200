# Circuit breaker (`s200/circuit-breaker`)

A circuit breaker as plain data + functions: after enough admitted failures inside a sliding window the breaker trips `open` and rejects calls for a cooldown, then admits a bounded number of probes (`half-open`) — one straggler failure re-trips, a streak of successes closes the circuit again. Made to wrap the upstream calls a reverse proxy makes (see [Circuit breaking](./proxy.md#circuit-breaking) in `s200/proxy`), but it guards any async operation — database calls, sub-service fetches, anything that can fail repeatedly.

The state is one mutable data object created by `createCircuitBreaker`; every function operates on it. No locks anywhere: JavaScript runs one call at a time per event loop, and every phase transition happens synchronously inside a `canPass`/`record*` call — concurrent callers only interleave at `await` points they own (the wrapped `fn`), by which point admission was already decided.

## `createCircuitBreaker` — the machine as data

```ts
import { createCircuitBreaker } from 's200/circuit-breaker';

const upstream = createCircuitBreaker({
  failureThreshold: 5,
  windowMs: 10_000,
  cooldownMs: 30_000,
});
```

Builds a breaker in `closed` phase. Options are validated here — non-positive numbers throw a plain `Error` — and frozen onto the state's `options`; nothing validates twice. All timestamps live in the injected clock's frame (epoch ms by default).

| `CircuitBreakerOptions` | Meaning | Default |
| --- | --- | --- |
| `failureThreshold` | Admitted failures inside `windowMs` that trip `open` | `5` |
| `windowMs` | Sliding failure-counting window (ms) — a failure expires exactly this long after it landed, so the count is never burstable at window edges | `10_000` |
| `cooldownMs` | How long `open` rejects before probes are admitted | `30_000` |
| `successesNeeded` | Consecutive probe successes that close a `half-open` breaker | `2` |
| `probeConcurrency` | Probe calls admitted concurrently while `half-open` | `1` |
| `errorFilter` | Failure filter — `false` passes through without accruing | every thrown value counts |
| `now` | Clock override (tests, deterministic replays) | `Date.now` |

## `breakerCall` — the one-liner face

```ts
import { breakerCall } from 's200/circuit-breaker';

const body = await breakerCall(upstream, () => fetch(upstreamUrl).then((r) => r.text()));
```

Wraps one async call in the breaker's policy. Admission: a rejected call never runs `fn` — the rejection is a 503 `HttpError` (`{"error":"Service Unavailable"}`) carrying `Retry-After` as the seconds of cooldown left (a `half-open` slot rejection answers `1` — a probe is out, not a cooldown). Inside an app this flows to the error boundary exactly like `s200/rate-limit`'s 429: `onError` can take over, and the wrapped work never ran.

Outcome: the value passes through on success; the underlying error passes through untouched on failure — the breaker records it (through `errorFilter`) but never translates, wraps, or swallows it.

## `canPass` + `recordSuccess`/`recordFailure` — the no-throw face

```ts
import { canPass, recordFailure, recordSuccess } from 's200/circuit-breaker';

if (canPass(upstream)) {
  try {
    const value = await load();
    recordSuccess(upstream);
    return value;
  } catch (error) {
    recordFailure(upstream, error);
    throw error;
  }
}
return fallback(); // your answer, no 503 involved
```

For callers that want the policy without the 503 — their own fallback response, queue, or drop. `canPass` is a sync probe: `true` means a call may run now; in `half-open` a `true` reserves one of the `probeConcurrency` slots — settle every admitted call exactly once with a `record*`, or the slot leaks until the next trip. `recordFailure` returns whether the error counted (the filter's verdict); a filtered-out error still releases its probe slot, it just accrues nothing.

## `skipClientErrors` — the 4xx-tolerant filter

```ts
import { createCircuitBreaker, skipClientErrors } from 's200/circuit-breaker';

const upstream = createCircuitBreaker({ errorFilter: skipClientErrors });
```

The ready-made `errorFilter`: an `HttpError` the client caused (status < 500) does not count — the upstream answered that request, it did not fail — while 5xx answers, network errors, and plain exceptions do. The canonical pairing with `s200/proxy`: a proxied 404 is the caller's truth, not the upstream dying.

## `circuitStatus` — dashboards and logs

```ts
import { circuitStatus } from 's200/circuit-breaker';

const { phase, failures, successes, probesInFlight, openedAt, retryAtMs } =
  circuitStatus(upstream);
```

A frozen snapshot of the live machine — the phase a `canPass` would see right now (the lazy `open` → `half-open` transition applied), plus the counters a dashboard wants: live failure count, half-open success streak, outstanding probes, the epoch of the last trip, and the earliest epoch a call is admitted again. A report, not the state: mutating it changes nothing.

## Semantics

- **Three phases.** `closed` admits everything and counts admitted failures in a sliding `windowMs` window; at `failureThreshold` it trips `open`. `open` admits nothing until `cooldownMs` has elapsed. `half-open` admits up to `probeConcurrency` probes: any counted failure re-trips `open` immediately (cooldown restarted), `successesNeeded` consecutive successes close the breaker with a fresh failure window.
- **The window slides, successes never erase.** A failure expires exactly `windowMs` after it landed (no fixed boundary — not burstable at window edges); a success in `closed` is a no-op. Closing after probing clears the window: the new `closed` era starts from zero.
- **`open` → `half-open` is lazy.** No timer fires; the first `canPass`/`record*`/`circuitStatus` after the cooldown elapsed is the one that moves the phase. With no traffic the breaker stays nominally `open` at zero cost.
- **Admission is slot-based.** `canPass` returning `true` in `half-open` reserves a slot; the matching `record*` releases it. A probe that never settles (a hung call) leaks its slot — pair with the timeout battery so every admitted call settles exactly once.
- **Straggler probes.** With `probeConcurrency` > 1, a probe that settles after a sibling already re-tripped the breaker counts against whatever phase is live when it settles. Keep concurrency at `1` (the default) for exact accounting under concurrency.
- **Filtered errors still settle admission.** The `errorFilter` decides whether a failure accrues; it never skips the bookkeeping of the call that already happened.
