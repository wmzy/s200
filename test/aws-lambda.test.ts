import type { FinishInfo } from '../src/finish';
import type {
  LambdaEventV2,
  LambdaHandler,
  LambdaResultV2,
} from '../src/aws-lambda';

import { describe, expectTypeOf, it } from 'vitest';

import { createApp, get, post } from '../src/app';
import { createLambdaHandler } from '../src/aws-lambda';
import { setCookie } from '../src/cookies';
import { onFinish } from '../src/finish';
import { json, send, text } from '../src/respond';

/** Minimal v2 event with the fields the adapter reads, overridable per test. */
function event(overrides: Partial<LambdaEventV2> = {}): LambdaEventV2 {
  return {
    version: '2.0',
    routeKey: 'ANY /{proxy+}',
    rawPath: '/hello',
    rawQueryString: '',
    headers: { host: 'example.execute-api.us-east-1.amazonaws.com' },
    isBase64Encoded: false,
    requestContext: { http: { method: 'GET', sourceIp: '203.0.113.7' } },
    ...overrides,
  };
}

describe('aws-lambda createLambdaHandler', () => {
  it('returns the v2 handler shape', async () => {
    const handler = createLambdaHandler(createApp());
    expectTypeOf(handler).toEqualTypeOf<LambdaHandler>();
    const result = await handler(event({ rawPath: '/unmatched' }));
    expectTypeOf(result).toEqualTypeOf<LambdaResultV2>();
    result.statusCode.should.equal(404);
  });

  it('maps a bodyless GET event to a Request and the response to v2', async () => {
    const app = createApp();
    get(app, '/hello', (ctx) => json(ctx, { hello: 'lambda' }));
    const result = await createLambdaHandler(app)(event());
    result.statusCode.should.equal(200);
    (result.headers?.['content-type'] ?? '').should.equal('application/json');
    result.isBase64Encoded.should.equal(false);
    JSON.parse(result.body ?? '').should.deep.equal({ hello: 'lambda' });
  });

  it('keeps the raw query string on the URL', async () => {
    const app = createApp();
    get(app, '/url', (ctx) => text(ctx, ctx.req.url));
    const result = await createLambdaHandler(app)(
      event({ rawPath: '/url', rawQueryString: 'q=1&r=%E4%B8%AD' })
    );
    (result.body ?? '').should.equal(
      'https://example.execute-api.us-east-1.amazonaws.com/url?q=1&r=%E4%B8%AD'
    );
  });

  it('falls back to a localhost host when the event carries none', async () => {
    const app = createApp();
    get(app, '/url', (ctx) => text(ctx, ctx.req.url));
    const result = await createLambdaHandler(app)(
      event({ rawPath: '/url', headers: {} })
    );
    (result.body ?? '').should.equal('https://localhost/url');
  });

  it('falls back to localhost when the host would move the path', async () => {
    const app = createApp();
    get(app, '/hello', (ctx) => text(ctx, 'hello'));
    get(app, '/admin/hello', (ctx) => text(ctx, 'admin'));
    const result = await createLambdaHandler(app)(
      event({ headers: { host: 'evil.example/../admin' } })
    );
    result.statusCode.should.equal(200);
    // The `/../` is a URL dot segment: unguarded, the request would be
    // dispatched to the admin route.
    (result.body ?? '').should.equal('hello');
  });

  it('falls back to localhost for a host the URL parser rejects', async () => {
    const app = createApp();
    get(app, '/url', (ctx) => text(ctx, ctx.req.url));
    const handler = createLambdaHandler(app);
    const unbalanced = await handler(
      event({ rawPath: '/url', headers: { host: '[' } })
    );
    unbalanced.statusCode.should.equal(200);
    (unbalanced.body ?? '').should.equal('https://localhost/url');
    const badPort = await handler(
      event({ rawPath: '/url', headers: { host: 'x.example:65536' } })
    );
    (badPort.body ?? '').should.equal('https://localhost/url');
  });

  it('answers a GET event that carries an empty body', async () => {
    const app = createApp();
    get(app, '/hello', (ctx) => json(ctx, { hello: 'lambda' }));
    const result = await createLambdaHandler(app)(event({ body: '' }));
    result.statusCode.should.equal(200);
    JSON.parse(result.body ?? '').should.deep.equal({ hello: 'lambda' });
  });

  it('answers a GET event that carries a body, dropping it', async () => {
    const app = createApp();
    get(app, '/hello', async (ctx) =>
      json(ctx, { body: await ctx.req.text() })
    );
    const result = await createLambdaHandler(app)(event({ body: 'x' }));
    result.statusCode.should.equal(200);
    JSON.parse(result.body ?? '').should.deep.equal({ body: '' });
  });

  it('treats a null body as no body', async () => {
    const app = createApp();
    post(app, '/echo', async (ctx) =>
      json(ctx, { body: await ctx.req.text() })
    );
    const result = await createLambdaHandler(app)(
      event({
        rawPath: '/echo',
        requestContext: { http: { method: 'POST', sourceIp: '203.0.113.7' } },
        body: null,
      })
    );
    result.statusCode.should.equal(200);
    JSON.parse(result.body ?? '').should.deep.equal({ body: '' });
  });

  it('passes a textual POST body through to the handler', async () => {
    const app = createApp();
    post(app, '/echo', async (ctx) => json(ctx, { got: await ctx.req.json() }));
    const result = await createLambdaHandler(app)(
      event({
        rawPath: '/echo',
        headers: { host: 'x.example', 'content-type': 'application/json' },
        requestContext: { http: { method: 'POST', sourceIp: '203.0.113.7' } },
        body: JSON.stringify({ ping: 'pong' }),
      })
    );
    JSON.parse(result.body ?? '').should.deep.equal({ got: { ping: 'pong' } });
  });

  it('base64-decodes a binary request body', async () => {
    const app = createApp();
    post(app, '/bytes', async (ctx) => {
      const bytes = new Uint8Array(await ctx.req.arrayBuffer());
      return json(ctx, {
        sum: bytes.length + (bytes[0] ?? 0) + (bytes[bytes.length - 1] ?? 0),
      });
    });
    const result = await createLambdaHandler(app)(
      event({
        rawPath: '/bytes',
        headers: {
          host: 'x.example',
          'content-type': 'application/octet-stream',
        },
        requestContext: { http: { method: 'POST', sourceIp: '203.0.113.7' } },
        isBase64Encoded: true,
        body: Buffer.from([1, 2, 3, 250]).toString('base64'),
      })
    );
    JSON.parse(result.body ?? '').should.deep.equal({ sum: 255 });
  });

  it('recomposes the split cookies array into one Cookie header', async () => {
    const app = createApp();
    get(app, '/cookie', (ctx) =>
      text(ctx, ctx.req.headers.get('cookie') ?? '')
    );
    const result = await createLambdaHandler(app)(
      event({ rawPath: '/cookie', cookies: ['a=1', 'b=2'] })
    );
    (result.body ?? '').should.equal('a=1; b=2');
  });

  it('splits Set-Cookie into the cookies array and out of headers', async () => {
    const app = createApp();
    get(app, '/login', (ctx) => {
      const res = json(ctx, { ok: true });
      setCookie(ctx, 'session', 'abc');
      setCookie(ctx, 'theme', 'dark');
      return res;
    });
    const result = await createLambdaHandler(app)(event({ rawPath: '/login' }));
    (result.cookies?.length ?? 0).should.equal(2);
    (result.cookies?.[0] ?? '').startsWith('session=').should.equal(true);
    (result.cookies?.[1] ?? '').startsWith('theme=').should.equal(true);
    // v2 carries cookies separately — the flat record must not hold a
    // comma-joined impostor.
    Object.keys(result.headers ?? {})
      .includes('set-cookie')
      .should.equal(false);
  });

  it('base64-encodes a binary response', async () => {
    const app = createApp();
    get(app, '/img', (ctx) =>
      send(ctx, new Uint8Array([137, 80, 78, 71]), {
        headers: { 'content-type': 'image/png' },
      })
    );
    const result = await createLambdaHandler(app)(event({ rawPath: '/img' }));
    result.isBase64Encoded.should.equal(true);
    Buffer.from(result.body ?? '', 'base64')
      .toString('hex')
      .should.equal(Buffer.from([137, 80, 78, 71]).toString('hex'));
  });

  it('keeps textual responses as plain strings', async () => {
    const app = createApp();
    get(app, '/', (ctx) => text(ctx, '<h1>hello</h1>'));
    const result = await createLambdaHandler(app)(event({ rawPath: '/' }));
    result.isBase64Encoded.should.equal(false);
    (result.body ?? '').should.equal('<h1>hello</h1>');
    (result.headers?.['content-type'] ?? '').should.equal(
      'text/plain; charset=utf-8'
    );
  });

  it('omits the body for null-body responses (204)', async () => {
    const app = createApp();
    get(app, '/gone', (ctx) => send(ctx, null, { status: 204 }));
    const result = await createLambdaHandler(app)(event({ rawPath: '/gone' }));
    result.statusCode.should.equal(204);
    (result.body === undefined).should.equal(true);
  });

  it('materializes the 404 fallback inside the result', async () => {
    const app = createApp();
    get(app, '/hello', (ctx) => json(ctx, { hello: 'lambda' }));
    const result = await createLambdaHandler(app)(event({ rawPath: '/nope' }));
    result.statusCode.should.equal(404);
    result.isBase64Encoded.should.equal(false);
    JSON.parse(result.body ?? '').should.have.property('error');
  });

  it('runs onFinish as completed once the result is buffered', async () => {
    const app = createApp();
    const seen: FinishInfo[] = [];
    get(app, '/finish', (ctx) => {
      onFinish(ctx, (info) => {
        seen.push({ aborted: info.aborted });
      });
      return text(ctx, 'done');
    });
    const result = await createLambdaHandler(app)(
      event({ rawPath: '/finish' })
    );
    (result.body ?? '').should.equal('done');
    seen.length.should.equal(1);
    (seen[0]?.aborted ?? true).should.equal(false);
  });
});
