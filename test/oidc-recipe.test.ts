/**
 * Drives the OIDC recipe end to end through s200/test's `request()`:
 * a fake provider (discovery / jwks / token endpoints behind an injected
 * fetch) and an id_token minted in-test with `signJwt` over a generated
 * RS256 key. The fake provider is per-test, so nothing module-cached
 * leaks between tests.
 */

import { beforeAll, describe, it } from 'vitest';

import { createApp, get, use } from '../src/app';
import { signJwt } from '../src/jwt';
import { createSession, type Session } from '../src/session';
import { request } from '../src/test';
import { createOidc, type OidcOptions } from '../recipes/oidc';

const ISSUER = 'https://idp.example';
const CLIENT_ID = 'web-app';
const CLIENT_SECRET = 'top-secret';
const REDIRECT_URI = 'http://s200.test/callback';

/** One outbound token-request record, captured for assertions. */
type TokenCall = { authorization: string | null; body: URLSearchParams };

/**
 * The fake provider: three URLs behind one fetch. `mint` is mutable so a
 * test first reads the login's nonce cookie, then steers the id_token it
 * wants the provider to hand back (issuer, audience, nonce claims).
 */
function mockIdp(
  privateKey: CryptoKey,
  jwk: JsonWebKey,
  opts: { endSession?: string | null } = {}
): {
  readonly fetchFn: typeof fetch;
  readonly discoveryCalls: { count: number };
  readonly tokenCalls: TokenCall[];
  readonly mint: { nonce?: string; issuer?: string; audience?: string };
} {
  const discoveryCalls = { count: 0 };
  const tokenCalls: TokenCall[] = [];
  const mint: { nonce?: string; issuer?: string; audience?: string } = {};
  const discovery = {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    jwks_uri: `${ISSUER}/jwks`,
    ...(opts.endSession === null ? {} : { end_session_endpoint: opts.endSession ?? `${ISSUER}/logout` }),
  };
  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      discoveryCalls.count += 1;
      return Response.json(discovery);
    }
    if (url === `${ISSUER}/jwks`) {
      return Response.json({ keys: [jwk] });
    }
    if (url === `${ISSUER}/token`) {
      tokenCalls.push({
        authorization:
          (init?.headers as Record<string, string> | undefined)?.authorization ?? null,
        body: new URLSearchParams(String(init?.body ?? '')),
      });
      const idToken = await signJwt(
        { nonce: mint.nonce, email: 'alice@example.com', name: 'Alice' },
        privateKey,
        {
          alg: 'RS256',
          issuer: mint.issuer ?? ISSUER,
          audience: mint.audience ?? CLIENT_ID,
          subject: 'user-1',
          expiresIn: 3600,
        }
      );
      return Response.json({
        access_token: 'at-1',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'rt-1',
        id_token: idToken,
      });
    }
    throw new Error(`unexpected outbound fetch: ${url}`);
  };
  return { fetchFn, discoveryCalls, tokenCalls, mint };
}

/** The app under test: session middleware + the recipe's two routes. */
function buildApp(fetchFn: typeof fetch, over: Partial<OidcOptions> = {}) {
  const sessions = createSession({ secret: 'session-secret' });
  const oidc = createOidc({
    issuer: ISSUER,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    cookieSecret: 'cookie-secret',
    fetch: fetchFn,
    onLogin: (ctx, tokens, claims) => {
      const session = ctx.state.session as Session;
      session.set('sub', claims.sub);
      session.set('email', claims.email);
      session.set('accessToken', tokens.accessToken);
    },
    ...over,
  });
  const app = createApp();
  use(app, sessions.middleware);
  get(app, '/login', oidc.login);
  get(app, '/callback', oidc.callback);
  get(app, '/', (ctx) => {
    const session = ctx.state.session as Session;
    return Response.json({ sub: session.get('sub'), email: session.get('email') });
  });
  return { app, oidc };
}

