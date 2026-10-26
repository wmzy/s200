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

`basicAuth` / `bearerAuth` gates: the `verify` function decides; failures throw a 401 `HttpError` carrying the `WWW-Authenticate` challenge into the error boundary — the default mapping answers `401 {"error":"Unauthorized"}` + challenge, and a configured `onError` takes over. The chain below never runs. Credential comparison inside `verify` is yours — use a constant-time compare for secrets.

`timingSafeEqual(a, b)` — exported from `s200/cookies` for exactly this — scans every byte of equal-length inputs and decides once at the end: a plain `===` leaks byte agreement through its runtime, letting an attacker forge a secret one character at a time. A length mismatch returns `false` immediately; a secret's length is public knowledge when the format is fixed (a digest, a signature), so it carries no secret bits.

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

HS256/384/512, RS256/384/512, PS256/384/512, ES256/384/512, and EdDSA (Ed25519) over WebCrypto, zero dependencies.

| Function | Meaning |
| --- | --- |
| `signJwt(payload, key, options?)` | Compact JWT `header.payload.signature`; claims from options override same-named payload keys |
| `verifyJwt<T>(token, key, options?)` | Verifies structure, algorithm, signature, `exp`/`nbf`, requested `aud`/`iss` → `T & RegisteredClaims`; throws `JwtError` on any failure |
| `jwtAuth(options)` | Gate middleware: extracts the token (header `Authorization: Bearer …`, or a cookie), verifies, stores the payload on `ctx.state.jwt`; missing/invalid → `401` |
| `createJwksResolver(url, options?)` | Builds a `KeyResolver` over a JWKS endpoint — fetches, caches (`ttlMs`, default 5 min), picks by `kid`; a `kid` miss on an unexpired cached document forces at most one refetch per cooldown (`min(ttlMs, 30s)`) before failing (rotation races; a refetch that still misses the `kid` leaves the cached document and its refresh deadline untouched); cached per URL module-wide in an LRU bounded at 50 endpoints |
| `isJwtError(error)` | `JwtError` predicate |

| Type | Meaning |
| --- | --- |
| `JwtAlgorithm` | `'HS256' \| … \| 'ES512' \| 'EdDSA'` |
| `JwtKey` | `string \| Uint8Array \| CryptoKey \| JsonWebKey` |
| `JwtSignOptions` | `{ alg?, expiresIn?, notBefore?, issuedAt? \| false, audience?, issuer?, subject?, jwtId? }` — `alg` required when signing with a `CryptoKey`/JWK |
| `JwtVerifyOptions` | `{ algorithms?, audience?, issuer?, clockTolerance?, requireExpiry?, keyStore? }` — `alg:none` is rejected unconditionally |
| `RegisteredClaims` | `{ iat?, exp?, nbf?, iss?, sub?, aud?, jti? }` |
| `JwtHeader` | `{ alg, kid? }` — what a `KeyResolver` sees |
| `KeyResolver` | `(header: JwtHeader) => JwtKey \| Promise<JwtKey>` |
| `JwtKeyStore` | `{ get(key), set(key, promise) }` — key-import cache; default in-process LRU, bounded at 100 entries. Keys are SHA-256 hex digests of the key material (never the raw secret); values are process-local, non-extractable `CryptoKey`s |
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
| `keyStore` | — | Key-import store forwarded to `verifyJwt`; bypasses the default in-process cache (digest keys, process-local `CryptoKey` values) |

Key families must match the header algorithm (HS needs a secret, RS/PS an RSA key, ES an EC key, EdDSA an Ed25519 OKP key — a JWK with `kty:'OKP'` and `crv:'Ed25519'` — the confusion attack is structurally closed). EdDSA runs wherever WebCrypto implements Ed25519 (stable in Node ≥ 20, current browsers); a runtime without it gets a clear `JwtError` from a one-time capability probe instead of the platform's opaque `NotSupportedError`. `jwtAuth` key sources: `secret`, `key`, `keyResolver`, `jwks` (`string` or `{ url, ttlMs?, store? }`), or a custom `verify` (another library, exotic tokens — the returned value lands on `ctx.state.jwt`).

