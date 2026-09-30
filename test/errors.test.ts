import { describe, expectTypeOf, it } from 'vitest';

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
});

describe('throws', function () {
  it('is a pure pass-through at runtime (a type-level gate only)', async function () {
    const app = createApp();
    get(app, '/guarded', throws(401, 404), (ctx) => json(ctx, { ok: true }));
    const res = await handle(app, new Request('http://localhost/guarded'));
    res.status.should.equal(200);
    (await res.json()).should.deep.equal({ ok: true });
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
