import { describe, expectTypeOf, it, vi } from 'vitest';

import { createApp, get, handle } from '../src/app';
import { httpError, isHttpError, throws, toErrorResponse } from '../src/errors';
import { escapeHtml, json } from '../src/respond';

describe('httpError', function () {
  it('builds tagged data with the given status and message', function () {
    httpError(404, 'no such user').should.deep.equal({
      _tag: 'HttpError',
      status: 404,
      message: 'no such user',
    });
  });

  it('defaults the message from the status→text map', function () {
    httpError(404).message.should.equal('HTTP 404 Not Found');
    httpError(429).message.should.equal('HTTP 429 Too Many Requests');
    httpError(503).message.should.equal('HTTP 503 Service Unavailable');
  });

  it('falls back to the bare word for unmapped codes', function () {
    httpError(418).message.should.equal('HTTP 418 Error');
  });

  it('accepts the inclusive boundaries 400 and 599', function () {
    httpError(400).status.should.equal(400);
    httpError(599).status.should.equal(599);
  });

  it('throws on statuses outside [400, 599]', function () {
    (() => httpError(399)).should.throw(/status/);
    (() => httpError(600)).should.throw(/status/);
    // @ts-expect-error -- runtime guard against untyped callers
    (() => httpError('404')).should.throw(/status/);
  });

  it('throws on non-integer statuses', function () {
    (() => httpError(404.5)).should.throw(/status/);
    (() => httpError(Number.NaN)).should.throw(/status/);
  });

  it('brands the status literal (and the body shape) on the return', function () {
    const e = httpError(403);
    expectTypeOf(e.status).toEqualTypeOf<403>();
    const withBody = httpError(502, 'upstream down', { retryAfter: 30 });
    expectTypeOf(withBody.status).toEqualTypeOf<502>();
    expectTypeOf(withBody.body).toEqualTypeOf<{ retryAfter: number } | undefined>();
  });

  it('carries the given headers, and the key is absent without them', function () {
    const e = httpError(429, 'Too Many Requests', { error: 'Too Many Requests' }, {
      'retry-after': '30',
      'ratelimit-limit': '60',
    });
    e.headers?.should.deep.equal({ 'retry-after': '30', 'ratelimit-limit': '60' });
    // Spread, not `headers: undefined` — today's exact shape either way.
    httpError(429).should.not.have.property('headers');
    httpError(429, 'msg').should.not.have.property('headers');
    httpError(429, 'msg', { error: 'msg' }).should.not.have.property('headers');
  });
});

describe('cause', function () {
  it('carries the fifth argument, and the key is absent without it', function () {
    const origin = new Error('db down');
    const e = httpError(502, 'upstream failed', undefined, undefined, origin);
    e.cause?.should.equal(origin);
    // Spread, not `cause: undefined` — today's exact shape either way.
    httpError(502).should.not.have.property('cause');
    httpError(502, 'msg').should.not.have.property('cause');
    httpError(502, 'msg', { error: 'msg' }).should.not.have.property('cause');
    httpError(502, 'msg', undefined, { 'retry-after': '5' }).should.not.have.property('cause');
  });

  it('is never serialized into the client-visible response body', async function () {
    const secret = 'postgres: password authentication failed for "app"';
    const res = toErrorResponse(
      httpError(502, 'upstream failed', undefined, undefined, new Error(secret))
    );
    res.status.should.equal(502);
    (await res.json()).should.deep.equal({ error: 'upstream failed' });
    JSON.stringify(res).should.not.contain('postgres');
    // ...not even when a structured body rides along.
    const withBody = toErrorResponse(
      httpError(502, 'upstream failed', { error: 'upstream failed' }, undefined, {
        internal: secret,
      })
    );
    (await withBody.json()).should.deep.equal({ error: 'upstream failed' });
  });

  it('survives the boundary into logError (an HttpError with a cause is surfaced)', async function () {
    const seen: { error: unknown; cause: unknown }[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const app = createApp({
        logError: (error) => {
          seen.push({
            error,
            cause: isHttpError(error) ? error.cause : undefined,
          });
        },
      });
      const origin = new Error('db down');
      get(app, '/wrap', () => {
        throw httpError(502, 'upstream failed', undefined, undefined, origin);
      });
      const res = await handle(app, new Request('http://localhost/wrap'));
      res.status.should.equal(502);
      (await res.json()).should.deep.equal({ error: 'upstream failed' });
      seen.should.have.lengthOf(1);
      isHttpError(seen[0]!.error).should.be.true;
      seen[0]!.cause?.should.equal(origin);
      // The custom sink replaces the default — console stays quiet.
      spy.should.not.have.been.called;
    } finally {
      spy.mockRestore();
    }
  });

  it('the default sink appends the cause to the log line', async function () {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const app = createApp();
      const origin = new Error('socket hang up');
      get(app, '/boom', () => {
        throw httpError(502, 'upstream failed', undefined, undefined, origin);
      });
      const res = await handle(app, new Request('http://localhost/boom'));
      res.status.should.equal(502);
      (await res.json()).should.deep.equal({ error: 'upstream failed' });
      spy.should.have.been.calledOnce;
      spy.mock.calls[0]?.[0].should.equal('[s500] GET /boom');
      isHttpError(spy.mock.calls[0]?.[1]).should.be.true;
      spy.mock.calls[0]?.[2].should.equal(origin);
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps cause-less HttpErrors unlogged — the cause is the flag', async function () {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const app = createApp();
      get(app, '/plain', () => {
        throw httpError(404, 'gone');
      });
      const res = await handle(app, new Request('http://localhost/plain'));
      res.status.should.equal(404);
      spy.should.not.have.been.called;
    } finally {
      spy.mockRestore();
    }
  });

  it('reaches onError with the cause intact, off the client body', async function () {
    const causes: unknown[] = [];
    const app = createApp({
      onError: (ctx, error) => {
        causes.push(isHttpError(error) ? error.cause : undefined);
        json(ctx, { error: 'gateway trouble' }, { status: isHttpError(error) ? error.status : 500 });
      },
    });
    const origin = new Error('upstream rst');
    get(app, '/wrap', () => {
      throw httpError(504, 'gateway timeout', undefined, undefined, origin);
    });
    const res = await handle(app, new Request('http://localhost/wrap'));
    res.status.should.equal(504);
    (await res.json()).should.deep.equal({ error: 'gateway trouble' });
    causes.should.deep.equal([origin]);
  });
});

