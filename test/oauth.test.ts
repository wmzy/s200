import { describe, it } from 'vitest';

import {
  buildAuthorizeUrl,
  clientCredentials,
  createPkcePair,
  exchangeCode,
  randomState,
  refreshToken,
  type OAuthGrantOptions,
  type OAuthTokenOptions,
} from '../src/oauth';

// vitest's should chain has no rejectedWith — capture rejections manually
// and assert on the tagged value.
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined; // resolved — property assertions below will fail
}

/** An S256 reference built straight from the RFC 7636 §4.2 formula —
 * pinned against the appendix B vector below, it vouches for the
 * comparisons against `createPkcePair`. */
async function s256Of(verifier: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  );
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Records the one outbound token request for assertions. */
function tokenFetch(
  status: number,
  payload: string
): { fetchFn: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(payload, { status });
  }) as typeof fetch;
  return { fetchFn, calls };
}

const CLIENT: Omit<OAuthTokenOptions, 'fetch'> = {
  tokenEndpoint: 'https://idp.example/token',
  clientId: 'web-app',
  clientSecret: 'top-secret',
  redirectUri: 'http://s200.test/callback',
};

// Distinct token endpoints per grant family — nothing is cached module-wide
// today, and distinct URLs keep it that way if that ever changes.
const REFRESH: Omit<OAuthGrantOptions, 'fetch'> = {
  tokenEndpoint: 'https://refresh.example/token',
  clientId: 'web-app',
  clientSecret: 'top-secret',
};

const MACHINE: Omit<OAuthGrantOptions, 'fetch'> & { clientSecret: string } = {
  tokenEndpoint: 'https://machine.example/token',
  clientId: 'worker',
  clientSecret: 'machine-secret',
};

