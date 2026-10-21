# Security (`s200/cors`, `s200/csrf`, `s200/auth`, `s200/jwt`, `s200/secure-headers`, `s200/rate-limit`, `s200/trust-proxy`)

CORS, CSRF, authentication gates, JWTs, baseline headers, sliding-window rate limiting, and reverse-proxy awareness.

## CORS (`s200/cors`)

App-level or per-route. Preflights are answered in place with a `204` (the handler never runs); actual responses get the allow-origin headers stamped on the unwind — fallback 404/405/500 responses included, since they are materialized inside the chain.

```ts
use(app, cors({ origin: 'https://app.example', credentials: true }));
```

`CorsOptions`:

| Field | Default | Meaning |
| --- | --- | --- |
| `origin` | `'*'` | Fixed origin, allowlist, or per-request resolver `(ctx) => string \| undefined` |
| `methods` | echoes request | Preflight `Access-Control-Allow-Methods` |
| `headers` | echoes request | Preflight `Access-Control-Allow-Headers` |
| `exposeHeaders` | — | `Access-Control-Expose-Headers` so page scripts can read custom response headers |
| `credentials` | `false` | `Access-Control-Allow-Credentials` |
| `maxAge` | — | Preflight cache lifetime |

The default `'*'` emits the literal wildcard and skips `Vary: Origin`; allowlists and resolvers reflect the request origin and set `Vary: Origin`. Browsers refuse credentialed wildcard origins (fail-closed) — pair `credentials` with an explicit origin.

## CSRF (`s200/csrf`)

Session-less synchronizer tokens: HMAC-signed (`nonce` + expiry) so only your secret can mint one, delivered in a cookie and verified on unsafe requests against the header/form field **and** the request `Origin` — or, when `Origin` is absent (same-origin form posts often omit it), `Sec-Fetch-Site: cross-site`, which is rejected outright while `same-origin`/`same-site`/`none` fall through to the token check (closing both classic double-submit holes):

```ts
const csrf = createCsrf({ secret: CSRF_SECRET });   // keep the secret out of version control
use(app, csrf.middleware);
get(app, '/form', (ctx) => html(ctx, `<input type="hidden" name="_csrf" value="${await csrf.token(ctx)}">`));
```

`CsrfOptions`:

| Field | Default | Meaning |
| --- | --- | --- |
| `secret` | (required) | HMAC secret (`string` or bytes) |
| `cookie` | `'csrf_token'` | Cookie name carrying the token |
| `header` | `'x-csrf-token'` | Header presenting the token |
| `form` | `'_csrf'` | Form field presenting the token |
| `ttl` | 7 days | Token lifetime (seconds) |
| `bind` | — | Callback returning a request-scoped value (e.g. the session id) folded into the token's HMAC at mint **and** at verify, so a token minted for another session/user no longer verifies |
| `path` / `sameSite` / `httpOnly` / `secure` | `'/'` / `'lax'` / `true` / — | Cookie attributes; keep `httpOnly` and deliver the token via an endpoint or server-rendered form |

`Csrf`: `{ middleware, token, issueToken }` — `middleware` guarantees a valid token in `ctx.state.csrfToken` on safe requests (refreshing the cookie when needed — including one minted for another `bind` value) and verifies `Origin`/`Sec-Fetch-Site` + presented token on unsafe ones (403 in place); `token(ctx)` returns the request's valid cookie token (or a fresh one) to embed in forms; `issueToken(ctx)` mints a **fresh** token for the current request (new nonce, full TTL, current `bind` value) and the middleware persists it as the response cookie, unsafe responses included — the rotate-on-login primitive. Minting is stateless: the previous token stays valid until its own TTL, so pairing `bind` with a fresh session id is what retires the old token.

## Auth (`s200/auth`)

`basicAuth` / `bearerAuth` gates: the `verify` function decides; failures answer `401` + `WWW-Authenticate` in place and the chain below never runs. Credential comparison inside `verify` is yours — use a constant-time compare for secrets.

```ts
use(app, basicAuth(async (user, pass) => user === 'admin' && (await check(pass))));
use(app, bearerAuth(async (token) => token === API_TOKEN));
```

| Function | Signature |
| --- | --- |
| `basicAuth(verify, options?)` | `verify(username, password, ctx) => boolean \| Promise<boolean>` |
| `bearerAuth(verify, options?)` | `verify(token, ctx) => boolean \| Promise<boolean>` |

`BasicAuthOptions` / `BearerAuthOptions`: `{ realm?: string }` — the 401 challenge realm, default `'s200'`.

## JWT (`s200/jwt`)

HS256/384/512, RS256/384/512, PS256/384/512, and ES256/384/512 over WebCrypto, zero dependencies.

