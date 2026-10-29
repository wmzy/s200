// Parity contract: codegen's emitted source text (FILL / IS_JSON_BODY /
// sendBlock in src/codegen.ts) is a deliberately standalone third copy of
// the shared implementations — pattern-fill's fillSegments/appendQuery and
// client.ts's body predicate. Nothing structural keeps the emitted text in
// sync with those, so this suite executes the GENERATED functions (fill,
// isJsonBody, send — the latter two re-exported by a test-only trailer,
// never rewritten) and asserts their output matches the shared side over a
// corpus of the shapes both must agree on: param fills, optionals,
// piecewise-encoded wildcards, query sugar, missing-param errors, and the
// body-kind classification. A regression on either side fails here.

import type { Segment } from '../src/types';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, it } from 'vitest';

import { createApp, get, post } from '../src/app';
import { createClient } from '../src/client';
import { generateClient } from '../src/codegen';
import { appendQuery, fillSegments } from '../src/pattern-fill';

// Node >= 22.6 can type-strip .mts natively; older runtimes cannot import
// the generated module, so the execution half skips with a note (same gate
// as codegen.test.ts).
const stripTypes = (process.features as { typescript?: string | boolean }).typescript;
if (!stripTypes) {
  console.log(
    '[codegen-parity.test] process.features.typescript unavailable on this runtime —' +
      ' skipping generated-module parity (nothing else runs in this file)'
  );
}

const describeExecuted = stripTypes ? describe : describe.skip;

/** The corpus fixture: one route per pattern shape the corpus exercises,
 * so each row can harvest the router's parsed segments for the shared-side
 * baseline (the generated side only ever sees the pattern string). */
function parityApp() {
  const app = createApp();
  get(app, '/users/:id', () => new Response('ok'));
  get(app, '/posts/:postId?', () => new Response('ok'));
  get(app, '/files/*path', () => new Response('ok'));
  get(app, '/a/:x/b/:y?/c/*rest', () => new Response('ok'));
  get(app, '/search', () => new Response('ok'));
  post(app, '/echo', () => new Response('ok'));
  return app;
}

const CORPUS_APP = parityApp();
const SEGMENTS: ReadonlyMap<string, readonly Segment[]> = new Map(
  CORPUS_APP.routes.map((route) => [route.pattern, route.segments])
);

/** The shared-side baseline, composed exactly as client.ts's buildPathFn
 * composes it: fillSegments driven by the client's valueOf contract
 * (absent optional drops out, absent required throws the client's
 * message, a non-string value throws the client's must-be-a-string
 * message) plus appendQuery in the client's `skipNull: false` flavor —
 * the loose query sugar stringifies null rather than skipping it. */
function fillLikeClient(
  pattern: string,
  segments: readonly Segment[],
  args: Record<string, unknown> | undefined,
  base: string,
  query: Record<string, unknown> | undefined
): string {
  const optional = new Set(
    segments.flatMap((segment) =>
      segment._tag === 'param' && segment.optional ? [segment.name] : []
    )
  );
  const filled = fillSegments(segments, (name) => {
    const value = args?.[name];
    if (value === undefined) {
      if (optional.has(name)) {
        return undefined;
      }
      throw new Error(`Missing param '${name}' for route '${pattern}'`);
    }
    if (typeof value !== 'string') {
      throw new Error(`Param '${name}' for route '${pattern}' must be a string`);
    }
    return value;
  });
  let path = base + (filled as string);
  if (query !== undefined) {
    const search = new URLSearchParams();
    appendQuery(search, Object.entries(query), { skipNull: false });
    const qs = search.toString();
    if (qs !== '') {
      path += `?${qs}`;
    }
  }
  return path;
}

/** A thunk's value or its synchronous throw as a message — success rows
 * compare values, error rows compare message text, one shape for both. */
