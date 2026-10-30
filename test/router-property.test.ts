/**
 * Differential property test for `matchRoutes`: random route tables
 * (static/required-param/optional-param/wildcard segment mixes) probed
 * with random paths and methods, in both strict and non-strict modes,
 * against an independent baseline — a registration-order linear scan
 * implementing the documented semantics (strict segment matching, greedy
 * optional params with backtracking, wildcard tails, percent-decoded
 * captures, 405 `Allow` building). The trie's phase-1 (indexed/plain
 * candidate walk) and phase-2 (method-inverted mirror walk) shapes are
 * only comment-kept in sync in `src/router.ts`; this file is the executable
 * guard against their drift. Deterministic: seeded PRNG (mulberry32),
 * fixed seed list — a failure message carries the full table, probe, and
 * both verdicts, i.e. its own minimal repro.
 *
 * @module
 */

import type { MatchResult, Params, Route, Segment, Handler  } from '../src/types';

import { describe, it } from 'vitest';

import { createRoute, matchRoutes } from '../src/router';


const noop: Handler = () => undefined;

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) — tiny, deterministic, no dependencies.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function (): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private readonly nextFloat: () => number;

  constructor(seed: number) {
    this.nextFloat = mulberry32(seed);
  }

  /** Uniform integer in [min, max], inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.nextFloat() * (max - min + 1));
  }

  /** Uniform element of a non-empty list. */
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)]!;
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.nextFloat() < p;
  }

  /** Uniform float in [0, 1) — for kind rolls that are not chances. */
  roll(): number {
    return this.nextFloat();
  }
}

// ---------------------------------------------------------------------------
// Random tables and probes.
// ---------------------------------------------------------------------------

const STATIC_WORDS = ['a', 'b', 'c', 'users', 'posts', 'items', 'v1'] as const;
const PARAM_NAMES = ['id', 'name', 'tid', 'key', 'seg'] as const;
// Capture values double as percent-encoding probes: a legal escape, an
// encoded slash (must not split segments), a malformed escape (kept raw),
// and a `+` (decodeURIComponent turns it into a space — both sides agree).
const CAPTURE_VALUES = [
  '1',
  '42',
  'abc',
  'a%20b',
  'caf%C3%A9',
  'x%2Fy',
  '%ZZ',
  'a+b',
  'long-value',
] as const;
const REQUEST_METHODS = [
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'HEAD',
  'OPTIONS',
  'get',
] as const;
const ROUTE_METHODS = ['ALL', ...REQUEST_METHODS] as const;

/** A capture name unused in this pattern so far, or undefined when the
 * vocabulary is exhausted (the caller falls back to a static segment —
 * `createSegments` rejects duplicate names). */
function freshName(rng: Rng, used: Set<string>): string | undefined {
  const options = PARAM_NAMES.filter((name) => !used.has(name));
  if (options.length === 0) {
    return undefined;
  }
  const name = rng.pick(options);
  used.add(name);
  return name;
}

/** A random pattern over the segment vocabulary: statics, required and
 * optional params, a terminal wildcard, occasionally the root. */
function randomPattern(rng: Rng): string {
  if (rng.chance(0.05)) {
    return '/';
  }
  const depth = rng.int(1, 4);
  const used = new Set<string>();
  const parts: string[] = [];
  for (let i = 0; i < depth; i += 1) {
    const last = i === depth - 1;
    const roll = rng.roll();
    const name = freshName(rng, used);
    if (last && roll < 0.12 && name !== undefined) {
      parts.push(`*${name}`);
    } else if (roll < 0.45) {
      parts.push(rng.pick(STATIC_WORDS));
    } else if (roll < 0.7 && name !== undefined) {
      parts.push(`:${name}`);
    } else if (roll < 0.85 && name !== undefined) {
      parts.push(`:${name}?`);
    } else {
      parts.push(rng.pick(STATIC_WORDS));
    }
  }
  return `/${parts.join('/')}`;
}

function randomRoutes(rng: Rng): Route[] {
  const routes: Route[] = [];
  const count = rng.int(1, 12);
  for (let i = 0; i < count; i += 1) {
    routes.push(createRoute(rng.pick(ROUTE_METHODS), randomPattern(rng), noop));
  }
  return routes;
}

/** A path built by walking a registered pattern — statics verbatim, params
 * filled with capture probes (optional ones sometimes skipped, wildcards
 * given 0-3 tail parts). These probes land on matches (and 405s) often
 * enough for the differential to bite. */