| Function | Meaning |
| --- | --- |
| `signJwt(payload, key, options?)` | Compact JWT `header.payload.signature`; claims from options override same-named payload keys |
| `verifyJwt<T>(token, key, options?)` | Verifies structure, algorithm, signature, `exp`/`nbf`, requested `aud`/`iss` → `T & RegisteredClaims`; throws `JwtError` on any failure |
| `jwtAuth(options)` | Gate middleware: extracts the token (header `Authorization: Bearer …`, or a cookie), verifies, stores the payload on `ctx.state.jwt`; missing/invalid → `401` |
| `createJwksResolver(url, options?)` | Builds a `KeyResolver` over a JWKS endpoint — fetches, caches (`ttlMs`, default 5 min), picks by `kid`; a `kid` miss on an unexpired cached document forces exactly one refetch before failing (rotation races); cached per URL module-wide in an LRU bounded at 50 endpoints |
| `isJwtError(error)` | `JwtError` predicate |

| Type | Meaning |
| --- | --- |
| `JwtAlgorithm` | `'HS256' \| … \| 'ES512'` |
| `JwtKey` | `string \| Uint8Array \| CryptoKey \| JsonWebKey` |
| `JwtSignOptions` | `{ alg?, expiresIn?, notBefore?, issuedAt? \| false, audience?, issuer?, subject?, jwtId? }` — `alg` required when signing with a `CryptoKey`/JWK |
| `JwtVerifyOptions` | `{ algorithms?, audience?, issuer?, clockTolerance?, requireExpiry?, keyStore? }` — `alg:none` is rejected unconditionally |
| `RegisteredClaims` | `{ iat?, exp?, nbf?, iss?, sub?, aud?, jti? }` |
| `JwtHeader` | `{ alg, kid? }` — what a `KeyResolver` sees |
| `KeyResolver` | `(header: JwtHeader) => JwtKey \| Promise<JwtKey>` |
| `JwtKeyStore` | `{ get(key), set(key, promise) }` — key-import cache; default in-process LRU, bounded at 100 entries |
| `JwksOptions` | `{ ttlMs?, fetchFn?, store? }` |
| `JwksStore` | `{ get(url), set(url, entry) }` — JWKS document cache; default in-process LRU, bounded at 50 URLs |
| `JwksEntry` | `{ exp, keys }` — one cached document; `exp` is the ms-epoch refresh deadline |
| `JwtAuthOptions` | `{ secret?, key?, keyResolver?, jwks?, keyStore?, algorithms?, audience?, issuer?, clockTolerance?, requireExpiry?, header?, prefix?, cookie?, verify? }` — the `jwtAuth` gate's options (table below) |

`JwtAuthOptions` (the `jwtAuth` gate):

| Field | Default | Meaning |
| --- | --- | --- |
| `secret` | — | HMAC secret (`string` or bytes) — one of `secret`/`key`/`keyResolver`/`jwks` is required unless `verify` is given |
| `key` | — | Static key material (`CryptoKey`/JWK for RS/PS/ES, a secret for HS) |
| `keyResolver` | — | Per-token key resolution (rotation, multi-issuer) |
| `jwks` | — | JWKS endpoint — `string` or `{ url, ttlMs?, store? }`; shorthand for `createJwksResolver` |
| `algorithms` | every supported one | Algorithms the gate accepts |
| `audience` | — | Required audience(s) — the token's `aud` must intersect |
| `issuer` | — | Required issuer(s) |
| `clockTolerance` | `0` | Clock skew tolerance in seconds for `exp`/`nbf`/`iat` |
| `requireExpiry` | `false` | Reject tokens carrying no numeric `exp` claim |
| `header` | `'authorization'` | Header carrying the token |
| `prefix` | `'Bearer '` | Scheme prefix stripped from the header value |
| `cookie` | — | Cookie name to fall back to when the header is absent |
| `verify` | — | Custom verification (another library, exotic tokens) — the returned value lands on `ctx.state.jwt` |
| `keyStore` | — | Key-import store forwarded to `verifyJwt`; bypasses the default cache |

Key families must match the header algorithm (HS needs a secret, RS/PS an RSA key, ES an EC key — the confusion attack is structurally closed). `jwtAuth` key sources: `secret`, `key`, `keyResolver`, `jwks` (`string` or `{ url, ttlMs?, store? }`), or a custom `verify` (another library, exotic tokens — the returned value lands on `ctx.state.jwt`).

Both module-wide caches are bounded LRUs — **100 imported keys** and **50 JWKS endpoints**. Crossing a bound drops the least recently used entry (an evicted key is re-imported, an evicted document refetched, on demand), so attacker-shaped key material or issuer URL sets cannot grow memory without bound. Multi-tenant deployments with more than 50 trusted issuers — or fleets that should share one cache — should inject their own stores: `verifyJwt`'s `keyStore` (and `jwtAuth`'s, which forwards it) takes a `JwtKeyStore` over imported-key promises, while `createJwksResolver` and the `jwks` shorthand take a `JwksStore` over `{ exp, keys }` entries (TTL refresh still applies on read). An injected store bypasses the in-process default entirely and owns its own bounds — back it with Redis the same way as the rate-limit/session stores.