describe('createPkcePair', function () {
  it('mints an RFC 7636 verifier with its S256 challenge', async function () {
    const pair = await createPkcePair();
    // §4.1: 43–128 unreserved characters — 64 random bytes → 86.
    pair.verifier.length.should.be.at.least(43);
    pair.verifier.length.should.be.at.most(128);
    pair.verifier.should.match(/^[A-Za-z0-9-_]+$/);
    // SHA-256 → 32 bytes → 43 base64url chars.
    pair.codeChallenge.length.should.equal(43);
    pair.codeChallenge.should.equal(await s256Of(pair.verifier));
  });

  it('never repeats a verifier', async function () {
    const pairs = await Promise.all(Array.from({ length: 8 }, () => createPkcePair()));
    new Set(pairs.map((pair) => pair.verifier)).size.should.equal(8);
  });

  it('matches the RFC 7636 appendix B test vector through the reference', async function () {
    // The reference implementation reproduces the published vector,
    // which then vouches for the challenge comparisons above.
    (await s256Of('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).should.equal(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    );
  });
});

describe('randomState', function () {
  it('mints 43-char base64url states that never repeat', function () {
    for (let i = 0; i < 8; i += 1) {
      const state = randomState();
      state.length.should.equal(43); // 32 bytes → 43 chars
      state.should.match(/^[A-Za-z0-9-_]+$/);
    }
    new Set(Array.from({ length: 8 }, () => randomState())).size.should.equal(8);
  });
});

describe('buildAuthorizeUrl', function () {
  it('renders the authorization request with S256 PKCE', function () {
    const url = buildAuthorizeUrl(
      {
        authorizationEndpoint: 'https://idp.example/authorize?tenant=acme',
        clientId: 'web-app',
        redirectUri: 'http://s200.test/callback',
        scope: ['openid', 'profile'],
      },
      { state: 'st-1', nonce: 'nn-1', codeChallenge: 'ch-1' }
    );
    const parsed = new URL(url);
    parsed.origin.should.equal('https://idp.example');
    parsed.pathname.should.equal('/authorize');
    // Existing query on the endpoint survives.
    parsed.searchParams.get('tenant')?.should.equal('acme');
    parsed.searchParams.get('response_type')?.should.equal('code');
    parsed.searchParams.get('client_id')?.should.equal('web-app');
    parsed.searchParams.get('redirect_uri')?.should.equal('http://s200.test/callback');
    parsed.searchParams.get('scope')?.should.equal('openid profile');
    parsed.searchParams.get('state')?.should.equal('st-1');
    parsed.searchParams.get('nonce')?.should.equal('nn-1');
    parsed.searchParams.get('code_challenge')?.should.equal('ch-1');
    parsed.searchParams.get('code_challenge_method')?.should.equal('S256');
  });

  it('omits scope and nonce when absent, accepts a scope string, appends extras last', function () {
    const url = buildAuthorizeUrl(
      {
        authorizationEndpoint: 'https://idp.example/authorize',
        clientId: 'web-app',
        redirectUri: 'http://s200.test/callback',
        scope: 'read write',
        extraParams: { prompt: 'login', resource: 'https://api.example' },
      },
      { state: 'st-2', codeChallenge: 'ch-2' }
    );
    const params = new URL(url).searchParams;
    params.has('nonce').should.be.false;
    params.get('scope')?.should.equal('read write');
    params.get('prompt')?.should.equal('login');
    params.get('resource')?.should.equal('https://api.example');
    params.get('state')?.should.equal('st-2');
    params.get('code_challenge_method')?.should.equal('S256');
  });
});

describe('exchangeCode', function () {
  it('posts the grant with PKCE and Basic client auth', async function () {
    const { fetchFn, calls } = tokenFetch(
      200,
      JSON.stringify({
        access_token: 'at-1',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'rt-1',
        scope: 'openid',
        id_token: 'idt-1',
      })
    );
    const tokens = await exchangeCode(
      { ...CLIENT, fetch: fetchFn },
      { code: 'good-code', codeVerifier: 'verifier-1' }
    );
    tokens.accessToken.should.equal('at-1');
    tokens.tokenType.should.equal('Bearer');
    tokens.expiresIn?.should.equal(3600);
    tokens.refreshToken?.should.equal('rt-1');
    tokens.scope?.should.equal('openid');
    tokens.idToken?.should.equal('idt-1');

    calls.length.should.equal(1);
    const call = calls[0]!;
    call.url.should.equal('https://idp.example/token');
    (call.init.method ?? '').should.equal('POST');
    const headers = new Headers(call.init.headers);
    headers.get('content-type')?.should.equal('application/x-www-form-urlencoded');
    headers.get('authorization')?.should.equal(`Basic ${btoa('web-app:top-secret')}`);
    const body = new URLSearchParams(String(call.init.body));
    body.get('grant_type')?.should.equal('authorization_code');
    body.get('code')?.should.equal('good-code');
    body.get('redirect_uri')?.should.equal('http://s200.test/callback');
    body.get('code_verifier')?.should.equal('verifier-1');
    body.has('client_id').should.be.false;
  });

  it('sends client_id in the body for public clients', async function () {
    const { fetchFn, calls } = tokenFetch(
      200,
      JSON.stringify({ access_token: 'at-2', token_type: 'Bearer' })
    );
    const tokens = await exchangeCode(
      {
        tokenEndpoint: 'https://idp.example/token',
        clientId: 'web-app',
        redirectUri: 'http://s200.test/callback',
        fetch: fetchFn,
      },
      { code: 'c2', codeVerifier: 'v2' }
    );
    tokens.accessToken.should.equal('at-2');
    (tokens.refreshToken === undefined).should.be.true;
    (tokens.idToken === undefined).should.be.true;

    const call = calls[0]!;
    const headers = new Headers(call.init.headers);
    (headers.get('authorization') === null).should.be.true;
    new URLSearchParams(String(call.init.body)).get('client_id')?.should.equal('web-app');
  });

  it('throws a 502 HttpError for a non-2xx token endpoint', async function () {
    const { fetchFn } = tokenFetch(400, JSON.stringify({ error: 'invalid_grant' }));
    const error = (await rejectionOf(
      exchangeCode({ ...CLIENT, fetch: fetchFn }, { code: 'x', codeVerifier: 'v' })
    )) as { status: number; message: string };
    error.status.should.equal(502);
    error.message.should.match(/token exchange failed: HTTP 400/);
  });

  it('throws a 502 when the payload lacks a usable token', async function () {
    const { fetchFn } = tokenFetch(200, JSON.stringify({ scope: 'openid' }));
    const error = (await rejectionOf(
      exchangeCode({ ...CLIENT, fetch: fetchFn }, { code: 'x', codeVerifier: 'v' })
    )) as { status: number; message: string };
    error.status.should.equal(502);
    error.message.should.match(/lacks a token/);
  });
});

describe('refreshToken', function () {
  it('posts the refresh grant with Basic client auth and scope passthrough', async function () {
    const { fetchFn, calls } = tokenFetch(
      200,
      JSON.stringify({
        access_token: 'at-r1',
        token_type: 'Bearer',
        expires_in: 1800,
        scope: 'openid profile',
      })
    );
    const tokens = await refreshToken(
      { ...REFRESH, fetch: fetchFn },
      { refreshToken: 'rt-1', scope: ['openid', 'profile'] }
    );
    tokens.accessToken.should.equal('at-r1');
    tokens.tokenType.should.equal('Bearer');
    tokens.expiresIn?.should.equal(1800);
    tokens.scope?.should.equal('openid profile');
    (tokens.idToken === undefined).should.be.true;

    calls.length.should.equal(1);
    const call = calls[0]!;
    call.url.should.equal('https://refresh.example/token');
    (call.init.method ?? '').should.equal('POST');
    const headers = new Headers(call.init.headers);
    headers.get('content-type')?.should.equal('application/x-www-form-urlencoded');
    headers.get('authorization')?.should.equal(`Basic ${btoa('web-app:top-secret')}`);
    const body = new URLSearchParams(String(call.init.body));
    body.get('grant_type')?.should.equal('refresh_token');
    body.get('refresh_token')?.should.equal('rt-1');
    body.get('scope')?.should.equal('openid profile');
    body.has('client_id').should.be.false;
    body.has('redirect_uri').should.be.false;
    body.has('code_verifier').should.be.false;
  });

  it('sends client_id in the body for public clients and omits scope when absent', async function () {
    const { fetchFn, calls } = tokenFetch(
      200,
      JSON.stringify({ access_token: 'at-r2', token_type: 'Bearer', refresh_token: 'rt-2' })
    );
    const tokens = await refreshToken(
      {
        tokenEndpoint: 'https://refresh.example/token',
        clientId: 'spa-app',
        fetch: fetchFn,
      },
      { refreshToken: 'rt-old' }
    );
    tokens.accessToken.should.equal('at-r2');
    tokens.refreshToken?.should.equal('rt-2');

    const call = calls[0]!;
    const headers = new Headers(call.init.headers);
    (headers.get('authorization') === null).should.be.true;
    const body = new URLSearchParams(String(call.init.body));
    body.get('client_id')?.should.equal('spa-app');
    body.has('scope').should.be.false;
  });

  it('throws a 502 HttpError for a non-2xx token endpoint', async function () {
    const { fetchFn } = tokenFetch(400, JSON.stringify({ error: 'invalid_grant' }));
    const error = (await rejectionOf(
      refreshToken({ ...REFRESH, fetch: fetchFn }, { refreshToken: 'revoked' })
    )) as { status: number; message: string };
    error.status.should.equal(502);
    error.message.should.match(/token exchange failed: HTTP 400/);
  });

  it('throws a 502 when the payload lacks a usable token', async function () {
    const { fetchFn } = tokenFetch(200, JSON.stringify({ scope: 'openid' }));
    const error = (await rejectionOf(
      refreshToken({ ...REFRESH, fetch: fetchFn }, { refreshToken: 'x' })
    )) as { status: number; message: string };
    error.status.should.equal(502);
    error.message.should.match(/lacks a token/);
  });
});

describe('clientCredentials', function () {
  it('posts the client_credentials grant with Basic auth and a scope string', async function () {
    const { fetchFn, calls } = tokenFetch(
      200,
      JSON.stringify({ access_token: 'at-cc1', token_type: 'Bearer', expires_in: 300 })
    );
    const tokens = await clientCredentials(
      { ...MACHINE, fetch: fetchFn },
      { scope: 'orders:read orders:write' }
    );
    tokens.accessToken.should.equal('at-cc1');
    tokens.tokenType.should.equal('Bearer');
    tokens.expiresIn?.should.equal(300);
    (tokens.refreshToken === undefined).should.be.true;
    (tokens.idToken === undefined).should.be.true;

    calls.length.should.equal(1);
    const call = calls[0]!;
    call.url.should.equal('https://machine.example/token');
    (call.init.method ?? '').should.equal('POST');
    const headers = new Headers(call.init.headers);
    headers.get('content-type')?.should.equal('application/x-www-form-urlencoded');
    headers.get('authorization')?.should.equal(`Basic ${btoa('worker:machine-secret')}`);
    const body = new URLSearchParams(String(call.init.body));
    body.get('grant_type')?.should.equal('client_credentials');
    body.get('scope')?.should.equal('orders:read orders:write');
    body.has('client_id').should.be.false;
    body.has('redirect_uri').should.be.false;
  });

  it('omits scope when absent', async function () {
    const { fetchFn, calls } = tokenFetch(
      200,
      JSON.stringify({ access_token: 'at-cc2', token_type: 'Bearer' })
    );
    const tokens = await clientCredentials({ ...MACHINE, fetch: fetchFn }, {});
    tokens.accessToken.should.equal('at-cc2');
    const body = new URLSearchParams(String(calls[0]!.init.body));
    body.get('grant_type')?.should.equal('client_credentials');
    body.has('scope').should.be.false;
  });

  it('throws a 502 HttpError for a non-2xx token endpoint', async function () {
    const { fetchFn } = tokenFetch(401, JSON.stringify({ error: 'invalid_client' }));
    const error = (await rejectionOf(
      clientCredentials({ ...MACHINE, fetch: fetchFn }, {})
    )) as { status: number; message: string };
    error.status.should.equal(502);
    error.message.should.match(/token exchange failed: HTTP 401/);
  });

  it('throws a 502 when the payload lacks a usable token', async function () {
    const { fetchFn } = tokenFetch(200, JSON.stringify({ scope: 'orders:read' }));
    const error = (await rejectionOf(
      clientCredentials({ ...MACHINE, fetch: fetchFn }, {})
    )) as { status: number; message: string };
    error.status.should.equal(502);
    error.message.should.match(/lacks a token/);
  });
});
