import { describe, it } from 'vitest';

import { createApp, get, handle, use } from '../src/app';
import { json } from '../src/respond';
import { cspNonce, secureHeaders } from '../src/secure-headers';

describe('secureHeaders', () => {
  it('stamps the default baseline onto responses', async () => {
    const app = createApp();
    use(app, secureHeaders());
    get(app, '/', (ctx) => json(ctx, { ok: true }));
    const res = await handle(app, new Request('http://localhost/'));
    res.status.should.equal(200);
    res.headers.get('x-content-type-options')!.should.equal('nosniff');
    res.headers.get('x-frame-options')!.should.equal('DENY');
    res.headers.get('referrer-policy')!.should.equal('strict-origin-when-cross-origin');
  });

  it('stamps fallback 404 and 500 responses too — they materialize in-chain', async () => {
    const app = createApp();
    use(app, secureHeaders());
    get(app, '/boom', () => {
      throw new Error('boom');
    });
    const missing = await handle(app, new Request('http://localhost/nope'));
    missing.status.should.equal(404);
    missing.headers.get('x-frame-options')!.should.equal('DENY');
    const error = await handle(app, new Request('http://localhost/boom'));
    error.status.should.equal(500);
    error.headers.get('x-frame-options')!.should.equal('DENY');
  });

  it('overrides defaults and supports opt-in HSTS', async () => {
    const app = createApp();
    use(
      app,
      secureHeaders({
        xFrameOptions: 'SAMEORIGIN',
        strictTransportSecurity: 'max-age=3600',
      })
    );
    get(app, '/', () => new Response('ok'));
    const res = await handle(app, new Request('http://localhost/'));
    res.headers.get('x-frame-options')!.should.equal('SAMEORIGIN');
    res.headers.get('strict-transport-security')!.should.equal('max-age=3600');
  });

  it('drops headers set to false', async () => {
    const app = createApp();
    use(app, secureHeaders({ xFrameOptions: false }));
    get(app, '/', () => new Response('ok'));
    const res = await handle(app, new Request('http://localhost/'));
    res.headers.has('x-frame-options').should.be.false;
    res.headers.get('x-content-type-options')!.should.equal('nosniff');
  });

  it('never overwrites headers the response already set', async () => {
    const app = createApp();
    use(app, secureHeaders());
    get(app, '/', () =>
      new Response('ok', { headers: { 'x-frame-options': 'ALLOWALL' } })
    );
    const res = await handle(app, new Request('http://localhost/'));
    res.headers.get('x-frame-options')!.should.equal('ALLOWALL');
  });

  it('stamps the default cross-origin isolation pair', async () => {
    const app = createApp();
    use(app, secureHeaders());
    get(app, '/', () => new Response('ok'));
    const res = await handle(app, new Request('http://localhost/'));
    res.headers.get('cross-origin-opener-policy')!.should.equal('same-origin');
    res.headers.get('cross-origin-resource-policy')!.should.equal('same-origin');
    // Opt-in headers stay off by default.
    res.headers.has('cross-origin-embedder-policy').should.be.false;
    res.headers.has('content-security-policy').should.be.false;
    res.headers.has('permissions-policy').should.be.false;
    res.headers.has('x-dns-prefetch-control').should.be.false;
  });

  it('overrides and opts out of the cross-origin headers', async () => {
    const app = createApp();
    use(
      app,
      secureHeaders({
        crossOriginOpenerPolicy: 'same-origin-allow-popups',
        crossOriginResourcePolicy: 'cross-origin',
        crossOriginEmbedderPolicy: 'require-corp',
      })
    );
    get(app, '/', () => new Response('ok'));
    const res = await handle(app, new Request('http://localhost/'));
    res.headers.get('cross-origin-opener-policy')!.should.equal('same-origin-allow-popups');
    res.headers.get('cross-origin-resource-policy')!.should.equal('cross-origin');
    res.headers.get('cross-origin-embedder-policy')!.should.equal('require-corp');
    const off = createApp();
    use(off, secureHeaders({ crossOriginOpenerPolicy: false, crossOriginResourcePolicy: false }));
    get(off, '/', () => new Response('ok'));
    const resOff = await handle(off, new Request('http://localhost/'));
    resOff.headers.has('cross-origin-opener-policy').should.be.false;
    resOff.headers.has('cross-origin-resource-policy').should.be.false;
  });

  it('accepts a raw CSP string or a directives object', async () => {
    const raw = createApp();
    use(raw, secureHeaders({ contentSecurityPolicy: "default-src 'none'; frame-ancestors 'none'" }));
    get(raw, '/', () => new Response('ok'));
    const resRaw = await handle(raw, new Request('http://localhost/'));
    resRaw.headers.get('content-security-policy')!.should.equal(
      "default-src 'none'; frame-ancestors 'none'"
    );
    const built = createApp();
    use(
      built,
      secureHeaders({
        contentSecurityPolicy: {
          'default-src': ["'self'"],
          'script-src': ["'self'", "'unsafe-inline'"],
          'upgrade-insecure-requests': [],
        },
      })
    );
    get(built, '/', () => new Response('ok'));
    const resBuilt = await handle(built, new Request('http://localhost/'));
    resBuilt.headers.get('content-security-policy')!.should.equal(
      "default-src 'self'; script-src 'self' 'unsafe-inline'; upgrade-insecure-requests"
    );
  });

  it('serializes permissions-policy directives', async () => {
    const app = createApp();
    use(
      app,
      secureHeaders({
        // The object form serializes CSP-style (space-joined values,
        // `; ` between directives); Permissions-Policy's parenthesised
        // comma syntax is a raw string away.
        permissionsPolicy: { geolocation: ['self'], camera: '()' },
      })
    );
    get(app, '/', () => new Response('ok'));
    const res = await handle(app, new Request('http://localhost/'));
    res.headers.get('permissions-policy')!.should.equal('geolocation self; camera ()');
  });

  it('accepts a raw permissions-policy string', async () => {
    const app = createApp();
    use(app, secureHeaders({ permissionsPolicy: 'camera=(), geolocation=(self)' }));
    get(app, '/', () => new Response('ok'));
    const res = await handle(app, new Request('http://localhost/'));
    res.headers
      .get('permissions-policy')!
      .should.equal('camera=(), geolocation=(self)');
  });

  it('opts DNS prefetch control in and out', async () => {
    const app = createApp();
    use(app, secureHeaders({ xDnsPrefetchControl: 'off' }));
    get(app, '/', () => new Response('ok'));
    const res = await handle(app, new Request('http://localhost/'));
    res.headers.get('x-dns-prefetch-control')!.should.equal('off');
  });

  it('strips named headers from every response', async () => {
    const app = createApp();
    use(app, secureHeaders({ removeHeaders: ['x-powered-by'] }));
    get(app, '/', () => new Response('ok', { headers: { 'x-powered-by': 's200' } }));
    const res = await handle(app, new Request('http://localhost/'));
    res.headers.has('x-powered-by').should.be.false;
    // Removal wins over the baseline fill too — a named header is gone
    // from every response.
    const alsoDefault = createApp();
    use(alsoDefault, secureHeaders({ removeHeaders: ['x-frame-options'] }));
    get(alsoDefault, '/', () => new Response('ok'));
    const resDefault = await handle(alsoDefault, new Request('http://localhost/'));
    resDefault.headers.has('x-frame-options').should.be.false;
    resDefault.headers.get('x-content-type-options')!.should.equal('nosniff');
  });

  it('never overwrites an opted-in header the response already set', async () => {
    const app = createApp();
    use(
      app,
      secureHeaders({
        contentSecurityPolicy: "default-src 'self'",
        crossOriginEmbedderPolicy: 'require-corp',
      })
    );
    get(app, '/', () =>
      new Response('ok', {
        headers: {
          'content-security-policy': "default-src 'none'",
          'cross-origin-embedder-policy': 'credentialless',
        },
      })
    );
    const res = await handle(app, new Request('http://localhost/'));
    res.headers.get('content-security-policy')!.should.equal("default-src 'none'");
    res.headers.get('cross-origin-embedder-policy')!.should.equal('credentialless');
  });
});

describe('cspNonce', () => {
  it('yields 24-char base64 for a fresh 128-bit value', () => {
    const nonce = cspNonce();
    nonce.should.match(/^[A-Za-z0-9+/]{22}==$/);
  });

  it('never repeats across calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 256; i++) seen.add(cspNonce());
    seen.size.should.equal(256);
  });

  it('rides the per-request middleware pattern', async () => {
    const app = createApp();
    use(app, secureHeaders());
    use(app, async (ctx, next) => {
      const nonce = cspNonce();
      await next();
      ctx.res?.headers.set(
        'content-security-policy',
        `default-src 'self'; script-src 'nonce-${nonce}'`
      );
    });
    get(app, '/', () => new Response('<script>ok</script>'));
    const res = await handle(app, new Request('http://localhost/'));
    res.headers.get('content-security-policy')!.should.match(
      /^default-src 'self'; script-src 'nonce-[A-Za-z0-9+/]{22}=='$/
    );
  });
});