function outcomeOf(thunk: () => string): { value?: string; error?: string } {
  try {
    return { value: thunk() };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

/** The message of a thunk that MUST throw synchronously — a silent
 * resolution fails the test instead of comparing vacuously. */
function errorMessageOf(thunk: () => unknown): string {
  try {
    void thunk();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected a synchronous throw, but the call resolved');
}

/** Record access under `noUncheckedIndexedAccess` yields `| undefined` —
 * the corpus knows its fixture's method names, so the guard (and its
 * clear failure message) lives here instead of a `!` at every row. */
function methodOf(
  client: Record<string, (...args: unknown[]) => Promise<Response>>,
  name: string
): (...args: unknown[]) => Promise<Response> {
  const method = client[name];
  if (method === undefined) {
    throw new Error(`fixture method '${name}' is missing on the client under test`);
  }
  return method;
}

/** What the generated module looks like to this suite. `fill` ships
 * exported; `isJsonBody` and `send` are module-local in the emitted text,
 * reached through the test-only re-export trailer below (their bodies are
 * the exact emitted ones — nothing is rewritten). */
type GeneratedModule = {
  fill: (
    pattern: string,
    args: Record<string, string | undefined> | undefined,
    base: string,
    query: Record<string, unknown> | undefined
  ) => string;
  isJsonBody: (value: unknown) => boolean;
  send: (
    fetcher: (input: string, init?: RequestInit) => Promise<Response>,
    url: string,
    init: ({ body?: unknown } & Omit<RequestInit, 'body'>) | undefined,
    method: string
  ) => Promise<Response>;
  makeClient: (
    baseUrl: string,
    fetcher: (input: string, init?: RequestInit) => Promise<Response>
  ) => Record<string, (...args: unknown[]) => Promise<Response>>;
};

let loaded: Promise<GeneratedModule> | undefined;

/** Loads (once) the module generated from the corpus fixture. The trailer
 * only adds exports; the functions under test are byte-for-byte the
 * emitted text. */
async function generatedModule(): Promise<GeneratedModule> {
  loaded ??= (async () => {
    const source = generateClient(parityApp(), { name: 'makeClient' });
    const dir = await mkdtemp(join(tmpdir(), 's200-codegen-parity-'));
    try {
      const file = join(dir, 'client.mts');
      await writeFile(file, `${source}\nexport { isJsonBody, send };\n`, 'utf8');
      return (await import(pathToFileURL(file).href)) as unknown as GeneratedModule;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  })();
  return loaded;
}

describeExecuted('codegen parity: generated fill ≡ fillSegments + appendQuery', () => {
  const corpus: {
    label: string;
    pattern: string;
    args?: Record<string, unknown>;
    query?: Record<string, unknown>;
    base?: string;
    missing?: string;
    badType?: string;
  }[] = [
    { label: 'plain required param', pattern: '/users/:id', args: { id: '42' } },
    {
      label: 'param with spaces, slash and ? (whole-value encode)',
      pattern: '/users/:id',
      args: { id: 'a b/c?' },
    },
    { label: 'non-ASCII param', pattern: '/users/:id', args: { id: 'héllo' } },
    { label: 'optional present', pattern: '/posts/:postId?', args: { postId: '7' } },
    { label: 'optional absent (empty args)', pattern: '/posts/:postId?', args: {} },
    { label: 'optional absent (undefined args)', pattern: '/posts/:postId?', args: undefined },
    {
      label: 'optional absent (explicit undefined value)',
      pattern: '/posts/:postId?',
      args: { postId: undefined },
    },
    { label: 'wildcard single piece', pattern: '/files/*path', args: { path: 'report v2.pdf' } },
    {
      label: 'wildcard multi piece with space (piecewise encode keeps /)',
      pattern: '/files/*path',
      args: { path: 'a/b c/d' },
    },
    { label: 'wildcard empty string still adds the slash', pattern: '/files/*path', args: { path: '' } },
    { label: 'static route', pattern: '/search', args: undefined },
    {
      label: 'mixed route, all captures present',
      pattern: '/a/:x/b/:y?/c/*rest',
      args: { x: '1', y: '2', rest: 'p/q r' },
    },
    {
      label: 'mixed route, optional drops out mid-pattern',
      pattern: '/a/:x/b/:y?/c/*rest',
      args: { x: '1', rest: 'p' },
    },
    { label: 'base is prefixed verbatim', pattern: '/users/:id', args: { id: '3' }, base: 'http://api.test' },
    {
      label: 'query: scalars stringify, arrays repeat, undefined skips',
      pattern: '/search',
      query: { q: 'a b', tag: ['x', 'y'], n: 3, on: true, skip: undefined },
    },
    {
      label: 'query: null stringifies (client flavor, not MCP skip)',
      pattern: '/search',
      query: { nil: null },
    },
    { label: 'query: all-undefined record appends no ?', pattern: '/search', query: { skip: undefined } },
    { label: 'query: empty record appends no ?', pattern: '/search', query: {} },
    {
      label: 'param and query together',
      pattern: '/users/:id',
      args: { id: '7' },
      query: { v: 'x', ids: [1, 'a b'] },
    },
    { label: 'missing required param (empty args)', pattern: '/users/:id', args: {}, missing: 'id' },
    {
      label: 'missing required param (undefined args)',
      pattern: '/users/:id',
      args: undefined,
      missing: 'id',
    },
    {
      label: 'first required capture in a mixed route wins the error',
      pattern: '/a/:x/b/:y?/c/*rest',
      args: { y: '2', rest: 'p' },
      missing: 'x',
    },
    { label: 'missing wildcard capture', pattern: '/files/*path', args: {}, missing: 'path' },
    {
      label: 'missing param throws before the query is assembled',
      pattern: '/users/:id',
      args: {},
      query: { v: 'x' },
      missing: 'id',
    },
    {
      label: 'non-string param throws the client message',
      pattern: '/users/:id',
      args: { id: 42 },
      badType: 'id',
    },
    {
      label: 'non-string wildcard throws the client message',
      pattern: '/files/*path',
      args: { path: 7 },
      badType: 'path',
    },
  ];

  for (const row of corpus) {
    it(`fill agrees with the shared fill on: ${row.label}`, async () => {
      const mod = await generatedModule();
      const segments = SEGMENTS.get(row.pattern);
      if (segments === undefined) {
        throw new Error(`corpus pattern '${row.pattern}' is not registered in the fixture app`);
      }
      const base = row.base ?? '';
      // Loose handles on purpose: the corpus pokes the runtime corners
      // (non-string values) the typed surfaces reject.
      const args = row.args as Record<string, string | undefined> | undefined;
      const generated = outcomeOf(() => mod.fill(row.pattern, args, base, row.query));
      const shared = outcomeOf(() => fillLikeClient(row.pattern, segments, args, base, row.query));
      generated.should.deep.equal(shared);
      if (row.missing !== undefined) {
        (generated.error ?? 'NO THROW').should.equal(
          `Missing param '${row.missing}' for route '${row.pattern}'`
        );
      }
      if (row.badType !== undefined) {
        (generated.error ?? 'NO THROW').should.equal(
          `Param '${row.badType}' for route '${row.pattern}' must be a string`
        );
      }
    });
  }
});

describeExecuted('codegen parity: generated isJsonBody ≡ client body predicate', () => {
  it('classifies the body-kind corpus exactly as s200/client does', async () => {
    const mod = await generatedModule();
    // Expectations are the client.ts predicate's semantics: JSON shapes
    // are plain objects and arrays; null, primitives, functions, and the
    // Web's structured body types (streams, blobs, forms, byte views and
    // buffers) are not.
    const corpus: [label: string, body: unknown, json: boolean][] = [
      ['plain object', { a: 1 }, true],
      ['empty object', {}, true],
      ['nested object', { a: { b: [1, 2] } }, true],
      ['array', [1, 'x', null], true],
      ['class instance (still a plain shape)', new Date(0), true],
      ['null', null, false],
      ['undefined', undefined, false],
      ['string', 'raw', false],
      ['empty string', '', false],
      ['number', 7, false],
      ['boolean', false, false],
      ['function', () => undefined, false],
      ['ReadableStream', new ReadableStream(), false],
      ['Blob', new Blob(['x']), false],
      ['ArrayBuffer', new ArrayBuffer(8), false],
      ['URLSearchParams', new URLSearchParams('a=1'), false],
      ['FormData', new FormData(), false],
      ['Uint8Array (an ArrayBuffer view)', new Uint8Array(3), false],
      ['DataView (an ArrayBuffer view)', new DataView(new ArrayBuffer(8)), false],
    ];
    const misclassified = corpus
      .filter(([, body, json]) => mod.isJsonBody(body) !== json)
      .map(([label]) => label);
    misclassified.should.deep.equal([]);
  });
});

describeExecuted('codegen parity: generated send ≡ client dispatch', () => {
  /** What one fetch call observes — headers normalized to sorted entries
   * so a Headers built independently on each side compares structurally
   * (chai's deep equal would see two Headers as identically empty). */
  type Call = { url: string; method?: string; body?: unknown; headers: unknown };

  function recorder() {
    const calls: Call[] = [];
    const fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const effective = init ?? {};
      calls.push({
        url: String(input),
        method: effective.method,
        body: effective.body,
        headers:
          effective.headers instanceof Headers ? [...effective.headers].sort() : effective.headers,
      });
      return Promise.resolve(new Response('ok'));
    };
    return { calls, fetch };
  }

  it('drives identical fetch calls across the path and query corpus', async () => {
    const mod = await generatedModule();
    const shared = recorder();
    const generated = recorder();
    // Loose handles on both sides: the corpus pokes runtime corners the
    // typed surfaces reject (null query values, unregistered shapes).
    const viaShared = createClient(parityApp(), {
      baseUrl: 'http://api.test/',
      fetch: shared.fetch,
    }) as unknown as Record<string, (...args: unknown[]) => Promise<Response>>;
    // The generated factory trims the trailing slash exactly like
    // createClient does — same baseUrl in, same URLs out.
    const viaGenerated = mod.makeClient('http://api.test/', generated.fetch);

    const query = { q: 'a b', tag: ['x', 'y'], n: 3, on: true, skip: undefined, nil: null };
    const cases: { label: string; shared: () => unknown; generated: () => unknown }[] = [
      {
        label: 'plain param (whole-value encode)',
        shared: () => methodOf(viaShared, 'get')('/users/:id', { id: 'a b/c' }),
        generated: () => methodOf(viaGenerated, 'getUsersId')({ id: 'a b/c' }),
      },
      {
        label: 'optional present',
        shared: () => methodOf(viaShared, 'get')('/posts/:postId?', { postId: '7' }),
        generated: () => methodOf(viaGenerated, 'getPostsPostId')({ postId: '7' }),
      },
      {
        label: 'optional absent',
        shared: () => methodOf(viaShared, 'get')('/posts/:postId?', {}),
        generated: () => methodOf(viaGenerated, 'getPostsPostId')({}),
      },
      {
        label: 'wildcard (piecewise encode keeps /)',
        shared: () => methodOf(viaShared, 'get')('/files/*path', { path: 'a/b c' }),
        generated: () => methodOf(viaGenerated, 'getFilesPath')({ path: 'a/b c' }),
      },
      {
        label: 'mixed route with dropped optional',
        shared: () => methodOf(viaShared, 'get')('/a/:x/b/:y?/c/*rest', { x: '1', rest: 'p/q' }),
        generated: () => methodOf(viaGenerated, 'getAXBYCRest')({ x: '1', rest: 'p/q' }),
      },
      {
        label: 'static route with query sugar',
        shared: () => methodOf(viaShared, 'get')('/search', { query }),
        generated: () => methodOf(viaGenerated, 'getSearch')({ query }),
      },
      {
        label: 'param route with query sugar',
        shared: () => methodOf(viaShared, 'get')('/users/:id', { id: '7' }, { query }),
        generated: () => methodOf(viaGenerated, 'getUsersId')({ id: '7' }, { query }),
      },
    ];
    for (const row of cases) {
      await Promise.all([row.shared(), row.generated()]);
    }
    shared.calls.should.have.lengthOf(cases.length);
    generated.calls.should.have.lengthOf(cases.length);
    const mismatches = cases
      .map((row, i) => ({
        label: row.label,
        shared: JSON.stringify(shared.calls[i]),
        generated: JSON.stringify(generated.calls[i]),
      }))
      .filter((row) => row.shared !== row.generated)
      .map((row) => `${row.label}: shared ${row.shared} ≠ generated ${row.generated}`);
    mismatches.should.deep.equal([]);
  });

  it('drives identical fetch calls across the body-kind corpus', async () => {
    const mod = await generatedModule();
    const shared = recorder();
    const generated = recorder();
    const viaShared = createClient(parityApp(), {
      baseUrl: 'http://api.test',
      fetch: shared.fetch,
    }) as unknown as Record<string, (...args: unknown[]) => Promise<Response>>;
    const viaGenerated = mod.makeClient('http://api.test', generated.fetch);

    const form = new FormData();
    form.append('k', 'v');
    const bodies: [label: string, body: unknown][] = [
      ['plain object', { hello: 'world', n: 2 }],
      ['nested object', { a: { b: [1, 2] } }],
      ['array', [1, 'x', null]],
      ['string', 'raw text'],
      ['Blob', new Blob(['bin'])],
      ['URLSearchParams', new URLSearchParams({ a: '1' })],
      ['FormData', form],
      ['Uint8Array', new Uint8Array([1, 2, 3])],
      ['ReadableStream', new ReadableStream()],
      ['null body', null],
    ];
    for (const [, body] of bodies) {
      await Promise.all([methodOf(viaShared, 'post')('/echo', { body }), methodOf(viaGenerated, 'postEcho')({ body })]);
    }
    // An explicit content-type wins over the JSON default, and the method
    // parameter always beats a stray init.method — both sides.
    await Promise.all([
      methodOf(viaShared, 'post')('/echo', { body: { a: 1 }, headers: { 'content-type': 'text/plain' } }),
      methodOf(viaGenerated, 'postEcho')({ body: { a: 1 }, headers: { 'content-type': 'text/plain' } }),
    ]);
    await Promise.all([
      methodOf(viaShared, 'post')('/echo', { method: 'GET', body: { a: 1 } }),
      methodOf(viaGenerated, 'postEcho')({ method: 'GET', body: { a: 1 } }),
    ]);
    // No init at all: the method still rides.
    await Promise.all([methodOf(viaShared, 'post')('/echo'), methodOf(viaGenerated, 'postEcho')()]);

    const expected = bodies.length + 3;
    shared.calls.should.have.lengthOf(expected);
    generated.calls.should.have.lengthOf(expected);
    const mismatches = [...bodies.map(([label]) => label), 'explicit content-type', 'method wins', 'no init']
      .map((label, i) => ({
        label,
        shared: JSON.stringify(shared.calls[i]),
        generated: JSON.stringify(generated.calls[i]),
      }))
      .filter((row) => row.shared !== row.generated)
      .map((row) => `${row.label}: shared ${row.shared} ≠ generated ${row.generated}`);
    mismatches.should.deep.equal([]);
  });

  it('throws the shipped client\'s exact missing-param message', async () => {
    const mod = await generatedModule();
    const shared = recorder();
    const generated = recorder();
    const viaShared = createClient(parityApp(), {
      baseUrl: 'http://x.test',
      fetch: shared.fetch,
    }) as unknown as Record<string, (...args: unknown[]) => Promise<Response>>;
    const viaGenerated = mod.makeClient('http://x.test', generated.fetch);

    const cases: { label: string; shared: () => unknown; generated: () => unknown }[] = [
      {
        label: 'required param absent',
        shared: () => methodOf(viaShared, 'get')('/users/:id', {}),
        generated: () => methodOf(viaGenerated, 'getUsersId')({}),
      },
      {
        label: 'required param absent with query present',
        shared: () => methodOf(viaShared, 'get')('/users/:id', {}, { query: { v: 'x' } }),
        generated: () => methodOf(viaGenerated, 'getUsersId')({}, { query: { v: 'x' } }),
      },
      {
        label: 'first required capture in a mixed route',
        shared: () => methodOf(viaShared, 'get')('/a/:x/b/:y?/c/*rest', { y: '2', rest: 'p' }),
        generated: () => methodOf(viaGenerated, 'getAXBYCRest')({ y: '2', rest: 'p' }),
      },
      {
        label: 'non-string param value',
        shared: () => methodOf(viaShared, 'get')('/users/:id', { id: 42 } as never),
        generated: () => methodOf(viaGenerated, 'getUsersId')({ id: 42 } as never),
      },
    ];
    for (const row of cases) {
      errorMessageOf(row.generated).should.equal(errorMessageOf(row.shared), row.label);
    }
  });

  it('send: JSON bodies stringify with a stamped content-type; everything else rides untouched', async () => {
    const mod = await generatedModule();
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(new Response('ok'));
    };

    // JSON shape: stringified, default content-type, method stamped.
    await mod.send(fetcher, 'http://x.test/echo', { body: { a: 1 } }, 'POST');
    calls[0]!.init.body!.should.equal('{"a":1}');
    calls[0]!.init.method!.should.equal('POST');
    const stamped = calls[0]?.init.headers as Headers | undefined;
    (stamped instanceof Headers).should.be.true;
    stamped!.get('content-type')!.should.equal('application/json');

    // An explicit content-type survives the stamp; the body still
    // stringifies.
    await mod.send(fetcher, 'u', { body: { a: 1 }, headers: { 'content-type': 'text/plain' } }, 'PUT');
    calls[1]!.init.body!.should.equal('{"a":1}');
    calls[1]!.init.method!.should.equal('PUT');
    const explicit = calls[1]?.init.headers as Headers | undefined;
    (explicit instanceof Headers).should.be.true;
    explicit!.get('content-type')!.should.equal('text/plain');

    // A structured body rides untouched, no content-type invented, and
    // the method parameter beats a stray init.method.
    const blob = new Blob(['bin']);
    await mod.send(fetcher, 'u', { body: blob, method: 'GET' }, 'POST');
    calls[2]!.init.body!.should.equal(blob);
    calls[2]!.init.method!.should.equal('POST');
    (calls[2]?.init.headers === undefined).should.be.true;

    // No init at all: only the method rides.
    await mod.send(fetcher, 'u', undefined, 'GET');
    calls[3]!.init.method!.should.equal('GET');
    (calls[3]?.init.body === undefined).should.be.true;

    // The query sugar is consumed by fill before send runs — it must
    // not ride into the fetcher-visible init (s200/client's
    // buildPathFn strips it the same way).
    await mod.send(fetcher, 'u', { query: { v: 'x' } } as unknown as RequestInit, 'GET');
    calls[4]!.init.method!.should.equal('GET');
    (
      Object.keys(calls[4]?.init ?? {}).includes('query')
    ).should.be.false;
  });
});
