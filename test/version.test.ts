import type { ApiVersionOptions } from '../src/version';

import { describe, it } from 'vitest';

import { createApp, get, handle, use } from '../src/app';
import { json } from '../src/respond';
import { apiVersion } from '../src/version';

describe('apiVersion (header strategy)', function () {
  it('resolves x-api-version, stamps state.version, and varies on the header', async function () {
    const app = createApp();
    use(app, apiVersion({ versions: ['1', '2'] }));
    get(app, '/', (ctx) => json(ctx, { version: ctx.state.version as string }));

    const res = await handle(app, new Request('http://localhost/', { headers: { 'x-api-version': '2' } }));
    (await res.json()).should.deep.equal({ version: '2' });
    (res.headers.get('vary') ?? '').should.equal('x-api-version');
  });

  it('honors a custom header name for both lookup and Vary', async function () {
    const app = createApp();
    use(app, apiVersion({ header: 'x-version', versions: ['1'] }));
    get(app, '/', (ctx) => json(ctx, { version: ctx.state.version as string }));

    const res = await handle(app, new Request('http://localhost/', { headers: { 'x-version': '1' } }));
    (await res.json()).should.deep.equal({ version: '1' });
    (res.headers.get('vary') ?? '').should.equal('x-version');
  });

  it('falls back to the default version when the header is missing or blank', async function () {
    const app = createApp();
    use(app, apiVersion({ versions: ['1', '2'], default: '1' }));
    get(app, '/', (ctx) => json(ctx, { version: ctx.state.version as string }));

    const missing = await handle(app, new Request('http://localhost/'));
    (await missing.json()).should.deep.equal({ version: '1' });
    const blank = await handle(app, new Request('http://localhost/', { headers: { 'x-api-version': '  ' } }));
    (await blank.json()).should.deep.equal({ version: '1' });
  });

  it('answers 404 "API version required" when no version and no default', async function () {
    let handled = 0;
    const app = createApp();
    use(app, apiVersion({ versions: ['1'] }));
    get(app, '/', () => {
      handled += 1;
      return new Response('ok');
    });

    const res = await handle(app, new Request('http://localhost/'));
    res.status.should.equal(404);
    (await res.json()).should.deep.equal({ error: 'API version required' });
    handled.should.equal(0);
  });

  it('answers 404 "not supported" naming the carried version, even with a default', async function () {
    let handled = 0;
    const app = createApp();
    use(app, apiVersion({ versions: ['1', '2'], default: '1' }));
    get(app, '/', () => {
      handled += 1;
      return new Response('ok');
    });

    const res = await handle(app, new Request('http://localhost/', { headers: { 'x-api-version': '9' } }));
    res.status.should.equal(404);
    (await res.json()).should.deep.equal({ error: 'API version not supported: 9' });
    handled.should.equal(0);
  });

  it('merges Vary with headers the chain already set, without duplicating', async function () {
    const app = createApp();
    use(app, apiVersion({ versions: ['1'], default: '1' }));
    get(app, '/', () => new Response('ok', { headers: { vary: 'origin' } }));
    get(app, '/dup', () => new Response('ok', { headers: { vary: 'X-Api-Version' } }));

    const merged = await handle(app, new Request('http://localhost/'));
    (merged.headers.get('vary') ?? '').should.equal('origin, x-api-version');
    const dup = await handle(app, new Request('http://localhost/dup'));
    (dup.headers.get('vary') ?? '').should.equal('X-Api-Version');
  });
});

describe('apiVersion (mediaType strategy)', function () {
  it('reads the version parameter of the vendor JSON type and varies on Accept', async function () {
    const app = createApp();
    use(app, apiVersion({ strategy: 'mediaType', versions: ['1', '2'] }));
    get(app, '/', (ctx) => json(ctx, { version: ctx.state.version as string }));

    const res = await handle(
      app,
      new Request('http://localhost/', {
        headers: { accept: 'application/vnd.api+json;version=2' },
      })
    );
    (await res.json()).should.deep.equal({ version: '2' });
    (res.headers.get('vary') ?? '').should.equal('Accept');
  });

  it('matches a custom vendor subtype with interleaved params (q ignored)', async function () {
    const app = createApp();
    use(app, apiVersion({ strategy: 'mediaType', mediaType: 'vnd.myapp', versions: ['1'] }));
    get(app, '/', (ctx) => json(ctx, { version: ctx.state.version as string }));

    const res = await handle(
      app,
      new Request('http://localhost/', {
        headers: { accept: 'application/vnd.myapp+json; q=0.9; version=1' },
      })
    );
    (await res.json()).should.deep.equal({ version: '1' });
  });

  it('scans past non-vendor entries and unquotes quoted values, case-insensitively', async function () {
    const app = createApp();
    use(app, apiVersion({ strategy: 'mediaType', versions: ['2'] }));
    get(app, '/', (ctx) => json(ctx, { version: ctx.state.version as string }));

    const res = await handle(
      app,
      new Request('http://localhost/', {
        headers: { accept: 'text/html, APPLICATION/VND.API+JSON;VERSION="2"' },
      })
    );
    (await res.json()).should.deep.equal({ version: '2' });
  });

  it('treats a vendor entry without a version parameter as versionless — default applies', async function () {
    const app = createApp();
    use(app, apiVersion({ strategy: 'mediaType', versions: ['1', '2'], default: '2' }));
    get(app, '/', (ctx) => json(ctx, { version: ctx.state.version as string }));

    const res = await handle(
      app,
      new Request('http://localhost/', {
        headers: { accept: 'application/vnd.api+json' },
      })
    );
    (await res.json()).should.deep.equal({ version: '2' });
  });

  it('answers 404 "required" when Accept carries no vendor type and there is no default', async function () {
    let handled = 0;
    const app = createApp();
    use(app, apiVersion({ strategy: 'mediaType', versions: ['1'] }));
    get(app, '/', () => {
      handled += 1;
      return new Response('ok');
    });

    const res = await handle(
      app,
      new Request('http://localhost/', { headers: { accept: 'application/json' } })
    );
    res.status.should.equal(404);
    (await res.json()).should.deep.equal({ error: 'API version required' });
    handled.should.equal(0);
  });

  it('answers 404 "not supported" for an unsupported media-type version', async function () {
    const app = createApp();
    use(app, apiVersion({ strategy: 'mediaType', versions: ['1'] }));
    get(app, '/', () => new Response('ok'));

    const res = await handle(
      app,
      new Request('http://localhost/', {
        headers: { accept: 'application/vnd.api+json;version=3' },
      })
    );
    res.status.should.equal(404);
    (await res.json()).should.deep.equal({ error: 'API version not supported: 3' });
  });
});

describe('apiVersion creation', function () {
  it('rejects an empty versions list', function () {
    (() => apiVersion({ versions: [] })).should.throw('non-empty');
  });

  it('rejects a missing versions list', function () {
    const noVersions = {} as { versions?: readonly string[] };
    (() => apiVersion(noVersions as ApiVersionOptions)).should.throw('non-empty');
  });
});
