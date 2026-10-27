/**
 * OAuth 2.0 Authorization Code flow with PKCE (S256) as pure functions:
 * `createPkcePair` mints the verifier and its SHA-256 challenge,
 * `randomState` mints an unguessable state (or nonce), `buildAuthorizeUrl`
 * renders the redirect, and `exchangeCode` redeems the code at the token
 * endpoint. `refreshToken` (RFC 6749 §6) and `clientCredentials` (§4.4)
 * run the other two token grants over the same client authentication
 * and transport. The caller owns transport and storage — park the state and
 * verifier between the redirect and the callback (signed cookies work,
 * `s200/cookies`), and compare the query `state` strictly before
 * exchanging. All randomness and hashing run through the platform
 * (`crypto.getRandomValues`, `crypto.subtle.digest`); `fetch` is
 * injectable, defaulting to the global. The OIDC recipe
 * (`recipes/oidc.ts`) composes these primitives end to end.
 *
 * @module
 */

import { httpError } from './errors';
import { b64urlEncode } from './crypto-util';

/** RFC 7636 §4.2 S256: base64url(SHA-256(verifier)). */
async function s256(text: string): Promise<string> {
  return b64urlEncode(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  );
}

/** One PKCE pair: the verifier rides the token request, the challenge
 * rides the authorization redirect — only the challenge ever leaves
 * before the code comes back. */
export type PkcePair = {
  readonly verifier: string;
  readonly codeChallenge: string;
};

/**
 * Mints a PKCE pair: 64 random bytes → an 86-character base64url
 * verifier (RFC 7636 §4.1 allows 43–128 unreserved characters), and the
 * S256 challenge `base64url(SHA-256(verifier))`.
 */
export async function createPkcePair(): Promise<PkcePair> {
  const verifier = b64urlEncode(crypto.getRandomValues(new Uint8Array(64)));
  return { verifier, codeChallenge: await s256(verifier) };
}

/**
 * Random state: 32 bytes from `crypto.getRandomValues` → 43 base64url
 * characters. Works as an OIDC nonce too.
 */
export function randomState(): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

/** The authorization-request knobs — endpoint and client registration. */
export type OAuthAuthorizeOptions = {
  /** The provider's authorization endpoint (from its discovery document). */
  readonly authorizationEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  /** Space-joined when an array; the parameter is omitted when absent. */
  readonly scope?: string | readonly string[];
  /** Appended last, so provider extras (`resource`, `prompt`, …) win ties. */
  readonly extraParams?: Record<string, string>;
};

/** The per-request values the redirect commits to. */
export type OAuthAuthorizeFlow = {
  readonly state: string;
  readonly codeChallenge: string;
  /** OIDC only — echo it into the id_token and compare on callback. */
  readonly nonce?: string;
};

/**
 * Renders the authorization redirect: `response_type=code`, the client
 * registration, the flow values, and `code_challenge_method=S256` —
 * always S256, never `plain`. Existing query on the endpoint survives;
 * `extraParams` are appended last. A pure URL construction, no I/O.
 */
export function buildAuthorizeUrl(
  options: OAuthAuthorizeOptions,
  flow: OAuthAuthorizeFlow
): string {
  const authorize = new URL(options.authorizationEndpoint);
  const params = authorize.searchParams;
  params.set('response_type', 'code');
  params.set('client_id', options.clientId);
  params.set('redirect_uri', options.redirectUri);
  if (options.scope !== undefined) {
    params.set(
      'scope',
      typeof options.scope === 'string' ? options.scope : options.scope.join(' ')
    );
  }
  params.set('state', flow.state);
  if (flow.nonce !== undefined) {
    params.set('nonce', flow.nonce);
  }
  params.set('code_challenge', flow.codeChallenge);
  params.set('code_challenge_method', 'S256');
  for (const [name, value] of Object.entries(options.extraParams ?? {})) {
    params.set(name, value);
  }
  return authorize.toString();
}

/** The token-endpoint knobs every grant shares — endpoint, client
 * credentials, transport. */
export type OAuthGrantOptions = {
  readonly tokenEndpoint: string;
  readonly clientId: string;
  /** Present → HTTP Basic client authentication; absent → `client_id`
   * travels in the body (a public client, which is what PKCE is for). */
  readonly clientSecret?: string;
  /** Injectable fetch — defaults to the global (mocks, proxies, tests). */
  readonly fetch?: typeof fetch;
};

/** The code grant's token-endpoint knobs: the shared set plus the
 * `redirect_uri` that re-identifies the client at redemption. */
export type OAuthTokenOptions = OAuthGrantOptions & {
  readonly redirectUri: string;
};

