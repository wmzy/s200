import { describe, it } from 'vitest';

import { createApp, get } from '../src/app';
import { swaggerUi } from '../src/swagger';
import { request } from '../src/test';

describe('swaggerUi', () => {
  it('serves the Scalar page as 200 text/html pointing at the spec', async () => {
    const app = get(
      createApp(),
      '/docs',
      (ctx) => swaggerUi(ctx, { url: '/openapi.json' })
    );
    const res = await request(app, '/docs');
    res.status.should.equal(200);
    (res.headers.get('content-type') ?? '').should.equal(
      'text/html; charset=utf-8'
    );
    const body = await res.text();
    body.should.contain('<script id="api-reference" data-url="/openapi.json"');
    body.should.contain(
      'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.72.1'
    );
  });

  it('escapes a url carrying quotes and angle brackets', async () => {
    const url = '/spec?a=1&b="><script>alert(1)</script>';
    const app = get(createApp(), '/docs', (ctx) => swaggerUi(ctx, { url }));
    const res = await request(app, '/docs');
    const body = await res.text();
    // The attribute is delimited by raw double quotes, so the payload's
    // quotes must survive as entities — nothing may break out.
    body.should.contain(
      'data-url="/spec?a=1&amp;b=&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"'
    );
    body.should.not.contain('"><script>alert(1)');
    // The entity round-trip gives Scalar back exactly what was configured.
    const attr = body.match(/data-url="([^"]*)"/)![1] ?? '';
    attr
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .should.equal(url);
  });

  it('reflects a custom title and cdn', async () => {
    const app = get(
      createApp(),
      '/docs',
      (ctx) =>
        swaggerUi(ctx, {
          url: '/openapi.json',
          title: 'Users API Docs',
          cdn: 'https://mirror.internal/scalar.js',
        })
    );
    const res = await request(app, '/docs');
    const body = await res.text();
    body.should.contain('<title>Users API Docs</title>');
    body.should.contain('<script src="https://mirror.internal/scalar.js">');
  });

  it('defaults the title and carries the theme in data-configuration', async () => {
    const app = get(
      createApp(),
      '/docs',
      (ctx) => swaggerUi(ctx, { url: '/openapi.json', theme: 'kepler' })
    );
    const res = await request(app, '/docs');
    const body = await res.text();
    body.should.contain('<title>API Reference</title>');
    body.should.contain(
      'data-configuration="{&quot;theme&quot;:&quot;kepler&quot;}"'
    );
  });

  it('advertises content-length for the exact body bytes (html contract)', async () => {
    const app = get(
      createApp(),
      '/docs',
      (ctx) => swaggerUi(ctx, { url: '/openapi.json', title: 'Zoé — docs' })
    );
    const res = await request(app, '/docs');
    const body = await res.text();
    res.headers
      .get('content-length')!
      .should.equal(String(new TextEncoder().encode(body).byteLength));
  });
});
