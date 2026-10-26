# Reverse proxy (`s200/proxy`)

Fetch-based reverse-proxy primitives — the runtime hop that completes s200's gateway story. `s200/gateway` generates the nginx/K8s/ALB configs, `s200/shard-dev` dispatches across in-process shards, and this module forwards real traffic: stream a request to an upstream URL over `fetch`, hand the upstream response back, hop-by-hop headers stripped both ways. See the [sharding & scheduling guide](../guides/sharding.md) for the layer above.

## `proxyRequest` — the low-level forward

```ts
import { proxyRequest } from 's200/proxy';

get(app, '/legacy', (ctx) => proxyRequest(ctx, 'http://127.0.0.1:8080/legacy'));
```

Forwards `ctx`'s request to an absolute `target` URL and returns the upstream response with hop-by-hop headers stripped. Callers own `ctx.res`: a handler returns the result, a middleware assigns it. Pending `setHeader` values drain onto the returned response, so headers stamped earlier in the chain (request-id, security headers) ride the proxied response too.

| `ProxyInit` | Meaning | Default |
| --- | --- | --- |
| `headers` | Extra upstream request headers, applied after the forwarded set — an explicit header (`authorization`, `accept-encoding`) wins | — |
| `signal` | An extra abort source, composed with `ctx.signal` via `AbortSignal.any` | `ctx.signal` alone |
| `preserveHost` | Forward the incoming `host` header verbatim | `false` (dropped; runtime pins Host from the target URL) |
| `clientAddress` | The address appended to `x-forwarded-for`: a string, or a per-request resolver | omitted → existing chain passes untouched |
| `redirect` | Upstream redirect mode | `'manual'` (3xx passes through, `Location` verbatim) |

## `createProxy` — prefix dispatch as a middleware

```ts
import { createProxy } from 's200/proxy';

use(app, '/api', createProxy({
  upstream: 'http://127.0.0.1:8080',
  rewrite: (p) => p.replace(/^\/api/, '') || '/',
}));
```

Every request that reaches the middleware is forwarded to `upstream` (origin + optional path prefix + rewritten pathname + the incoming search) and the upstream response becomes `ctx.res`. The middleware is a terminal — it never calls `next()` — so the `use` prefix above is the dispatch: everything under `/api` is now the upstream's, with `rewrite` typically stripping the mount prefix.

| `CreateProxyOptions` | Meaning | Default |
| --- | --- | --- |
| `upstream` | Base URL of the upstream — origin plus optional path prefix; its own query/hash are a setup error (the request's query is what ships) | required |
| `rewrite` | Rewrites the pathname before forwarding | identity |
| `preserveHost` | See `ProxyInit.preserveHost` | `false` |
| `clientAddress` | See `ProxyInit.clientAddress` | omitted |

## Semantics

- **Streaming, no buffering.** The request body (`ctx.req.body`) is handed to `fetch` with `duplex: 'half'` — the upstream sees bytes as the client produces them; the response body stays a stream end to end. Proxying consumes the request body: a middleware that already read it (`readJson` & co) breaks the forwarding, and `proxyRequest` throws a plain `Error` saying so.
- **Hop-by-hop stripped both ways.** RFC 9110 §7.6.1 (`connection`, `keep-alive`, `proxy-authenticate`, `proxy-authorization`, `te`, `trailer`, `transfer-encoding`, `upgrade`) plus every token the incoming `connection` header names — from the request and from the response.
- **`x-forwarded-*` accumulates.** `x-forwarded-proto` and `x-forwarded-host` are appended from the incoming request; `x-forwarded-for` appends the address from `clientAddress` — a hop with no address to claim leaves the chain untouched rather than appending garbage (first-hop keying in `s200/rate-limit` and `s200/trust-proxy` stay honest).
- **`accept-encoding` pinned to `identity`.** The fetch transport transparently decodes content-codings, so a compressed upstream would pair a decoded body with stale `content-encoding`/`content-length` headers. Pinning identity keeps the proxied bytes and headers honest end to end; an explicit `accept-encoding` in `init.headers` overrides the pin.
- **Content-length is passed through, never fabricated.** Whatever length the upstream set rides along with the stream — the explicit-CL contract applies to bodies s200 creates, not pass-through responses. Bodyless statuses (204/205/304) ship with no body.
- **Host follows the fetch spec.** Spec-strict runtimes (undici/node, browsers) pin `Host` to the target URL's authority regardless of the forwarded header set; `preserveHost: true` forwards the incoming header verbatim — honored by runtimes that allow a caller-set Host (Bun), overridden on spec-strict ones. The reliable carrier of the original host is the appended `x-forwarded-host`.
- **No upgrade proxying.** Protocol upgrades (WebSockets) are not proxied — `fetch` has no upgrade path; terminate those with `s200/websocket` instead. No `Location` rewriting happens either: a 3xx passes through verbatim under the default `redirect: 'manual'`.

## Failure mapping

A `fetch` that rejects maps to `httpError` through the standard error boundary (`onError` and the in-chain response contract apply):

| Condition | Response |
| --- | --- |
| The linked signal aborted — client disconnect, or a timeout battery's deadline firing on `ctx.signal` | `499 Client Closed Request` (nginx's convention: the request's own side gave up, not the upstream) |
| Any other network failure — connection refused, DNS, TLS | `502 Bad Gateway` |

The transport detail (errno, TLS reason) stays internal — the client learns the mapping, not the topology.

## Circuit breaking

Wrap the forward in the `s200/circuit-breaker` battery so a dying upstream stops receiving traffic instead of stacking hopeless requests:

```ts
import { breakerCall, createCircuitBreaker, skipClientErrors } from 's200/circuit-breaker';
import { proxyRequest } from 's200/proxy';

const upstream = createCircuitBreaker({
  failureThreshold: 5,
  windowMs: 10_000,
  cooldownMs: 30_000,
  errorFilter: skipClientErrors,
});

get(app, '/api/*', (ctx) =>
  breakerCall(upstream, () =>
    proxyRequest(ctx, 'http://127.0.0.1:8080' + ctx.url.pathname + ctx.url.search)
  )
);
```

While the breaker is `open`, admission throws a 503 `HttpError` (`Retry-After` carries the cooldown left) into the error boundary — the upstream, its connection pool, and the client's timeouts are all spared. `skipClientErrors` lines up exactly with this module's failure mapping: a proxied 4xx/5xx page is a returned `Response` and never reaches the filter; only transport failures throw — a 502 (network failure) counts toward the threshold, a 499 (the client's own disconnect) does not, because the upstream never got the chance to answer.
