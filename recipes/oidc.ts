/**
 * OIDC Authorization Code flow with PKCE (S256) as a recipe.
 *
 * Repository-level TypeScript, deliberately outside the package exports
 * (s200 is zero-dependency by contract) — vendor it and bring your own
 * provider. The recipe composes the batteries: discovery is one cached
 * fetch per issuer, the login parks state/nonce/verifier in signed
 * cookies (`s200/cookies`), the callback exchanges the code and verifies
 * the id_token with `s200/jwt` (`verifyJwt` + `createJwksResolver` over
 * the discovery `jwks_uri`), then hands tokens and claims to your
 * `onLogin` — establish the application session there with
 * `s200/session`. JWS only: encrypted id_tokens (JWE) are unsupported.
 * Guide: `docs/guides/oidc.md`.
 *
 * @module
 */

import type { Ctx, Handler } from '../src/types';

import { getSignedCookie, setSignedCookie, type CookieOptions } from '../src/cookies';
import { httpError } from '../src/errors';
import {
  createJwksResolver,
  verifyJwt,
  type JwtHeader,
  type RegisteredClaims,
} from '../src/jwt';
import { redirect } from '../src/respond';

/** The discovery fields the flow needs (OIDC Discovery §3.1.1 subset). */
export type OidcDiscovery = {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
  readonly end_session_endpoint?: string;
};

/** The token endpoint's payload — the id_token leads, the rest rides. */
export type OidcTokens = {
  readonly accessToken: string;
  readonly tokenType: string;
  readonly expiresIn?: number;
  readonly refreshToken?: string;
  readonly scope?: string;
  readonly idToken: string;
};

/** The verified id_token payload — registered claims plus provider-minted
 * keys (`email`, `name`, …). */
export type OidcClaims = RegisteredClaims & Record<string, unknown>;

/**
 * Receives the verified tokens and claims at the end of a successful
 * flow. Establish the application session here — the `s200/session`
 * shape is `session.set('user', claims.sub)` on `ctx.state.session` —
 * or write your own response, which then wins over the default redirect.
 */
export type OidcLogin = (
  ctx: Ctx,
  tokens: OidcTokens,
  claims: OidcClaims
) => void | Promise<void>;

/** Flow-cookie names — override when several apps share one domain. */
export type OidcCookieNames = {
  readonly state?: string;
  readonly nonce?: string;
  readonly verifier?: string;
};

/** Options for {@link createOidc}. */
export type OidcOptions = {
  /** Provider issuer — discovery is `${issuer}/.well-known/openid-configuration`. */
  readonly issuer: string;
  readonly clientId: string;
  /**
   * Confidential clients: HTTP Basic authorization on the token request
   * (RFC 6749 §2.3.1). Absent → public client — `client_id` rides in
   * the body and PKCE is the client authentication.
   */
  readonly clientSecret?: string;
  /** The callback URL registered with the provider. */
  readonly redirectUri: string;
  /** Requested scopes; default `['openid']` — the `openid` scope is
   * what makes the flow OIDC rather than plain OAuth. */
  readonly scopes?: readonly string[];
  /** HMAC secret for the flow cookies — the cookies battery's convention. */
  readonly cookieSecret: string;
  readonly cookieNames?: OidcCookieNames;
  /** Where the callback lands after a successful login; default `'/'`. */
  readonly postLoginPath?: string;
  /** id_token clock-skew tolerance in seconds; default 60. */
  readonly clockTolerance?: number;
  /**
   * Fetch implementation; default the global fetch. An injected fetch
   * gets a per-instance discovery cache — the module-level cache is only
   * shared between instances on the global fetch, so tests and multi-
   * issuer front-ends never read each other's entries.
   */
  readonly fetch?: typeof fetch;
  readonly onLogin: OidcLogin;
};

/** Builds the provider's end-session URL, or resolves `undefined` when
 * discovery has no `end_session_endpoint`. */
export type OidcLogoutUrl = (
  postLogoutRedirectUri?: string,
  idTokenHint?: string
) => Promise<string | undefined>;

/** What {@link createOidc} returns — two handlers plus a URL builder. */
export type Oidc = {
  readonly login: Handler;
  readonly callback: Handler;
  readonly logoutUrl: OidcLogoutUrl;
};

/** Flow-cookie lifetime, seconds: a login detour should not outlive ten
 * minutes, and neither should the values it parks. */
const FLOW_COOKIE_MAX_AGE = 600;

/** Discovery documents, keyed by issuer, shared by every instance on the
 * global fetch. Instances with an injected fetch keep their own cache
 * instead — see {@link OidcOptions.fetch}. */
