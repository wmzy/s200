import { describe, it } from 'vitest';

import { createApp, get, use, handle  } from '../src/app';
import { redirect } from '../src/respond';
import { trustProxy } from '../src/trust-proxy';

describe('trust-proxy', () => {
  it('rewrites the URL from forwarded headers and records the client IP', async () => {
    const app = createApp();
    use(app, trustProxy());
    get(app, '/who', (ctx) => {
      const info = (ctx.state as { proxy?: { clientIp?: string } }).proxy;
      return new Response(
        JSON.stringify({ origin: ctx.url.origin, ip: info?.clientIp })
      );
    });

    const res = await handle(
      app,
      new Request('http://localhost/who', {
        headers: {
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'example.com',
          'x-forwarded-for': '10.0.0.1, 203.0.113.9',
        },
      })
    );
    const body = (await res.json()) as { origin: string; ip?: string };
    body.origin.should.equal('https://example.com');
    // hops=1: the rightmost address — the one our own proxy appended.
    body.ip?.should.equal('203.0.113.9');
  });

  it('counts hops from the right and leaves plain requests untouched', async () => {
    const app = createApp();
    use(app, trustProxy({ hops: 2 }));
    get(app, '/ip', (ctx) => {
      const info = (ctx.state as { proxy?: { clientIp?: string } }).proxy;
      return new Response(info?.clientIp ?? 'none');
    });

    const proxied = await handle(
      app,
      new Request('http://localhost/ip', {
        headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.1, 203.0.113.9' },
      })
    );
    (await proxied.text()).should.equal('10.0.0.1');

    const direct = await handle(app, new Request('http://localhost/ip'));
    (await direct.text()).should.equal('none');
  });

  it('gives handlers the corrected origin for absolute URL building', async () => {
    const app = createApp();
    use(app, trustProxy());
    get(app, '/go', (ctx) => redirect(ctx, new URL('/target', ctx.url).href));

    // The request URL's origin is what absolute building resolves against;
    // behind a TLS-terminating proxy that must be the public https origin.
    const res = await handle(
      app,
      new Request('http://localhost/go', {
        headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'app.example' },
      })
    );
    res.headers.get('location')?.should.equal('https://app.example/target');
  });

  it('ignores malformed forwarded hosts instead of throwing', async () => {
    const app = createApp();
    use(app, trustProxy());
    get(app, '/x', (ctx) => new Response(ctx.url.href));

    const res = await handle(
      app,
      new Request('http://localhost/x', {
        headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'exa mple.com' },
      })
    );
    // proto applies; the bad host falls back to the request URL's.
    (await res.text()).should.equal('https://localhost/x');
  });
});
