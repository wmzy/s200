import type { Ctx } from '../src/types';
import type { HttpError } from '../src/errors';

import { describe, it } from 'vitest';

import { readForm, readJson, readText } from '../src/body';

// vitest's should chain has no chai-as-promised plugins (no `rejectedWith`),
// so capture rejections manually and assert on the tagged value.
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined; // resolved — property assertions below will fail
}

function makeCtx(body: BodyInit | null, headers?: Record<string, string>): Ctx {
  return {
    req: new Request('http://localhost/', { method: 'POST', body, headers }),
    params: {},
    query: new URLSearchParams(),
    state: {},
    res: undefined,
  };
}

describe('readJson', () => {
  it('parses a JSON body', async () => {
    const ctx = makeCtx('{"a":1,"b":"x"}', { 'content-type': 'application/json' });
    (await readJson<{ a: number; b: string }>(ctx)).should.deep.equal({ a: 1, b: 'x' });
  });

  it('rejects invalid JSON with a 400 HttpError', async () => {
    const ctx = makeCtx('{oops');
    const err = (await rejectionOf(readJson(ctx))) as HttpError;
    err._tag.should.equal('HttpError');
    err.status.should.equal(400);
    err.message.should.equal('Invalid JSON body');
  });

  it('rejects an empty body as invalid JSON', async () => {
    const ctx = makeCtx('');
    const err = (await rejectionOf(readJson(ctx))) as HttpError;
    err.status.should.equal(400);
  });
});

describe('readText', () => {
  it('returns the raw body as text', async () => {
    const ctx = makeCtx('plain body', { 'content-type': 'text/plain' });
    (await readText(ctx)).should.equal('plain body');
  });
});

describe('readForm', () => {
  it('parses an urlencoded body', async () => {
    const ctx = makeCtx('a=1&b=x%20y', { 'content-type': 'application/x-www-form-urlencoded' });
    const form = await readForm(ctx);
    form.get('a')!.should.equal('1');
    form.get('b')!.should.equal('x y');
  });

  it('parses a multipart body with binary parts byte-exactly', async () => {
    const payload = new FormData();
    payload.append('file', new Blob([new Uint8Array([0, 1, 255, 254])]), 'bin.dat');
    payload.append('name', 'value');
    const ctx = makeCtx(payload);

    const form = await readForm(ctx);
    const file = form.get('file') as File;
    file.name.should.equal('bin.dat');
    new Uint8Array(await file.arrayBuffer()).should.deep.equal(new Uint8Array([0, 1, 255, 254]));
    form.get('name')!.should.equal('value');
  });
});

describe('per-ctx body cache', () => {
  it('serves repeated and mixed reads from one cache entry', async () => {
    const ctx = makeCtx('{"n":1}');
    (await readJson<{ n: number }>(ctx)).should.deep.equal({ n: 1 });
    (await readJson<{ n: number }>(ctx)).should.deep.equal({ n: 1 });
    (await readText(ctx)).should.equal('{"n":1}');
  });

  it('supports concurrent reads before the body settles', async () => {
    const ctx = makeCtx('{"n":2}');
    const [first, second] = await Promise.all([
      readJson<{ n: number }>(ctx),
      readJson<{ n: number }>(ctx),
    ]);
    first.should.deep.equal({ n: 2 });
    second.should.deep.equal({ n: 2 });
  });

  it('caches per ctx, not per module', async () => {
    const ctxA = makeCtx('"a"');
    const ctxB = makeCtx('"b"');
    (await readJson<string>(ctxA)).should.equal('a');
    (await readJson<string>(ctxB)).should.equal('b');
  });

  it('re-throws the same parse failure on a second read', async () => {
    const ctx = makeCtx('not json');
    const first = (await rejectionOf(readJson(ctx))) as HttpError;
    first.status.should.equal(400);
    const second = (await rejectionOf(readJson(ctx))) as HttpError;
    second.status.should.equal(400);
    second.message.should.equal('Invalid JSON body');
  });
});