```ts
const token = await signJwt({ sub: userId }, JWT_SECRET, { expiresIn: 3600 });
use(app, jwtAuth({ secret: JWT_SECRET }));
get(app, '/me', (ctx) => json(ctx, ctx.state.jwt));
// Key rotation: use(app, jwtAuth({ jwks: 'https://idp.example/.well-known/jwks.json' }));
// Shared/bounded externally: use(app, jwtAuth({ jwks: { url, store: redisJwksStore } }));
```

## Secure headers (`s200/secure-headers`)

A safe-by-default baseline stamped on the unwind (fallback responses included); headers the response already carries are never overwritten, and `false` drops one:

```ts
use(app, secureHeaders());  // nosniff, DENY framing, strict-origin-when-cross-origin, COOP/CORP same-origin
```

`SecureHeadersOptions`:

| Field | Default | Meaning |
| --- | --- | --- |
| `xContentTypeOptions` | `'nosniff'` | `false` drops it |
| `xFrameOptions` | `'DENY'` | `SAMEORIGIN` for embedding apps (or a CSP frame-ancestors policy) |
| `referrerPolicy` | `'strict-origin-when-cross-origin'` | |
| `strictTransportSecurity` | off | Opt-in — behind a TLS-terminating proxy a stray HSTS header can pin a domain to a broken setup |
| `contentSecurityPolicy` | off | Opt-in — a raw header value or a directives object |
| `permissionsPolicy` | off | Opt-in — same shapes as CSP |
| `crossOriginOpenerPolicy` | `'same-origin'` | `false` drops it |
| `crossOriginResourcePolicy` | `'same-origin'` | `false` drops it |
| `crossOriginEmbedderPolicy` | off | Opt-in — COEP requires every subresource to opt in via CORP/CORS, which typically breaks CDN images/scripts until they send CORP headers |
| `xDnsPrefetchControl` | off | Opt-in (e.g. `'off'`) |
| `removeHeaders` | none | Headers stripped from every response — baseline defaults and handler-set headers alike, e.g. `['x-powered-by']` |

The directives-object form serializes CSP-style: `key value` (arrays space-joined), directives joined by `; `, keys in insertion order, an empty array rendering the bare key — `{ 'default-src': ["'self'"], 'upgrade-insecure-requests': [] }` becomes `default-src 'self'; upgrade-insecure-requests`. Permissions-Policy's parenthesised comma syntax (`camera=(), geolocation=(self)`) is a raw string away.

`cspNonce(): string` — a cryptographically random 128-bit standard-base64 nonce (24 chars) for `'nonce-…'` CSP sources. Generate one per request in a middleware registered after `secureHeaders` — its unwind runs first, so the per-request CSP lands before the static fill-only pass:

```ts
use(app, secureHeaders());
use(app, async (ctx, next) => {
  const nonce = cspNonce();
  await next();
  ctx.res?.headers.set(
    'content-security-policy',
    `default-src 'self'; script-src 'nonce-${nonce}'`,
  );
});
```

Embed the same nonce in the HTML (`<script nonce="…">`) so the policy and the markup agree.

## Rate limit (`s200/rate-limit`)

True sliding-window gate per client key: every hit expires `windowMs` after it landed (no fixed boundary, so window edges can't burst). The over-limit request is answered in place with `429` + `Retry-After`; the chain below never runs.

```ts
use(app, rateLimit({ windowMs: 60_000, limit: 100 }));
```

`RateLimitOptions`:

| Field | Default | Meaning |
| --- | --- | --- |
| `windowMs` | `60_000` | Window length in ms |
| `limit` | `60` | Requests per window per key |
| `key` | first `x-forwarded-for` hop | Identity selector `(ctx) => string` — pass your own (and a `now` clock for tests) |
| `now` | `Date.now` | Clock override |
| `store` | in-process deque per key | Shared counters across instances: a `RateLimitStore` — `hit(key, now, limit, windowMs) => RateLimitHit \| Promise<RateLimitHit>` — must be atomic per key (the Redis INCR + PEXPIRE shape) |

`RateLimitHit`: `{ count: number; retryAt: number }` — live count and the earliest retry time. The default store is per-instance; shared limits need an injected `store`.

## Trust proxy (`s200/trust-proxy`)

Corrects `ctx.url`'s protocol/host from `X-Forwarded-Proto`/`X-Forwarded-Host` and records the client address in `ctx.state.proxy`, with hop counting for `X-Forwarded-For` (values picked right-to-left, skipping untrusted hops). Register it **before** `s200/csrf`, `s200/secure-headers`, and anything that builds absolute URLs:

```ts
use(app, trustProxy({ hops: 1 }));   // behind one trusted reverse proxy
```

`TrustProxyOptions`: `{ hops? (default 1), protoHeader?, hostHeader?, forHeader? }`. The `ctx.state.proxy` entry (`TrustProxyInfo`): `{ proto?, host?, clientIp? }` — augment `State` with `TrustProxyState` to read it typed.
