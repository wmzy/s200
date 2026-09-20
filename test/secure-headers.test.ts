import { describe, it } from 'vitest';

import { createApp, get, handle, use } from '../src/app';
import { json } from '../src/respond';
import { secureHeaders } from '../src/secure-headers';

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
});