const discoveryCache = new Map<string, Promise<OidcDiscovery>>();

/** Base64url without padding: bytes → alphabet, `+` `/` `=` translated. */
function b64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** One base64url JSON segment (a token header), decoded. */
function b64urlJson<T>(text: string): T {
  const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4))) as T;
}

/** Cryptographic randomness from the platform — no dependency. */
function randomB64url(bytes: number): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** RFC 7636 §4.2 S256: base64url(SHA-256(verifier)). */
async function s256(text: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

/**
 * Fetches and caches the discovery document. The cache holds the promise,
 * so concurrent first requests share one fetch; a rejected promise is
 * dropped from the cache — a failed discovery is retried, not pinned.
 */
function loadDiscovery(
  issuer: string,
  fetchFn: typeof fetch,
  cache: Map<string, Promise<OidcDiscovery>>
): Promise<OidcDiscovery> {
  const pending = cache.get(issuer);
  if (pending !== undefined) return pending;
  const load = fetchFn(`${issuer}/.well-known/openid-configuration`).then(
    async (res): Promise<OidcDiscovery> => {
      if (!res.ok) {
        throw httpError(502, `OIDC discovery failed: HTTP ${res.status} from ${issuer}`);
      }
      const doc = (await res.json()) as Partial<OidcDiscovery>;
      if (
        doc.authorization_endpoint === undefined ||
        doc.token_endpoint === undefined ||
        doc.jwks_uri === undefined
      ) {
        throw httpError(502, `OIDC discovery from ${issuer} lacks an endpoint the flow needs`);
      }
      return doc as OidcDiscovery;
    }
  );
  load.catch(() => cache.delete(issuer));
  cache.set(issuer, load);
  return load;
}

/**
 * Builds the OIDC login handlers. Mount the `s200/session` middleware
 * (or your own session layer) first, then register `login` and
 * `callback` on two GET routes — `callback` is the `redirectUri`
 * registered with the provider — and establish the session in `onLogin`:
 *
 * ```ts
 * const oidc = createOidc({
 *   issuer: 'https://idp.example',
 *   clientId: 'web-app',
 *   clientSecret: process.env.OIDC_SECRET,
 *   redirectUri: 'https://app.example/auth/callback',
 *   cookieSecret: process.env.COOKIE_SECRET,
 *   onLogin: (ctx, tokens, claims) => {
 *     (ctx.state.session as Session).set('user', claims.sub);
 *   },
 * });
 * use(app, createSession({ secret: SESSION_SECRET }).middleware);
 * get(app, '/login', oidc.login);
 * get(app, '/auth/callback', oidc.callback);
 * ```
 *
 * `login` answers 302 with the authorization request (state, nonce,
 * S256 challenge) and parks the three values in signed HttpOnly cookies.
 * `callback` refuses (401) anything whose `state` disagrees with the
 * cookie, exchanges the code with the PKCE verifier, verifies the
 * id_token's signature, issuer, audience and nonce, calls `onLogin`,
 * redirects to `postLoginPath` (302) unless `onLogin` answered itself,
 * and expires the flow cookies. Provider errors answer 401 with the
 * provider's error code; token-exchange and discovery failures 502.
 * The full walkthrough is `docs/guides/oidc.md`.
 */
export function createOidc(options: OidcOptions): Oidc {
  if (options.cookieSecret === '') {
    throw new Error('Invalid OIDC cookie secret: must be a non-empty string');
  }
  const issuer = options.issuer.replace(/\/+$/, '');
  const fetchFn = options.fetch ?? globalThis.fetch;
  const cache = options.fetch === undefined ? discoveryCache : new Map<string, Promise<OidcDiscovery>>();
  const discovery = (): Promise<OidcDiscovery> => loadDiscovery(issuer, fetchFn, cache);
  const names = {
    state: options.cookieNames?.state ?? 'oidc.state',
    nonce: options.cookieNames?.nonce ?? 'oidc.nonce',
    verifier: options.cookieNames?.verifier ?? 'oidc.verifier',
  };
  const flowCookie: CookieOptions = {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: FLOW_COOKIE_MAX_AGE,
    path: '/',
  };
  const scope = (options.scopes ?? ['openid']).join(' ');

  const login: Handler = async (ctx) => {
    const doc = await discovery();
    const state = randomB64url(32);
    const nonce = randomB64url(32);
    // RFC 7636 §4.1: 43–128 unreserved characters — 64 random bytes → 86.
    const verifier = randomB64url(64);
    const authorize = new URL(doc.authorization_endpoint);
    const params = authorize.searchParams;
    params.set('response_type', 'code');
    params.set('client_id', options.clientId);
    params.set('redirect_uri', options.redirectUri);
    params.set('scope', scope);
    params.set('state', state);
    params.set('nonce', nonce);
    params.set('code_challenge', await s256(verifier));
    params.set('code_challenge_method', 'S256');
    redirect(ctx, authorize.toString());
    await setSignedCookie(ctx, names.state, state, options.cookieSecret, flowCookie);
    await setSignedCookie(ctx, names.nonce, nonce, options.cookieSecret, flowCookie);
    await setSignedCookie(ctx, names.verifier, verifier, options.cookieSecret, flowCookie);
  };

  const callback: Handler = async (ctx) => {
    const query = new URL(ctx.req.url).searchParams;
    const providerError = query.get('error');
    if (providerError !== null) {
      throw httpError(401, `OIDC provider rejected the flow: ${providerError}`);
    }
    const code = query.get('code');
    const state = query.get('state');
    const expectedState = await getSignedCookie(ctx, names.state, options.cookieSecret);
    // A missing or invalid state cookie reads undefined — the strict
    // comparison rejects it, since a non-empty query state never equals it.
    if (code === null || code === '' || state === null || state === '' || state !== expectedState) {
      throw httpError(401, 'OIDC state mismatch: absent, invalid, or disagreeing state cookie');
    }
    const nonce = await getSignedCookie(ctx, names.nonce, options.cookieSecret);
    const verifier = await getSignedCookie(ctx, names.verifier, options.cookieSecret);
    if (nonce === undefined || verifier === undefined) {
      throw httpError(401, 'OIDC flow cookies missing: restart the login');
    }

    const doc = await discovery();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: options.redirectUri,
      code_verifier: verifier,
    });
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
    };
    if (options.clientSecret !== undefined) {
      const encoded = new TextEncoder().encode(`${options.clientId}:${options.clientSecret}`);
      headers.authorization = `Basic ${b64url(encoded)}`;
    } else {
      body.set('client_id', options.clientId);
    }
    const tokenRes = await fetchFn(doc.token_endpoint, {
      method: 'POST',
      headers,
      body: body.toString(),
    });
    if (!tokenRes.ok) {
      throw httpError(502, `OIDC token exchange failed: HTTP ${tokenRes.status}`);
    }
    const raw = (await tokenRes.json()) as {
      id_token?: string; access_token?: string; token_type?: string;
      expires_in?: number; refresh_token?: string; scope?: string;
    };
    if (raw.id_token === undefined || raw.access_token === undefined || raw.token_type === undefined) {
      throw httpError(502, 'OIDC token response lacks a token the flow needs');
    }
    // The verification key comes from the discovery jwks_uri, resolved
    // by kid — rotation is the resolver's business.
    const resolveKey = createJwksResolver(doc.jwks_uri, { fetchFn });
    const header = b64urlJson<JwtHeader>(raw.id_token.split('.')[0] ?? '');
    let claims: OidcClaims;
    try {
      claims = await verifyJwt<OidcClaims>(raw.id_token, await resolveKey(header), {
        issuer,
        audience: options.clientId,
        clockTolerance: options.clockTolerance ?? 60,
      });
    } catch (error) {
      throw httpError(
        401,
        `OIDC id_token rejected: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (claims.nonce !== nonce) {
      throw httpError(401, 'OIDC nonce mismatch: the id_token was not minted for this login');
    }
    await options.onLogin(
      ctx,
      {
        accessToken: raw.access_token,
        tokenType: raw.token_type,
        expiresIn: raw.expires_in,
        refreshToken: raw.refresh_token,
        scope: raw.scope,
        idToken: raw.id_token,
      },
      claims
    );
    if (ctx.res === undefined) {
      redirect(ctx, options.postLoginPath ?? '/');
    }
    // The flow cookies die with the code they carried.
    for (const name of [names.state, names.nonce, names.verifier]) {
      await setSignedCookie(ctx, name, '', options.cookieSecret, { ...flowCookie, maxAge: 0 });
    }
  };

  const logoutUrl: OidcLogoutUrl = async (postLogoutRedirectUri, idTokenHint) => {
    const doc = await discovery();
    if (doc.end_session_endpoint === undefined) return undefined;
    const url = new URL(doc.end_session_endpoint);
    url.searchParams.set('client_id', options.clientId);
    if (postLogoutRedirectUri !== undefined) {
      url.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri);
    }
    if (idTokenHint !== undefined) {
      url.searchParams.set('id_token_hint', idTokenHint);
    }
    return url.toString();
  };

  return { login, callback, logoutUrl };
}
