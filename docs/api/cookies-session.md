# Cookies & Sessions (`s200/cookies`, `s200/session`)

Cookie reading/writing/signing as pure functions, and server-side sessions over a signed opaque id.

## Cookies (`s200/cookies`)

Writing appends a proper `Set-Cookie` header (repeat calls stay separate headers, never comma-joined); call it once the response exists — the natural spot is the unwind, after `await next()`:

```ts
use(app, async (ctx, next) => {
  await next();
  setCookie(ctx, 'theme', 'dark', { httpOnly: true, sameSite: 'lax', maxAge: 86400 });
});
await setSignedCookie(ctx, 'sid', userId, SECRET);          // + sid.sig HMAC partner
const sid = await getSignedCookie(ctx, 'sid', SECRET);      // undefined unless verified
```

| Function | Meaning |
| --- | --- |
| `getCookie(ctx, name)` | Reads one cookie (decoded); `undefined` for a missing cookie or a malformed pair |
| `setCookie(ctx, name, value, options?)` | Appends a `Set-Cookie` header; **throws** when no response exists yet |
| `signCookie(value, secret)` | `value.sig` — HMAC-SHA256 signature over the value |
| `verifyCookieSignature(value, sig, secret)` | Constant-time verification; `false` on mismatch |
| `setSignedCookie(ctx, name, value, secret, options?)` | Sets `name=value` plus the `name.sig` partner cookie |
| `getSignedCookie(ctx, name, secret)` | The value when the signature verifies, else `undefined` |

`CookieOptions`:

| Field | Default | Meaning |
| --- | --- | --- |
| `maxAge` | — | Lifetime in seconds → `Max-Age` |
| `expires` | — | Absolute expiry → `Expires` (RFC 1123) |
| `domain` / `path` | — / `'/'` | Scope |
| `secure` / `httpOnly` | — / `false` | Cookie flags |
| `sameSite` | — | `'strict' \| 'lax' \| 'none'` |
| `partitioned` | — | Chrome CHIPS — emits the `Partitioned` attribute |

Cookie names live in the RFC 6265 token alphabet (stricter than values); values are percent-decoded on read.

## Sessions (`s200/session`)

`createSession({ secret, store? })` returns a middleware (plus `close()` for the default store's sweep timer). The client only ever holds an opaque signed id (HMAC via the cookies battery — one signing convention framework-wide); data lives server-side in the pluggable `store`. Tampered, missing, or expired ids all look identical: a fresh empty session, never an error.

Mutations (`set`/`delete`/`clear`/`touch`) persist and (re)issue the cookie on the unwind; `destroy()` deletes from the store and expires the cookie; read-only requests write nothing — no store write, no `Set-Cookie`.

```ts
const { middleware, close } = createSession({ secret: SECRET, cookie: { maxAge: 3600 } });
use(app, middleware);
get(app, '/', (ctx) => {
  const session = ctx.state.session as Session;
  session.set('user', 'alice');            // persisted + cookie issued on unwind
  return json(ctx, { visits: session.get('visits') });
});
```

`SessionOptions`:

| Field | Default | Meaning |
| --- | --- | --- |
| `secret` | (required) | HMAC secret — the same key material the cookies battery signs with |
| `cookie` | — | `SessionCookieOptions` (below) |
| `store` | in-process map, lazy expiry + periodic unref'd sweep | `SessionStore` (below) — the Redis `SET … EX` shape |
| `key` | `'session'` | `ctx.state` slot for the session object |
| `now` | `Date.now` | Clock override (tests, deterministic replays) |

`SessionCookieOptions`: `{ name? ('s200.sid', signature partner `.sig`), maxAge? (86_400), httpOnly? (true), sameSite?, path?, secure?, domain? }`.

`SessionStore`: `get(id)`, `set(id, data, ttlSeconds)`, `delete(id)` — each may return a value or a promise; `set` receives the TTL the cookie advertises so a shared store expires data together with its cookie.

`Session` (hung on `ctx.state[key]`):

| Member | Meaning |
| --- | --- |
| `id` | The restored session's id; `undefined` until the unwind mints one |
| `isNew` | Stable for the request — true when no valid cookie + store hit restored data |
| `get(key)` / `set(key, value)` / `delete(key)` / `clear()` | Data access; mutations persist on the unwind |
| `touch()` | Renews the expiry of an existing session (no-op on a new one) |
| `destroy()` | Deletes from the store; the unwind expires the cookie. Terminal — mutations after `destroy()` are discarded |

`SessionData`: `Record<string, unknown>` — plain JSON-shaped records, opaque to the store.