function instantiate(rng: Rng, segments: readonly Segment[]): string {
  const parts: string[] = [];
  for (const segment of segments) {
    if (segment._tag === 'static') {
      parts.push(segment.value);
    } else if (segment._tag === 'wildcard') {
      const tail = rng.int(0, 3);
      for (let k = 0; k < tail; k += 1) {
        parts.push(rng.chance(0.5) ? rng.pick(CAPTURE_VALUES) : rng.pick(STATIC_WORDS));
      }
    } else if (segment.optional) {
      if (rng.chance(0.5)) {
        parts.push(rng.pick(CAPTURE_VALUES));
      }
    } else {
      parts.push(rng.pick(CAPTURE_VALUES));
    }
  }
  return `/${parts.join('/')}`;
}

function randomPathname(rng: Rng, routes: readonly Route[]): string {
  const roll = rng.roll();
  if (roll < 0.4) {
    return instantiate(rng, rng.pick(routes).segments);
  }
  if (roll < 0.55) {
    // A registered pattern verbatim, plus trailing-slash and surplus-part
    // twists that probe strict matching and trie descent boundaries.
    const base = rng.pick(routes).pattern;
    if (base !== '/' && rng.chance(0.4)) {
      return `${base}/`;
    }
    if (rng.chance(0.5)) {
      return `${base}/${rng.pick(STATIC_WORDS)}`;
    }
    return base;
  }
  // Free-form walk: hits, misses, empty segments, trailing slashes.
  const depth = rng.int(0, 5);
  const parts: string[] = [];
  for (let i = 0; i < depth; i += 1) {
    const partRoll = rng.roll();
    if (partRoll < 0.6) {
      parts.push(rng.pick(STATIC_WORDS));
    } else if (partRoll < 0.9) {
      parts.push(rng.pick(CAPTURE_VALUES));
    } else {
      parts.push(rng.pick(['', 'x']));
    }
  }
  let pathname = `/${parts.join('/')}`;
  if (rng.chance(0.12)) {
    pathname += '/';
  }
  if (rng.chance(0.04)) {
    return pathname.slice(1); // no leading slash: never matches
  }
  return pathname;
}

// ---------------------------------------------------------------------------
// The baseline: registration-order linear scan over the documented
// semantics. Deliberately written independently of the trie — no nodes,
// no index, just "first registration whose pattern and method serve the
// request wins; otherwise the sorted, deduped method list".
// ---------------------------------------------------------------------------

/** The router's documented capture decoding: decode, keep raw on a
 * malformed escape. */