Both module-wide caches are bounded LRUs — **100 imported keys** and **50 JWKS endpoints**. Crossing a bound drops the least recently used entry (an evicted key is re-imported, an evicted document refetched, on demand), so attacker-shaped key material or issuer URL sets cannot grow memory without bound. Multi-tenant deployments with more than 50 trusted issuers — or fleets that want one shared JWKS document cache — should inject their own stores. `createJwksResolver` and the `jwks` shorthand take a `JwksStore` over `{ exp, keys }` entries (TTL refresh still applies on read); those entries are plain JSON, so a Redis-backed `JwksStore` genuinely shares documents across processes. A `JwtKeyStore` is different: its values are `Promise<CryptoKey>` — process-local, non-extractable handles that cannot be serialized or shipped to Redis — so `verifyJwt`'s `keyStore` (and `jwtAuth`'s, which forwards it) customizes the in-process import cache instead (its bounds, its eviction policy, or an id→secret-material mapping the process imports itself). Cache keys are SHA-256 hex digests of the key material, never the raw secret, so a store that persists or logs its keys does not leak secrets. An injected store bypasses the in-process default entirely and owns its own bounds — back a `JwksStore` with Redis the same way as the rate-limit/session stores.

```ts
const token = await signJwt({ sub: userId }, JWT_SECRET, { expiresIn: 3600 });
use(app, jwtAuth({ secret: JWT_SECRET }));
get(app, '/me', (ctx) => json(ctx, ctx.state.jwt));
// Key rotation: use(app, jwtAuth({ jwks: 'https://idp.example/.well-known/jwks.json' }));
// Shared/bounded externally: use(app, jwtAuth({ jwks: { url, store: redisJwksStore } }));
```

## OAuth (`s200/oauth`)

OAuth 2.0 Authorization Code flow with PKCE (S256) as pure functions — you own the transport and storage. Park `state` and the verifier between the redirect and the callback (signed cookies work, `s200/cookies`), compare the query `state` strictly before exchanging, and inject `fetch` to mock or proxy the network. The OIDC recipe (`recipes/oidc.ts`) composes these primitives end to end.

```ts
const pkce = await createPkcePair();                  // verifier + S256 challenge
const state = randomState();                          // works as a nonce too
redirect(ctx, buildAuthorizeUrl(
  { authorizationEndpoint, clientId, redirectUri, scope: ['openid'] },
  { state, nonce, codeChallenge: pkce.codeChallenge }
));
// … on the callback, after comparing state:
const tokens = await exchangeCode(
  { tokenEndpoint, clientId, clientSecret, redirectUri },
  { code, codeVerifier: pkce.verifier }
);
```

| Function | Meaning |
| --- | --- |
| `createPkcePair()` | `{ verifier, codeChallenge }` — 64 random bytes → 86-char base64url verifier (RFC 7636 §4.1), challenge = `base64url(SHA-256(verifier))` (§4.2) |
| `randomState()` | 32 random bytes → 43 base64url characters (a state or a nonce) |
| `buildAuthorizeUrl(options, flow)` | Pure URL construction: `response_type=code`, client/redirect/scope, `state`/`nonce?`, `code_challenge` + `code_challenge_method=S256` (always S256, never `plain`); existing endpoint query survives, `extraParams` appended last |
| `exchangeCode(options, grant)` | POSTs the `authorization_code` grant with `code_verifier` (form-encoded); a `clientSecret` sends HTTP Basic, else `client_id` rides the body (public client); non-2xx or a payload without `access_token`/`token_type` throws a 502 `HttpError` |

