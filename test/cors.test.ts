import { describe, it } from 'vitest';

import { createApp, get, handle, post, use } from '../src/app';
import { cors } from '../src/cors';
import { text } from '../src/respond';

function preflight(path: string, headers: Record<string, string>): Request {
  return new Request(`http://localhost${path}`, {
    method: 'OPTIONS',
    headers: { origin: 'https://app.example', ...headers },
  });
}

describe('cors', function () {
  it('answers preflights in place with a 204 and echoes the requested values', async function () {
    let handled = false;
    const app = createApp();
    use(app, cors());
    post(app, '/submit', () => {
      handled = true;
      return new Response('done');
    });
    const res = await handle(
      app,
      preflight('/submit', {
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, x-custom',
      })
    );
    res.status.should.equal(204);
    (res.headers.get('access-control-allow-origin') ?? '').should.equal('*');
    (res.headers.get('access-control-allow-methods') ?? '').should.equal('POST');
    (res.headers.get('access-control-allow-headers') ?? '').should.equal(
      'content-type, x-custom'
    );
    handled.should.be.false;
  });

  it('answers a preflight for a method-less path instead of 405ing', async function () {
    const app = createApp();
    use(app, cors());
    get(app, '/x', () => new Response('get'));
    const res = await handle(
      app,
      preflight('/x', { 'access-control-request-method': 'POST' })
    );
    res.status.should.equal(204);
  });

  it('stamps the allow-origin header onto actual responses', async function () {
    const app = createApp();
    use(app, cors());
    post(app, '/submit', (ctx) => text(ctx, 'ok'));
    const res = await handle(
      app,
      new Request('http://localhost/submit', {
        method: 'POST',
        headers: { origin: 'https://app.example' },
      })
    );
    res.status.should.equal(200);
    (res.headers.get('access-control-allow-origin') ?? '').should.equal('*');
  });

  it('leaves non-CORS requests untouched', async function () {
    const app = createApp();
    use(app, cors());
    get(app, '/x', () => new Response('ok'));
    const res = await handle(app, new Request('http://localhost/x'));
    (res.headers.get('access-control-allow-origin') === null).should.be.true;
  });

  it('reflects a fixed origin and adds credentials + Vary', async function () {
    const app = createApp();
    use(app, cors({ origin: 'https://app.example', credentials: true }));
    get(app, '/x', () => new Response('ok'));
    const res = await handle(
      app,
      new Request('http://localhost/x', {
        headers: { origin: 'https://app.example' },
      })
    );
    (res.headers.get('access-control-allow-origin') ?? '').should.equal(
      'https://app.example'
    );
    (res.headers.get('access-control-allow-credentials') ?? '').should.equal('true');
    (res.headers.get('vary') ?? '').should.equal('origin');
  });

  it('reflects allowlisted origins and omits headers otherwise', async function () {
    const app = createApp();
    use(app, cors({ origin: ['https://a.example', 'https://b.example'] }));
    get(app, '/x', () => new Response('ok'));
    const allowed = await handle(
      app,
      new Request('http://localhost/x', {
        headers: { origin: 'https://b.example' },
      })
    );
    (allowed.headers.get('access-control-allow-origin') ?? '').should.equal(
      'https://b.example'
    );
    const denied = await handle(
      app,
      new Request('http://localhost/x', {
        headers: { origin: 'https://evil.example' },
      })
    );
    (denied.headers.get('access-control-allow-origin') === null).should.be.true;
  });

  it('supports a per-request origin resolver', async function () {
    const app = createApp();
    use(
      app,
      cors({
        origin: (ctx) =>
          ctx.query.get('allow') === '1' ? 'https://dynamic.example' : undefined,
      })
    );
    get(app, '/x', () => new Response('ok'));
    const ok = await handle(
      app,
      new Request('http://localhost/x?allow=1', {
        headers: { origin: 'https://dynamic.example' },
      })
    );
    (ok.headers.get('access-control-allow-origin') ?? '').should.equal(
      'https://dynamic.example'
    );
    const blocked = await handle(
      app,
      new Request('http://localhost/x', {
        headers: { origin: 'https://dynamic.example' },
      })
    );
    (blocked.headers.get('access-control-allow-origin') === null).should.be.true;
  });

  it('applies configured preflight methods, headers and max-age', async function () {
    const app = createApp();
    use(app, cors({ methods: 'GET, POST', headers: ['x-a', 'x-b'], maxAge: 600 }));
    get(app, '/x', () => new Response('ok'));
    const res = await handle(
      app,
      preflight('/x', { 'access-control-request-method': 'PATCH' })
    );
    (res.headers.get('access-control-allow-methods') ?? '').should.equal('GET, POST');
    (res.headers.get('access-control-allow-headers') ?? '').should.equal('x-a, x-b');
    (res.headers.get('access-control-max-age') ?? '').should.equal('600');
  });

  it('stamps expose-headers onto actual responses', async function () {
    const app = createApp();
    use(app, cors({ exposeHeaders: ['x-request-id', 'x-total-count'] }));
    get(app, '/x', () => new Response('ok'));
    const res = await handle(
      app,
      new Request('http://localhost/x', { headers: { origin: 'https://app.example' } })
    );
    (res.headers.get('access-control-expose-headers') ?? '').should.equal(
      'x-request-id, x-total-count'
    );
  });

  it('stamps CORS headers onto fallback responses too', async function () {
    const app = createApp();
    use(app, cors({ origin: 'https://app.example' }));
    get(app, '/x', () => new Response('ok'));
    const res = await handle(
      app,
      new Request('http://localhost/nope', { headers: { origin: 'https://app.example' } })
    );
    res.status.should.equal(404);
    (res.headers.get('access-control-allow-origin') ?? '').should.equal(
      'https://app.example'
    );
  });
});