describe('throws', function () {
  it('is a pure pass-through at runtime (a type-level gate only)', async function () {
    const app = createApp();
    get(app, '/guarded', throws(401, 404), (ctx) => json(ctx, { ok: true }));
    const res = await handle(app, new Request('http://localhost/guarded'));
    res.status.should.equal(200);
    (await res.json()).should.deep.equal({ ok: true });
  });

  it('stashes its declaration at runtime for spec-time consumers', function () {
    // Bare statuses stash the default envelope as `{ error: '' }`; the
    // record form stashes its values verbatim (shape examples); the
    // zero-argument form declares nothing and keeps today's bare shape.
    throws(401, 404)._errors?.should.deep.equal({ 401: { error: '' }, 404: { error: '' } });
    throws({ 422: { issues: ['x'] } })._errors?.should.deep.equal({
      422: { issues: ['x'] },
    });
    (throws()._errors === undefined).should.be.true;
  });
});

describe('isHttpError', function () {
  it('recognizes httpError values', function () {
    isHttpError(httpError(500)).should.be.true;
  });

  it('recognizes structurally equal tagged data', function () {
    isHttpError({ _tag: 'HttpError', status: 404, message: 'x' }).should.be
      .true;
  });

  it('rejects plain Errors, primitives and null', function () {
    isHttpError(new Error('HttpError')).should.be.false;
    isHttpError('HttpError').should.be.false;
    isHttpError(404).should.be.false;
    isHttpError(null).should.be.false;
    isHttpError(undefined).should.be.false;
  });

  it('rejects lookalikes with wrong field types', function () {
    isHttpError({ _tag: 'HttpError', status: '404', message: 'x' }).should.be
      .false;
    isHttpError({ _tag: 'Other', status: 404, message: 'x' }).should.be.false;
    isHttpError({ _tag: 'HttpError', status: 404 }).should.be.false;
  });
});

describe('toErrorResponse', function () {
  it('maps an HttpError to a JSON response with its status and message', async function () {
    const res = toErrorResponse(httpError(404, 'Not Found'));
    res.should.be.instanceof(Response);
    res.status.should.equal(404);
    (await res.json()).should.deep.equal({ error: 'Not Found' });
    (res.headers.get('content-type') ?? '').should.match(
      /application\/json/
    );
  });

  it('keeps the default message of an HttpError', async function () {
    const res = toErrorResponse(httpError(500));
    res.status.should.equal(500);
    (await res.json()).should.deep.equal({
      error: 'HTTP 500 Internal Server Error',
    });
  });

  it('maps any other thrown value to an anonymous 500', async function () {
    for (const e of [new Error('boom'), 'a string', { weird: true }, null]) {
      const res = toErrorResponse(e);
      res.status.should.equal(500);
      (await res.json()).should.deep.equal({
        error: 'Internal Server Error',
      });
    }
  });

  it('merges the headers record onto the error response', async function () {
    const res = toErrorResponse(
      httpError(401, 'Unauthorized', { error: 'Unauthorized' }, {
        'www-authenticate': 'Basic realm="s200"',
      })
    );
    res.status.should.equal(401);
    res.headers.get('www-authenticate')!.should.equal('Basic realm="s200"');
    (await res.json()).should.deep.equal({ error: 'Unauthorized' });
  });

  it('keeps the envelope shape when headers ride an error without a body', async function () {
    const res = toErrorResponse(
      httpError(429, 'Too Many Requests', undefined, { 'retry-after': '7' })
    );
    res.status.should.equal(429);
    res.headers.get('retry-after')!.should.equal('7');
    (await res.json()).should.deep.equal({ error: 'Too Many Requests' });
  });
});

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    escapeHtml(`<a href="x" title='y'>&`).should.equal(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;'
    );
  });

  it('leaves plain text untouched', () => {
    escapeHtml('hello, world 123').should.equal('hello, world 123');
  });
});