| Type | Meaning |
| --- | --- |
| `OAuthAuthorizeOptions` | `{ authorizationEndpoint, clientId, redirectUri, scope?, extraParams? }` — arrays join with spaces; the parameter is omitted when absent |
| `OAuthAuthorizeFlow` | `{ state, codeChallenge, nonce? }` — the per-request values the redirect commits to |
| `OAuthTokenOptions` | `{ tokenEndpoint, clientId, clientSecret?, redirectUri, fetch? }` — injectable `fetch` defaults to the global |
| `OAuthTokens` | `{ accessToken, tokenType, expiresIn?, refreshToken?, scope?, idToken? }` — `idToken` rides for OIDC flows |
| `PkcePair` | `{ verifier, codeChallenge }` |

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
| `contentSecurityPolicy` | off | Opt-in — a raw header value, a directives object, or the nonce-carrying shape (below) |
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

Or let `secureHeaders` wire the nonce itself — pass the object shape:

```ts
use(app, secureHeaders({
  contentSecurityPolicy: {
    nonce: true,   // per-request nonce, parked on ctx.state.cspNonce
    policy: { 'default-src': ["'self'"], 'script-src': ["'nonce-{{nonce}}'"] },
  },
}));
get(app, '/', (ctx) => html(ctx, `<script nonce="${ctx.state.cspNonce as string}">…</script>`));
```

On entry a fresh nonce (from `cspNonce()`) parks on `ctx.state.cspNonce` — a string, from any handler — and on the unwind every `{{nonce}}` placeholder in the policy is replaced with it before the header lands. `reportOnly: true` stamps `Content-Security-Policy-Report-Only` instead. The fill-only contract holds: a CSP the response already carries wins, with the handler building its own from the parked nonce. Raw-string policies take placeholders too (`"script-src 'nonce-{{nonce}}'"`); `NonceCsp` is `{ nonce: true, reportOnly?, policy: Directives | string }`.

## Rate limit (`s200/rate-limit`)

True sliding-window gate per client key: every hit expires `windowMs` after it landed (no fixed boundary, so window edges can't burst). The over-limit request throws a 429 `HttpError` into the error boundary — the default mapping answers `429 {"error":"Too Many Requests"}` + `Retry-After`, and a configured `onError` takes over; the chain below never runs.

```ts
use(app, rateLimit({ windowMs: 60_000, limit: 100 }));
```

`RateLimitOptions`:

| Field | Default | Meaning |
| --- | --- | --- |
| `windowMs` | `60_000` | Window length in ms |
| `limit` | `60` | Requests per window per key |
| `key` | first `x-forwarded-for` hop | Identity selector `(ctx) => string` — pass your own (and a `now` clock for tests) |
| `skip` | — | `(ctx) => boolean` — `true` exempts the request entirely: no key computed, no store hit, nothing counted, never blocked — `next()` runs immediately (health checks, internal CIDRs) |
| `now` | `Date.now` | Clock override |
| `store` | in-process deque per key | Shared counters across instances: a `RateLimitStore` — `hit(key, now, limit, windowMs) => RateLimitHit \| Promise<RateLimitHit>` — must be atomic per key (the Redis INCR + PEXPIRE shape) |

`RateLimitHit`: `{ count: number; retryAt: number }` — live count and the earliest retry time. The default store is per-instance; shared limits need an injected `store`.

The 429 carries the IETF rate-limit headers (`RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` — draft-ietf-httpapi-ratelimit-headers) alongside `Retry-After`: integer strings, limit / `0` when blocked / seconds until the oldest blocking hit expires (same remainder as `Retry-After`). Header names are lowercase on the wire, like every HTTP/2 response header.

## Trust proxy (`s200/trust-proxy`)

Corrects `ctx.url`'s protocol/host from `X-Forwarded-Proto`/`X-Forwarded-Host` and records the client address in `ctx.state.proxy`, with hop counting for `X-Forwarded-For` (values picked right-to-left, skipping untrusted hops). Register it **before** `s200/csrf`, `s200/secure-headers`, and anything that builds absolute URLs:

```ts
use(app, trustProxy({ hops: 1 }));   // behind one trusted reverse proxy
```

`TrustProxyOptions`: `{ hops? (default 1), protoHeader?, hostHeader?, forHeader? }`. The `ctx.state.proxy` entry (`TrustProxyInfo`): `{ proto?, host?, clientIp? }` — augment `State` with `TrustProxyState` to read it typed.