/** Response Set-Cookie lines as a name→value jar. */
function jarOf(res: Response): Map<string, string> {
  const jar = new Map<string, string>();
  for (const line of res.headers.getSetCookie()) {
    const pair = line.split(';')[0] ?? '';
    const eq = pair.indexOf('=');
    jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return jar;
}

function cookieHeaderOf(jar: Map<string, string>): string {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

/** Only the session cookie pair, as the next request's Cookie header. */
function sessionCookieOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .filter((line) => line.startsWith('s200.sid'))
    .map((line) => (line.split(';')[0] ?? '').trim())
    .join('; ');
}

async function b64urlSha256(text: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  );
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('createOidc', function () {
  let privateKey: CryptoKey;
  let jwk: JsonWebKey & { kid?: string };

  beforeAll(async function () {
    const pair = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify']
    );
    privateKey = pair.privateKey;
    jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'test-key-1' };
  });

  it('redirects login to the authorization endpoint with state, nonce and S256 PKCE', async function () {
    const idp = mockIdp(privateKey, jwk);
    const { app } = buildApp(idp.fetchFn);

    const login = await request(app, '/login');
    login.status.should.equal(302);
    const location = new URL(login.headers.get('location') ?? '');
    location.origin.should.equal(ISSUER);
    location.pathname.should.equal('/authorize');
    location.searchParams.get('response_type')?.should.equal('code');
    location.searchParams.get('client_id')?.should.equal(CLIENT_ID);
    location.searchParams.get('redirect_uri')?.should.equal(REDIRECT_URI);
    location.searchParams.get('scope')?.should.equal('openid');
    location.searchParams.get('code_challenge_method')?.should.equal('S256');
    (location.searchParams.get('code_challenge') ?? '').length.should.equal(43); // SHA-256 → 32 bytes → 43 chars

    // The state/nonce/verifier land in signed HttpOnly cookies, and the
    // challenge commits to exactly that verifier.
    const jar = jarOf(login);
    const state = jar.get('oidc.state') ?? '';
    const nonce = jar.get('oidc.nonce') ?? '';
    const verifier = jar.get('oidc.verifier') ?? '';
    state.should.not.equal('');
    nonce.should.not.equal('');
    verifier.length.should.be.at.least(43);
    (jar.has('oidc.state.sig') && jar.has('oidc.nonce.sig') && jar.has('oidc.verifier.sig'))
      .should.be.true;
    location.searchParams.get('state')?.should.equal(state);
    location.searchParams.get('nonce')?.should.equal(nonce);
    location.searchParams.get('code_challenge')?.should.equal(await b64urlSha256(verifier));
    login.headers
      .getSetCookie()
      .every((line) => line.includes('HttpOnly') && line.includes('Max-Age=600'))
      .should.be.true;
  });

  it('exchanges the code with the verifier, verifies the id_token and establishes the session', async function () {
    const idp = mockIdp(privateKey, jwk);
    const { app } = buildApp(idp.fetchFn);

    const login = await request(app, '/login');
    const jar = jarOf(login);
    const state = jar.get('oidc.state') ?? '';
    const verifier = jar.get('oidc.verifier') ?? '';
    idp.mint.nonce = jar.get('oidc.nonce') ?? '';

    const callback = await request(
      app,
      `/callback?code=good-code&state=${encodeURIComponent(state)}`,
      { headers: { cookie: cookieHeaderOf(jar) } }
    );
    callback.status.should.equal(302);
    (callback.headers.get('location') ?? '').should.equal('/');

    // The token request: authorization-code grant, Basic client auth,
    // and the PKCE verifier from the login cookie.
    idp.tokenCalls.should.have.lengthOf(1);
    const call = idp.tokenCalls[0]!;
    call.body.get('grant_type')?.should.equal('authorization_code');
    call.body.get('code')?.should.equal('good-code');
    call.body.get('redirect_uri')?.should.equal(REDIRECT_URI);
    call.body.get('code_verifier')?.should.equal(verifier);
    call.authorization?.should.equal(`Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`);

    // The session cookie rides on the redirect and restores the login.
    callback.headers.getSetCookie().some((line) => line.startsWith('s200.sid=')).should.be.true;
    const home = await request(app, '/', { headers: { cookie: sessionCookieOf(callback) } });
    (await home.json()).should.deep.equal({ sub: 'user-1', email: 'alice@example.com' });

    // The flow cookies die with the code they carried.
    callback.headers
      .getSetCookie()
      .some((line) => /^oidc\.state=; Max-Age=0/.test(line))
      .should.be.true;
  });

  it('answers 401 for a wrong or absent state', async function () {
    const idp = mockIdp(privateKey, jwk);
    const { app } = buildApp(idp.fetchFn);

    const login = await request(app, '/login');
    const jar = jarOf(login);
    idp.mint.nonce = jar.get('oidc.nonce') ?? '';

    const tampered = await request(
      app,
      '/callback?code=c&state=forged-state',
      { headers: { cookie: cookieHeaderOf(jar) } }
    );
    tampered.status.should.equal(401);
    ((await tampered.json()) as { error: string }).error.should.match(/state/);

    const bare = await request(app, '/callback?code=c&state=anything');
    bare.status.should.equal(401);
    ((await bare.json()) as { error: string }).error.should.match(/state/);

    // Neither attempt reached the token endpoint.
    idp.tokenCalls.should.be.empty;
  });

  it('rejects id_tokens with the wrong issuer or audience', async function () {
    const idp = mockIdp(privateKey, jwk);
    const { app } = buildApp(idp.fetchFn);

    const login = await request(app, '/login');
    const jar = jarOf(login);
    idp.mint.nonce = jar.get('oidc.nonce') ?? '';
    const callbackUrl = `/callback?code=c&state=${encodeURIComponent(jar.get('oidc.state') ?? '')}`;

    idp.mint.issuer = 'https://evil.example';
    const wrongIssuer = await request(app, callbackUrl, { headers: { cookie: cookieHeaderOf(jar) } });
    wrongIssuer.status.should.equal(401);
    ((await wrongIssuer.json()) as { error: string }).error.should.match(/issuer/);

    idp.mint.issuer = ISSUER;
    idp.mint.audience = 'other-app';
    const wrongAudience = await request(app, callbackUrl, {
      headers: { cookie: cookieHeaderOf(jar) },
    });
    wrongAudience.status.should.equal(401);
    ((await wrongAudience.json()) as { error: string }).error.should.match(/audience/);
  });

  it('rejects an id_token whose nonce is not this login', async function () {
    const idp = mockIdp(privateKey, jwk);
    const { app } = buildApp(idp.fetchFn);

    const login = await request(app, '/login');
    const jar = jarOf(login);
    idp.mint.nonce = 'someone-elses-login';
    const res = await request(app, `/callback?code=c&state=${encodeURIComponent(jar.get('oidc.state') ?? '')}`, {
      headers: { cookie: cookieHeaderOf(jar) },
    });
    res.status.should.equal(401);
    ((await res.json()) as { error: string }).error.should.match(/nonce/);
  });

  it('answers 401 with the provider error code when the provider refuses', async function () {
    const idp = mockIdp(privateKey, jwk);
    const { app } = buildApp(idp.fetchFn);

    const res = await request(app, '/callback?error=access_denied');
    res.status.should.equal(401);
    ((await res.json()) as { error: string }).error.should.match(/access_denied/);
  });

  it('serves a public client: client_id in the body, no Basic auth, PKCE only', async function () {
    const idp = mockIdp(privateKey, jwk);
    const { app } = buildApp(idp.fetchFn, { clientSecret: undefined });

    const login = await request(app, '/login');
    const jar = jarOf(login);
    idp.mint.nonce = jar.get('oidc.nonce') ?? '';

    const callback = await request(
      app,
      `/callback?code=c&state=${encodeURIComponent(jar.get('oidc.state') ?? '')}`,
      { headers: { cookie: cookieHeaderOf(jar) } }
    );
    callback.status.should.equal(302);
    idp.tokenCalls.should.have.lengthOf(1);
    (idp.tokenCalls[0]!.authorization === null).should.be.true;
    idp.tokenCalls[0]!.body.get('client_id')?.should.equal(CLIENT_ID);
  });

  it('fetches discovery once per instance and passes custom scopes through', async function () {
    const idp = mockIdp(privateKey, jwk);
    const { app } = buildApp(idp.fetchFn, { scopes: ['openid', 'profile'] });

    (await request(app, '/login')).status.should.equal(302);
    (await request(app, '/login')).status.should.equal(302);
    idp.discoveryCalls.count.should.equal(1);

    const location = new URL((await request(app, '/login')).headers.get('location') ?? '');
    location.searchParams.get('scope')?.should.equal('openid profile');
  });

  it('builds the logout URL from end_session_endpoint, or resolves undefined without one', async function () {
    const withLogout = mockIdp(privateKey, jwk);
    const a = buildApp(withLogout.fetchFn);
    const url = await a.oidc.logoutUrl('https://app.example/bye', 'id-token-hint');
    (url === undefined).should.be.false;
    const parsed = new URL(url ?? '');
    parsed.origin.should.equal(ISSUER);
    parsed.pathname.should.equal('/logout');
    parsed.searchParams.get('client_id')?.should.equal(CLIENT_ID);
    parsed.searchParams.get('post_logout_redirect_uri')?.should.equal('https://app.example/bye');
    parsed.searchParams.get('id_token_hint')?.should.equal('id-token-hint');

    const withoutLogout = mockIdp(privateKey, jwk, { endSession: null });
    const b = buildApp(withoutLogout.fetchFn);
    ((await b.oidc.logoutUrl()) === undefined).should.be.true;
  });
});