/** The token endpoint's standard payload (RFC 6749 §5.1); `idToken`
 * rides along for OIDC flows. */
export type OAuthTokens = {
  readonly accessToken: string;
  readonly tokenType: string;
  readonly expiresIn?: number;
  readonly refreshToken?: string;
  readonly scope?: string;
  readonly idToken?: string;
};

/** Shared token-endpoint POST: adds client authentication to the
 * form-encoded grant body, sends it, and validates the payload — the
 * 502 `HttpError` contract every grant exchange throws. */
async function postTokenGrant(
  options: OAuthGrantOptions,
  body: URLSearchParams
): Promise<OAuthTokens> {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (options.clientSecret !== undefined) {
    const encoded = new TextEncoder().encode(`${options.clientId}:${options.clientSecret}`);
    headers.authorization = `Basic ${b64urlEncode(encoded)}`;
  } else {
    body.set('client_id', options.clientId);
  }
  const res = await (options.fetch ?? globalThis.fetch)(options.tokenEndpoint, {
    method: 'POST',
    headers,
    body: body.toString(),
  });
  if (!res.ok) {
    throw httpError(502, `OAuth token exchange failed: HTTP ${res.status}`);
  }
  const raw = (await res.json()) as {
    access_token?: string;
    token_type?: string;
    expires_in?: number;
    refresh_token?: string;
    scope?: string;
    id_token?: string;
  };
  if (raw.access_token === undefined || raw.token_type === undefined) {
    throw httpError(502, 'OAuth token response lacks a token the flow needs');
  }
  return {
    accessToken: raw.access_token,
    tokenType: raw.token_type,
    expiresIn: raw.expires_in,
    refreshToken: raw.refresh_token,
    scope: raw.scope,
    idToken: raw.id_token,
  };
}

/**
 * Exchanges an authorization code: POSTs the `authorization_code` grant
 * with the PKCE verifier (form-encoded). A `clientSecret` sends HTTP
 * Basic client authentication; without one the `client_id` rides the
 * body. A non-2xx answer, or a payload without `access_token` and
 * `token_type`, throws a 502 `HttpError` — upstream failures are the
 * server's problem, not the user's.
 */
export async function exchangeCode(
  options: OAuthTokenOptions,
  grant: {
    readonly code: string;
    readonly codeVerifier: string;
  }
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: grant.code,
    redirect_uri: options.redirectUri,
    code_verifier: grant.codeVerifier,
  });
  return postTokenGrant(options, body);
}

/**
 * Refreshes an access token (RFC 6749 §6): POSTs the `refresh_token`
 * grant form-encoded. The optional `scope` (a string or an array,
 * joined with spaces) MUST NOT exceed the scope originally granted —
 * the authorization server rejects anything wider; omit it to keep the
 * original scope. Client authentication follows `exchangeCode`: a
 * `clientSecret` sends HTTP Basic, without one the `client_id` rides
 * the body (a public client refreshing its own token). A non-2xx
 * answer — an expired or revoked refresh token comes back
 * `invalid_grant` — or a payload without `access_token`/`token_type`
 * throws a 502 `HttpError`; a rotated refresh token, when the server
 * sends one, rides `tokens.refreshToken`.
 */
export async function refreshToken(
  options: OAuthGrantOptions,
  grant: {
    readonly refreshToken: string;
    readonly scope?: string | readonly string[];
  }
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: grant.refreshToken,
  });
  if (grant.scope !== undefined) {
    body.set(
      'scope',
      typeof grant.scope === 'string' ? grant.scope : grant.scope.join(' ')
    );
  }
  return postTokenGrant(options, body);
}

/**
 * Fetches a token with the client's own credentials (RFC 6749 §4.4):
 * POSTs the `client_credentials` grant form-encoded with HTTP Basic
 * client authentication — confidential clients only, the `clientSecret`
 * is required; a public client has no credentials of its own, so the
 * grant does not apply to it (PKCE-protected code flows are its path).
 * The optional `scope` (a string or an array, joined with spaces)
 * requests part of the client's registered scope. No refresh token is
 * issued for this grant (RFC 6749 §4.4.3), so `tokens.refreshToken` is
 * absent. The 502 `HttpError` contract matches `exchangeCode`.
 */
export async function clientCredentials(
  options: OAuthGrantOptions & { readonly clientSecret: string },
  grant: {
    readonly scope?: string | readonly string[];
  }
): Promise<OAuthTokens> {
  const body = new URLSearchParams({ grant_type: 'client_credentials' });
  if (grant.scope !== undefined) {
    body.set(
      'scope',
      typeof grant.scope === 'string' ? grant.scope : grant.scope.join(' ')
    );
  }
  return postTokenGrant(options, body);
}
