# OIDC Login

s200's auth surface stops at the challenge-carrying basics (`s200/auth`, `s200/jwt`, `s200/csrf`) — a full OIDC client is deliberately a recipe, not a package entry. [`recipes/oidc.ts`](https://github.com/wmzy/s200/blob/main/recipes/oidc.ts) is repository-level TypeScript, the same deal as [`recipes/redis-stores.ts`](https://github.com/wmzy/s200/blob/main/recipes/redis-stores.ts): vendor the one file, bring your own provider, inject. It implements the Authorization Code flow with PKCE (S256) — the flow current OIDC guidance recommends for every client, confidential or public — and composes the batteries instead of reinventing them: signed flow cookies (`s200/cookies`), id_token verification (`s200/jwt`'s `verifyJwt` over a `createJwksResolver` on the discovery `jwks_uri`), and a token handoff to your session layer (`s200/session`).

## Setup

Vendor `recipes/oidc.ts` into your project (adjust the two import specifier levels to wherever `src/` lives for you), then wire two GET routes and the session middleware:

```ts
import { createApp, get, use } from 's200';
import { createSession, type Session } from 's200/session';
import { createOidc } from './oidc'; // vendored from recipes/oidc.ts

const sessions = createSession({ secret: process.env.SESSION_SECRET! });
const oidc = createOidc({
  issuer: 'https://idp.example',
  clientId: 'web-app',
  clientSecret: process.env.OIDC_SECRET,
  redirectUri: 'https://app.example/auth/callback',
  cookieSecret: process.env.COOKIE_SECRET!,
  scopes: ['openid', 'profile', 'email'],
  onLogin: (ctx, tokens, claims) => {
    const session = ctx.state.session as Session;
    session.set('user', claims.sub);
    session.set('idToken', tokens.idToken); // for the logout id_token_hint
  },
});

const app = createApp();
use(app, sessions.middleware);
get(app, '/login', oidc.login);
get(app, '/auth/callback', oidc.callback); // must be the registered redirectUri
get(app, '/logout', async (ctx) => {
  const session = ctx.state.session as Session;
  const idToken = session.get('idToken') as string | undefined;
  await session.destroy();
  const target = await oidc.logoutUrl('https://app.example/', idToken);
  return new Response(null, { status: 302, headers: { location: target ?? '/' } });
});
```

If `clientSecret` is omitted the recipe runs as a public client — no provider-side client registration secret, PKCE carries the client authentication.

## The flow, in words

The whole dance is one browser redirect out, one redirect back, one server-to-server POST:

1. **`GET /login`** — the handler draws three fresh 256-bit values from the platform CSPRNG: a `state`, a `nonce`, and a PKCE `code_verifier`. It answers `302` to the provider's `authorization_endpoint` carrying `response_type=code`, the `client_id`/`redirect_uri`/`scope`, the `state` and `nonce` in the clear, and `code_challenge=base64url(SHA-256(verifier))` with `code_challenge_method=S256`. The three secrets land in signed, HttpOnly, `SameSite=Lax`, ten-minute cookies (`oidc.state`, `oidc.nonce`, `oidc.verifier`, each with a `.sig` partner under the cookie battery's convention).
2. **At the provider** — the user authenticates and consents. The provider never sees the verifier; the challenge is a one-way hash of it.
3. **Back to `/auth/callback`** — the provider redirects with `code` + `state` (or an `error`, which the recipe answers as a 401 carrying the provider's error code). The handler re-reads the three cookies, verifying signatures, and refuses with 401 unless the query `state` matches the cookie exactly.
4. **The exchange** — the recipe POSTs the `token_endpoint` a form body of `grant_type=authorization_code`, the `code`, the `redirect_uri`, and the `code_verifier`; the provider re-hashes the verifier against the challenge it remembered, which is what binds the code to this browser. A `clientSecret` is sent as HTTP Basic authorization; without one, `client_id` rides the body. A failed exchange answers 502.
5. **Verification** — the returned `id_token` is verified with `verifyJwt`: signature via a `createJwksResolver` over the discovery `jwks_uri` (kid rotation is the resolver's business), `iss` against the configured issuer, `aud` against the `clientId`, time claims with the configured clock tolerance, and the `nonce` claim against the nonce cookie. Any failure answers 401.
6. **Session** — `onLogin` runs with the tokens and the verified claims; the default response is a `302` to `postLoginPath` (or wherever `onLogin` answered itself). The three flow cookies are expired alongside.

Discovery (`{issuer}/.well-known/openid-configuration`) is fetched once per issuer and cached for the process; a failed fetch is retried on the next request, not pinned.

## Options

| Option | Default | Notes |
| ------ | ------- | ----- |
| `issuer` | — | Provider issuer; trailing slashes are normalized. Discovery is cached per issuer. |
| `clientId` | — | Also the required `aud` of the id_token. |
| `clientSecret` | `undefined` | Present → confidential client, HTTP Basic on the token request. Absent → public client, `client_id` in the body. |
| `redirectUri` | — | The callback URL registered with the provider. |
| `scopes` | `['openid']` | `openid` is what makes the flow OIDC; add `profile`/`email` for claims. |
| `cookieSecret` | — | HMAC secret for the three flow cookies (the cookies battery's convention). |
| `cookieNames` | `oidc.*` | Override when several apps share one domain. |
| `postLoginPath` | `'/'` | Where a successful callback redirects. |
| `clockTolerance` | `60` | Seconds of id_token clock-skew tolerance. |
| `fetch` | global fetch | Injection point for tests and proxies. An injected fetch gets a **per-instance** discovery cache — the module-level cache is only shared between instances on the global fetch. |
| `onLogin` | — | Receives `(ctx, tokens, claims)`; write your session here. |

## Security notes

- **PKCE is unconditional.** Every authorization request carries `code_challenge_method=S256`; the verifier exists only in a signed HttpOnly cookie and the one token request. The recipe never downgrades to `plain`, and there is no PKCE-off switch — for confidential clients it is defense in depth (a stolen `code` is worthless without the verifier), for public clients it is the only client authentication there is.
- **Basic vs body client authentication.** With a `clientSecret`, credentials go in the `Authorization: Basic` header (RFC 6749 §2.3.1) — the default for confidential clients, and the kinder choice for logs and intermediaries, since bodies get logged far more often than headers. `client_secret_post` (secrets in the body) is not offered; if your provider demands it, that is a one-line vendored edit.
- **Clock skew.** `verifyJwt` checks `exp`/`nbf`/`iat` with `clockTolerance` seconds of leeway (default 60). Raise it for a provider on drifting clocks; set `0` for strictness. The `state`/`nonce`/`verifier` are single-purpose random values under a ten-minute cookie TTL, so they need no skew handling and no server-side storage.
- **Rotate the session at login.** The recipe never touches your session; `onLogin` is the place to call `session.regenerate()` — the session battery's fixation defense — before writing the user in.

## Limitations

- **JWS only.** Encrypted id_tokens (JWE — a token with an `enc` header, `alg` like `RSA-OAEP-256`) are unsupported and fail verification. Signed tokens are the provider default; request them if your provider offers both.
- **id_token claims only.** The userinfo endpoint is never called — profile data must ride the id_token (request the scopes).
- **No refresh automation.** `tokens.refreshToken` is handed to `onLogin` untouched; refreshing, storing, and rotating it are yours.
- **One redirect URI.** Exactly the configured one, for login and the exchange alike; no per-request overrides.
- **Discovery has no TTL.** The document is fetched once per issuer per process; endpoint changes need a restart or an injected `fetch` with your own caching policy.
- **Logout needs provider support.** `end_session_endpoint` is optional in discovery; without it `logoutUrl()` resolves `undefined` and the guide's logout route falls back to destroying the local session.