function decodeCapture(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The router's documented method rule: exact, or `ALL`, or a GET route
 * serving a HEAD request. */
function methodServes(routeMethod: string, method: string): boolean {
  return (
    routeMethod === method ||
    routeMethod === 'ALL' ||
    (method === 'HEAD' && routeMethod === 'GET')
  );
}

/** Strict segment walk with greedy optional params: consume first, skip on
 * failure; a wildcard swallows the whole remaining tail. `undefined` is a
 * mismatch, the params bag a match. */
function baselineMatchParts(
  segments: readonly Segment[],
  parts: readonly string[],
  i: number,
  j: number,
  params: Params
): Params | undefined {
  const segment = segments[i];
  if (segment === undefined) {
    return j === parts.length ? { ...params } : undefined;
  }
  if (segment._tag === 'wildcard') {
    return { ...params, [segment.name]: decodeCapture(parts.slice(j).join('/')) };
  }
  const part = parts[j];
  if (segment._tag === 'static') {
    if (part !== segment.value) {
      return undefined;
    }
    return baselineMatchParts(segments, parts, i + 1, j + 1, params);
  }
  if (segment.optional) {
    if (part !== undefined && part !== '') {
      const consumed = baselineMatchParts(
        segments,
        parts,
        i + 1,
        j + 1,
        { ...params, [segment.name]: decodeCapture(part) }
      );
      if (consumed !== undefined) {
        return consumed;
      }
    }
    return baselineMatchParts(segments, parts, i + 1, j, params);
  }
  if (part === undefined || part === '') {
    return undefined;
  }
  return baselineMatchParts(
    segments,
    parts,
    i + 1,
    j + 1,
    { ...params, [segment.name]: decodeCapture(part) }
  );
}

/** The baseline `matchRoutes`: split like the router documents (no leading
 * slash never matches; non-strict trims one trailing empty part), then a
 * linear scan in registration order. */
function baselineMatchRoutes(
  routes: readonly Route[],
  method: string,
  pathname: string,
  strict: boolean
): MatchResult | undefined {
  if (!pathname.startsWith('/')) {
    return undefined;
  }
  const rest = pathname.slice(1);
  const rawParts = rest === '' ? [] : rest.split('/');
  const parts =
    !strict && rawParts.length > 0 && rawParts[rawParts.length - 1] === ''
      ? rawParts.slice(0, -1)
      : rawParts;
  const m = method.toUpperCase();

  const served: { seq: number; route: Route; params: Params }[] = [];
  const allowedHits: { seq: number; method: string }[] = [];
  routes.forEach((route, seq) => {
    const params = baselineMatchParts(route.segments, parts, 0, 0, {});
    if (params === undefined) {
      return;
    }
    if (methodServes(route.method, m)) {
      served.push({ seq, route, params });
    } else {
      allowedHits.push({ seq, method: route.method });
    }
  });
  if (served.length > 0) {
    served.sort((a, b) => a.seq - b.seq);
    const first = served[0]!;
    return { route: first.route, params: first.params };
  }
  if (allowedHits.length === 0) {
    return undefined;
  }
  allowedHits.sort((a, b) => a.seq - b.seq);
  const allowed: string[] = [];
  for (const hit of allowedHits) {
    if (!allowed.includes(hit.method)) {
      allowed.push(hit.method);
    }
  }
  return { allowedMethods: allowed };
}

// ---------------------------------------------------------------------------
// Differential assertion.
// ---------------------------------------------------------------------------

/** Params keyed canonically (sorted keys) so bag shape, not insertion
 * order, decides equality. */
function canonical(params: Params): string {
  return JSON.stringify(
    Object.keys(params)
      .sort()
      .map((key) => [key, params[key] ?? null])
  );
}

function describeMatch(result: MatchResult | undefined): string {
  if (result === undefined) {
    return 'no match';
  }
  if ('route' in result) {
    return `route ${result.route.method} ${result.route.pattern} params ${canonical(result.params)}`;
  }
  return `allowedMethods ${JSON.stringify([...result.allowedMethods])}`;
}

function resultsEqual(
  actual: MatchResult | undefined,
  expected: MatchResult | undefined
): boolean {
  if (actual === undefined || expected === undefined) {
    return actual === expected;
  }
  if ('route' in actual && 'route' in expected) {
    return (
      actual.route === expected.route &&
      canonical(actual.params) === canonical(expected.params)
    );
  }
  if ('allowedMethods' in actual && 'allowedMethods' in expected) {
    return [...actual.allowedMethods].join(',') === [...expected.allowedMethods].join(',');
  }
  return false;
}

function assertMatchesBaseline(
  routes: readonly Route[],
  method: string,
  pathname: string,
  strict: boolean
): void {
  const actual = matchRoutes(routes, method, pathname, strict);
  const expected = baselineMatchRoutes(routes, method, pathname, strict);
  if (!resultsEqual(actual, expected)) {
    const table = routes
      .map((route, seq) => `    [${seq}] ${route.method} ${route.pattern}`)
      .join('\n');
    throw new Error(
      'matchRoutes disagrees with the registration-order baseline\n' +
        `  request: method=${JSON.stringify(method)} pathname=${JSON.stringify(pathname)} strict=${strict}\n` +
        `  router:   ${describeMatch(actual)}\n` +
        `  baseline: ${describeMatch(expected)}\n` +
        `  table:\n${table}`
    );
  }
}

// ---------------------------------------------------------------------------
// The property: for every seeded universe, every random table, every random
// probe, both walks of the trie must agree with the linear scan.
// ---------------------------------------------------------------------------

const SEEDS = [1, 2, 3, 4, 0xc0ffee];
const TABLES_PER_SEED = 60;
const PROBES_PER_TABLE = 40;

describe('matchRoutes differential property', function () {
  for (const seed of SEEDS) {
    it(`agrees with the registration-order baseline (seed ${seed})`, function () {
      const rng = new Rng(seed);
      for (let tableIndex = 0; tableIndex < TABLES_PER_SEED; tableIndex += 1) {
        const routes = randomRoutes(rng);
        for (let probe = 0; probe < PROBES_PER_TABLE; probe += 1) {
          const method = rng.pick(REQUEST_METHODS);
          const pathname = randomPathname(rng, routes);
          const strict = rng.chance(0.5);
          assertMatchesBaseline(routes, method, pathname, strict);
        }
      }
    });
  }
});
