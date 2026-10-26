/**
 * OAuth 2.0 Authorization Code flow with PKCE (S256) as pure functions:
 * `createPkcePair` mints the verifier and its SHA-256 challenge,
 * `randomState` mints an unguessable state (or nonce), `buildAuthorizeUrl`
 * renders the redirect, and `exchangeCode` redeems the code at the token
 * endpoint. The caller owns transport and storage — park the state and
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

/** Base64url without padding: bytes → alphabet, `+` `/` `=` translated. */
function b64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** RFC 7636 §4.2 S256: base64url(SHA-256(verifier)). */
async function s256(text: string): Promise<string> {
  return b64url(
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
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(64)));
  return { verifier, codeChallenge: await s256(verifier) };
}

/**
 * Random state: 32 bytes from `crypto.getRandomValues` → 43 base64url
 * characters. Works as an OIDC nonce too.
 */
export function randomState(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
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

/** The token-endpoint knobs — endpoint, client credentials, transport. */
export type OAuthTokenOptions = {
  readonly tokenEndpoint: string;
  readonly clientId: string;
  /** Present → HTTP Basic client authentication; absent → `client_id`
   * travels in the body (a public client, which is what PKCE is for). */
  readonly clientSecret?: string;
  readonly redirectUri: string;
  /** Injectable fetch — defaults to the global (mocks, proxies, tests). */
  readonly fetch?: typeof fetch;
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
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (options.clientSecret !== undefined) {
    const encoded = new TextEncoder().encode(`${options.clientId}:${options.clientSecret}`);
    headers.authorization = `Basic ${b64url(encoded)}`;
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
