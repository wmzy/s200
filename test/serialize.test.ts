import { describe, expectTypeOf, it } from 'vitest';

import { createApp, get, handle } from '../src/app';
import { jsonRaw, serialize, type InferSchema, type SerializeSchema } from '../src/serialize';

describe('serialize', () => {
  const user = serialize({
    type: 'object',
    properties: {
      id: { type: 'integer' },
      name: { type: 'string' },
      active: { type: 'boolean' },
      score: { type: 'number' },
    },
    required: ['id', 'name', 'active', 'score'] as const,
  });

  it('serializes a required-only object with exact output', () => {
    user({ id: 7, name: 'ada', active: true, score: 1.5 }).should.equal(
      '{"id":7,"name":"ada","active":true,"score":1.5}',
    );
  });

  it('escapes strings, maps NaN/Infinity to null, and matches JSON.stringify', () => {
    const s = serialize({
      type: 'object',
      properties: {
        text: { type: 'string' },
        n: { type: 'number' },
      },
      required: ['text', 'n'] as const,
    });
    const value = { text: 'a"b\\c\nd', n: NaN };
    s(value).should.equal(JSON.stringify(value));
    s({ text: 'x', n: Infinity }).should.equal('{"text":"x","n":null}');
  });

  it('omits undefined optional keys and emits them after required ones', () => {
    const s = serialize({
      type: 'object',
      properties: {
        a: { type: 'string' },
        opt: { type: 'string' },
      },
      required: ['a'] as const,
    });
    s({ a: 'x' }).should.equal('{"a":"x"}');
    s({ a: 'x', opt: 'y' }).should.equal('{"a":"x","opt":"y"}');
  });

  it('serializes all-optional objects without a leading comma when the first key is omitted', () => {
    const s = serialize({
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { type: 'string' },
      },
    });
    s({ b: 'y' }).should.equal('{"b":"y"}');
    s({ a: 'x', b: 'y' }).should.equal('{"a":"x","b":"y"}');
    s({}).should.equal('{}');
  });

  it('handles nested objects, arrays, and nullable primitives', () => {
    const s = serialize({
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' } },
        meta: {
          type: 'object',
          properties: { note: { type: 'string', nullable: true } },
          required: ['note'] as const,
        },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { n: { type: 'integer' } },
            required: ['n'] as const,
          },
        },
      },
      required: ['tags', 'meta', 'items'] as const,
    });
    const value = {
      tags: ['a', 'b'],
      meta: { note: null },
      items: [{ n: 1 }, { n: 2 }],
    };
    s(value).should.equal(JSON.stringify(value));
    s({ ...value, meta: { note: 'hi' } }).should.equal(JSON.stringify({ ...value, meta: { note: 'hi' } }));
  });

  it('drops undeclared properties and serializes top-level arrays', () => {
    const s = serialize({
      type: 'object',
      properties: { keep: { type: 'string' } },
      required: ['keep'] as const,
    });
    const withExtra = { keep: 'x', secret: 'y' } as { keep: string; secret: string };
    s(withExtra).should.equal('{"keep":"x"}');

    const list = serialize({ type: 'array', items: { type: 'integer' } });
    list([1, 2, 3]).should.equal('[1,2,3]');
  });

  it('handles the empty object schema and null type', () => {
    serialize({ type: 'object', properties: {} })({}).should.equal('{}');
    const n = serialize({ type: 'null' });
    (n(null) as string).should.equal('null');
  });

  it('infers the input type from the schema', () => {
    const schema = {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        name: { type: 'string', nullable: true },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['id', 'name'],
    } as const satisfies SerializeSchema;
    // The value exists only to drive `typeof schema` — the inference target.
    type T = InferSchema<typeof schema>;
    void schema;
    expectTypeOf<T>().toExtend<{
      id: number;
      name: string | null;
      tags?: string[];
    }>();
    // `id` is required, `tags` is not.
    // @ts-expect-error -- required keys cannot be absent
    const missing: T = { name: 'x' };
    void missing;
    const minimal: T = { id: 1, name: null };
    void minimal;
  });
});

describe('jsonRaw', () => {
  it('writes a JSON response with content-type and content-length through a route', async () => {
    const toUser = serialize({
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'] as const,
    });
    const app = createApp();
    get(app, '/u', (ctx) => jsonRaw(ctx, toUser({ id: 42 })));
    const res = await handle(app, new Request('http://localhost/u'));
    res.status.should.equal(200);
    (res.headers.get('content-type') ?? '').should.equal('application/json');
    // The declared length is the exact serialized body size.
    const body = await res.text();
    Number(res.headers.get('content-length')).should.equal(new TextEncoder().encode(body).byteLength);
    JSON.parse(body).should.deep.equal({ id: 42 });
  });

  it('lets init headers win over the default content-type', async () => {
    const app = createApp();
    get(app, '/x', (ctx) =>
      jsonRaw(ctx, '{}', { headers: { 'content-type': 'application/problem+json' } }),
    );
    const res = await handle(app, new Request('http://localhost/x'));
    (res.headers.get('content-type') ?? '').should.equal('application/problem+json');
  });
});
