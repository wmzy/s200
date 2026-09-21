/**
 * Pattern router: strict segment matching over registered routes, plus the
 * `ParamsOf` template-literal type that types route handlers at compile time.
 *
 * Matching runs over a static-prefix trie, not a linear scan: routes are
 * filed under the chain of static segments leading up to their first
 * param/wildcard (or their end). A request then only visits the nodes its
 * own segments spell out — the scan cost depends on URL depth, not on the
 * number of registered routes. Registration order still decides ties via a
 * per-build sequence number, so behavior is identical to first-wins linear
 * scanning.
 *
 * @module
 */

import type {
  Handler,
  MatchFn,
  MatchResult,
  Middleware,
  Params,
  Route,
  Segment,
} from './types';

// One pattern segment splits into '/'-separated parts; names must be plain
// identifiers so they round-trip into object keys without surprises.
const NAME_RE = /^[A-Za-z0-9_]+$/;

// Shared empty default: the overwhelmingly common route carries no
// middleware, and `[]` per route would allocate a fresh array each time.
const NO_MIDDLEWARES: readonly Middleware[] = [];

// Shared empty parts: the root pathname ('/') splits to zero parts, and
// that must not allocate per request.
const EMPTY_PARTS: readonly string[] = [];

/** Segment names that carry a param or wildcard capture. */
type SegmentNames<P extends string> =
  P extends `${infer Head}/${infer Tail}`
    ? SegmentName<Head> | SegmentNames<Tail>
    : SegmentName<P>;

type SegmentName<S extends string> =
  S extends `:${infer Name}?`
    ? Name
    : S extends `:${infer Name}`
      ? Name
      : S extends `*${infer Name}`
        ? Name
        : never;

/** Names captured by `:name?` segments — keys the handler may not receive. */
type OptionalSegmentNames<P extends string> =
  P extends `${infer Head}/${infer Tail}`
    ? OptionalName<Head> | OptionalSegmentNames<Tail>
    : OptionalName<P>;

type OptionalName<S extends string> = S extends `:${infer Name}?` ? Name : never;

/**
 * Compile-time params of a pattern: `ParamsOf<'/users/:id'>` is
 * `{ id: string }`, `ParamsOf<'/users/:id?'>` is `{ id?: string }`,
 * `ParamsOf<'/files/*path'>` is `{ path: string }`, plain patterns give
 * `{}`. Mapped over a name union (not an intersection) so the result stays
 * assignable to `Params` for any `P extends string`. Patterns without
 * optional segments keep the single-mapped-type shape (type-identical to a
 * hand-written object literal); optional segments widen it to an
 * intersection with the optional keys.
 */
export type ParamsOf<P extends string> =
  [OptionalSegmentNames<P>] extends [never]
    ? Record<SegmentNames<P>, string>
    : Record<Exclude<SegmentNames<P>, OptionalSegmentNames<P>>, string> &
        Partial<Record<OptionalSegmentNames<P>, string>>;

/**
 * Parses a pattern into segments. `'/'` is the root (`[]`). Throws a plain
 * `Error` on every malformed shape — patterns come from code, so a bad one
 * is a programmer error worth failing loudly at registration time.
 */
export function createSegments(pattern: string): Segment[] {
  if (pattern === '') {
    throw new Error("Invalid route pattern '': use '/' for the root");
  }
  if (!pattern.startsWith('/')) {
    throw new Error(
      `Invalid route pattern '${pattern}': must start with '/'`
    );
  }
  if (pattern === '/') {
    return [];
  }
  const parts = pattern.slice(1).split('/');
  const segments: Segment[] = [];
  // Param/wildcard names must be unique: matchSegments writes captures into
  // one object, so a duplicate name would silently let one segment's value
  // overwrite the other's.
  const names = new Set<string>();
  parts.forEach((part, index) => {
    if (part === '') {
      throw new Error(
        `Invalid route pattern '${pattern}': empty segment (from '//' or a trailing '/')`
      );
    }
    if (part.startsWith(':')) {
      // ':name?' is an optional param — it may be absent from the pathname.
      const optional = part.endsWith('?');
      const name = optional ? part.slice(1, -1) : part.slice(1);
      if (name === '' || !NAME_RE.test(name)) {
        throw new Error(
          `Invalid route pattern '${pattern}': param '${part}' must be a ':name' or ':name?' segment with name matching [A-Za-z0-9_]+`
        );
      }
      assertUniqueName(names, name, pattern);
      segments.push({ _tag: 'param', name, optional });
      return;
    }
    if (part.startsWith('*')) {
      const name = part.slice(1);
      if (name === '') {
        throw new Error(
          `Invalid route pattern '${pattern}': bare '*' — name the capture like '*rest'`
        );
      }
      if (!NAME_RE.test(name)) {
        throw new Error(
          `Invalid route pattern '${pattern}': wildcard '${part}' name must match [A-Za-z0-9_]+`
        );
      }
      // A wildcard swallows the rest of the path — nothing may follow it.
      if (index !== parts.length - 1) {
        throw new Error(
          `Invalid route pattern '${pattern}': wildcard '*${name}' must be the last segment`
        );
      }
      assertUniqueName(names, name, pattern);
      segments.push({ _tag: 'wildcard', name });
      return;
    }
    if (part.includes(':')) {
      throw new Error(
        `Invalid route pattern '${pattern}': ':' inside static segment '${part}' — a param must be a whole ':name' segment`
      );
    }
    segments.push({ _tag: 'static', value: part });
  });
  return segments;
}

function assertUniqueName(names: Set<string>, name: string, pattern: string): void {
  if (names.has(name)) {
    throw new Error(
      `Invalid route pattern '${pattern}': duplicate capture name '${name}'`
    );
  }
  names.add(name);
}

/**
 * Creates a route entry. The method is normalized to uppercase (`'ALL'`
 * matches every method); the pattern is validated via
 * {@link createSegments}. Optional `middlewares` are scoped to this route —
 * `handle` runs them between the app-level chain and the handler. The
 * literal overload types `ctx.params` through {@link ParamsOf}; the returned
 * `Route` is deliberately widened — a typed handler is contravariant in its
 * params, so `Route<{ id: string }>` would not be assignable to the `Route`
 * the matcher consumes.
 */
export function createRoute<P extends string>(
  method: string,
  pattern: P,
  handler: Handler<ParamsOf<P>>,
  middlewares?: readonly Middleware[]
): Route;
export function createRoute(
  method: string,
  pattern: string,
  handler: Handler,
  middlewares?: readonly Middleware[]
): Route;
export function createRoute(
  method: string,
  pattern: string,
  handler: Handler,
  middlewares: readonly Middleware[] = NO_MIDDLEWARES
): Route {
  if (method === '') {
    throw new Error("Invalid route: method must not be empty");
  }
  return {
    method: method.toUpperCase(),
    pattern,
    segments: createSegments(pattern),
    middlewares,
    handler,
  };
}

/**
 * Splits a pathname into segments once per request. `undefined` marks a
 * pathname the matcher never accepts (no leading '/'), and the root
 * pathname reuses the shared empty array.
 */
function splitPath(pathname: string): readonly string[] | undefined {
  if (!pathname.startsWith('/')) {
    return undefined;
  }
  const rest = pathname.slice(1);
  return rest === '' ? EMPTY_PARTS : rest.split('/');
}

/**
 * Decodes one captured value. Matching happens on the raw path — an
 * encoded '/' never fakes a segment boundary — but captures are handed to
 * handlers decoded, the contract Express and Hono deliver. A malformed
 * escape keeps the raw text instead of throwing (path-to-regexp behavior).
 */
function decodePart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** True when any segment is an optional param — routes without one keep
 * the allocation-free single-pass match below. */
function hasOptional(segments: readonly Segment[]): boolean {
  for (const segment of segments) {
    if (segment._tag === 'param' && segment.optional) {
      return true;
    }
  }
  return false;
}

/**
 * Matches a parsed pattern against pathname parts. Strict: trailing slashes
 * are significant (`'/a/'` never matches `/a` — only a wildcard can produce
 * an empty capture). Returns the captured params, or `undefined` on mismatch.
 *
 * `from` skips the leading static segments the trie already proved equal —
 * callers that walked a route's static prefix pass its depth so those
 * comparisons (and the per-attempt `params` allocation, which stays lazy
 * until the first capture) never repeat.
 */
function matchParts(
  segments: readonly Segment[],
  parts: readonly string[],
  from = 0
): Params | undefined {
  if (hasOptional(segments)) {
    return matchPartsOptional(segments, parts, from, from, undefined);
  }
  let params: Params | undefined;
  for (let i = from; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === undefined) {
      return undefined;
    }
    if (segment._tag === 'wildcard') {
      // Zero remaining segments is still a match: the capture is ''.
      if (params === undefined) {
        params = {};
      }
      params[segment.name] = decodePart(parts.slice(i).join('/'));
      return params;
    }
    const part = parts[i];
    // A param must land on a real segment — an empty one comes from a
    // trailing '/' or '//', which strict matching rejects.
    if (part === undefined || part === '') {
      return undefined;
    }
    if (segment._tag === 'static') {
      if (part !== segment.value) {
        return undefined;
      }
    } else {
      if (params === undefined) {
        params = {};
      }
      params[segment.name] = decodePart(part);
    }
  }
  // Every segment consumed — the pathname must be consumed exactly too
  // (rejects both trailing slashes and surplus path).
  if (parts.length !== segments.length) {
    return undefined;
  }
  return params ?? {};
}

/**
 * Backtracking matcher for patterns containing `:name?` segments. Each
 * optional param is tried consuming first (greedy, like path-to-regexp),
 * then skipped; on a failed consume the key written at this level is
 * deleted again before the skip attempt. Deeper keys need no cleanup: the
 * skip attempt re-runs every deeper segment from the earlier position, so
 * their keys are overwritten or their own backtrack deletes them. `i`/`j`
 * are segment/path positions; `i` starts at `from` (trie-proved prefix).
 */
function matchPartsOptional(
  segments: readonly Segment[],
  parts: readonly string[],
  i: number,
  j: number,
  params: Params | undefined
): Params | undefined {
  for (;;) {
    const segment = segments[i];
    if (segment === undefined) {
      if (j !== parts.length) {
        return undefined;
      }
      return params ?? {};
    }
    if (segment._tag === 'wildcard') {
      if (params === undefined) {
        params = {};
      }
      params[segment.name] = decodePart(parts.slice(j).join('/'));
      return params;
    }
    if (segment._tag === 'param' && segment.optional) {
      const part = parts[j];
      if (part !== undefined && part !== '') {
        const p = params ?? (params = {});
        p[segment.name] = decodePart(part);
        const consumed = matchPartsOptional(segments, parts, i + 1, j + 1, params);
        if (consumed !== undefined) {
          return consumed;
        }
        // The key was set at this level a moment ago and capture names are
        // unique per pattern (createSegments enforces it), so removing it
        // exactly undoes the failed consume — nothing else can own it.
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- see above: the deleted key is always the one this branch just wrote
        delete p[segment.name];
      }
      // Consume failed (or there was nothing to consume): skip the param.
      return matchPartsOptional(segments, parts, i + 1, j, params);
    }
    const part = parts[j];
    if (part === undefined || part === '') {
      return undefined;
    }
    if (segment._tag === 'static') {
      if (part !== segment.value) {
        return undefined;
      }
    } else {
      if (params === undefined) {
        params = {};
      }
      params[segment.name] = decodePart(part);
    }
    i += 1;
    j += 1;
  }
}

/**
 * Matches a parsed pattern against a pathname. Strict: trailing slashes are
 * significant (`'/a/'` never matches `/a` — only a wildcard can produce an
 * empty capture). Returns the captured params, or `undefined` on mismatch.
 */
export function matchSegments(
  segments: readonly Segment[],
  pathname: string
): Params | undefined {
  const parts = splitPath(pathname);
  if (parts === undefined) {
    return undefined;
  }
  return matchParts(segments, parts);
}

/**
 * A route's method matches `m` directly, or via `'ALL'`; `HEAD` requests
 * also match `GET` routes (web convention), so a server gets HEAD support
 * for free unless it registers an exact `HEAD` route.
 */
function methodCompatible(routeMethod: string, method: string): boolean {
  return (
    routeMethod === method ||
    routeMethod === 'ALL' ||
    (method === 'HEAD' && routeMethod === 'GET')
  );
}

/**
 * One static-prefix trie node. Routes file at the node their leading static
 * segments spell out (the stopping node), then split by whether any static
 * segment remains beyond that prefix:
 *
 * - `plain` — no static segment after the prefix (terminal statics, trailing
 *   params/wildcards): scanned directly, like the old per-node list.
 * - `indexed` — at least one static segment after the prefix: each such
 *   segment (absolute position → value) becomes a lookup key, so a request
 *   reaches the route by spelling any of its static segments instead of
 *   scanning every route filed at the node. This is what removes the
 *   `/:tenant/...`-style residual linear scan: such routes land at the root
 *   node and are reached by their later static segments. A route with no
 *   static segments at all (`/:a/:b/:c`) is unfindable this way and stays
 *   a linear scan — tables made of those alone remain inherently dynamic.
 *
 * Ordering across nodes is recovered by the position map instead (see
 * {@link RouteIndex.seq}).
 */
type StaticNode = {
  readonly statics: Map<string, StaticNode>;
  readonly plain: Route[];
  indexed: Map<number, Map<string, Route[]>> | undefined;
};

/** The per-route-table match index: a trie plus registration positions. */
type RouteIndex = {
  readonly root: StaticNode;
  /** Registration position per route object; decides cross-node ties. */
  readonly seq: WeakMap<Route, number>;
};

// The index is cached per routes array and versions on array identity:
// app-managed tables are snapshot-immutable (registration replaces the
// frozen array), so identity changes exactly when content does. For
// hand-built arrays passed straight to `matchRoutes`, the append-only
// contract is additionally guarded by a length check — the best a pure
// function can do over data it does not own. A route object built without
// `createRoute` still gets a position here, so array order stays
// authoritative for mixed tables.
const indexCache = new WeakMap<
  readonly Route[],
  { readonly count: number; readonly index: RouteIndex }
>();

function buildRouteIndex(routes: readonly Route[]): RouteIndex {
  const root: StaticNode = { statics: new Map(), plain: [], indexed: undefined };
  const seq = new WeakMap<Route, number>();
  routes.forEach((route, position) => {
    seq.set(route, position);
    // Walk the leading static segments — the trie path the request must
    // spell out exactly to reach this route at all.
    let node = root;
    let depth = 0;
    for (;;) {
      const segment = route.segments[depth];
      if (segment === undefined || segment._tag !== 'static') {
        break;
      }
      let child = node.statics.get(segment.value);
      if (child === undefined) {
        child = { statics: new Map(), plain: [], indexed: undefined };
        node.statics.set(segment.value, child);
      }
      node = child;
      depth += 1;
    }
    // File under every static segment beyond the leading prefix; only a
    // route with none such goes to the plain scan list. Routes containing
    // an optional segment are the exception: a shorter path can skip that
    // segment, so later static positions never line up for it — those
    // routes file on the plain list, where the backtracking matcher sees
    // every candidate.
    let indexed = false;
    let optional = false;
    for (let i = depth; i < route.segments.length; i += 1) {
      const segment = route.segments[i];
      if (segment?._tag === 'param' && segment.optional) {
        optional = true;
        continue;
      }
      if (segment?._tag !== 'static') {
        continue;
      }
      if (node.indexed === undefined) {
        node.indexed = new Map();
      }
      let byValueAtPos = node.indexed.get(i);
      if (byValueAtPos === undefined) {
        byValueAtPos = new Map();
        node.indexed.set(i, byValueAtPos);
      }
      let routesForValue = byValueAtPos.get(segment.value);
      if (routesForValue === undefined) {
        routesForValue = [];
        byValueAtPos.set(segment.value, routesForValue);
      }
      routesForValue.push(route);
      indexed = true;
    }
    if (!indexed || optional) {
      node.plain.push(route);
    }
  });
  return { root, seq };
}

function getRouteIndex(routes: readonly Route[]): RouteIndex {
  const cached = indexCache.get(routes);
  if (cached !== undefined && cached.count === routes.length) {
    return cached.index;
  }
  const index = buildRouteIndex(routes);
  indexCache.set(routes, { count: routes.length, index });
  return index;
}

/**
 * First matching route in registration order, or — when the path matched
 * but no route's method did — the allowed methods (for a 405).
 *
 * Two phases keep the common fast path untouched: method-compatible routes
 * are scanned first; only when none of them matches the path is the
 * candidate walk repeated for non-compatible hits, to build the `Allow`
 * list in registration order.
 *
 * The walk is inlined (not a shared callback) — the per-candidate closure
 * call is measurable on the sub-microsecond fast path.
 *
 * A route registered earlier than another always wins, even when the loser
 * sits at a shallower node. `strict` (default true) treats trailing slashes
 * as significant; with `strict: false`, `/a/` matches the `/a` route.
 */
export function matchRoutes(
  routes: readonly Route[],
  method: string,
  pathname: string,
  strict = true
): MatchResult | undefined {
  const rawParts = splitPath(pathname);
  if (rawParts === undefined) {
    return undefined;
  }
  // Non-strict: one trailing empty segment (a trailing slash) is trimmed
  // once per request; strict matching keeps every empty segment meaningful.
  const parts =
    !strict && rawParts.length > 0 && rawParts[rawParts.length - 1] === ''
      ? rawParts.slice(0, -1)
      : rawParts;
  const m = method.toUpperCase();
  const index = getRouteIndex(routes);

  // Phase 1: candidate walk with a position-min best match. Each candidate
  // check appears twice — once for the node's plain list, once per indexed
  // bucket — keeping the loop bodies allocation-free.
  let best: { seq: number; route: Route; params: Params } | undefined;
  let node: StaticNode | undefined = index.root;
  let depth = 0;
  while (node !== undefined) {
    for (const route of node.plain) {
      if (!methodCompatible(route.method, m)) continue;
      const params = matchParts(route.segments, parts, depth);
      if (params === undefined) continue;
      const seq = index.seq.get(route) ?? Number.MAX_SAFE_INTEGER;
      if (best === undefined || seq < best.seq) {
        best = { seq, route, params };
      }
    }
    const indexed = node.indexed;
    if (indexed !== undefined) {
      for (const [pos, byValue] of indexed) {
        const part = parts[pos];
        if (part === undefined) continue;
        const bucket = byValue.get(part);
        if (bucket === undefined) continue;
        for (const route of bucket) {
          if (!methodCompatible(route.method, m)) continue;
          const params = matchParts(route.segments, parts, depth);
          if (params === undefined) continue;
          const seq = index.seq.get(route) ?? Number.MAX_SAFE_INTEGER;
          if (best === undefined || seq < best.seq) {
            best = { seq, route, params };
          }
        }
      }
    }
    const part = parts[depth];
    if (part === undefined) break;
    node = node.statics.get(part);
    depth += 1;
  }
  if (best !== undefined) {
    return { route: best.route, params: best.params };
  }

  // Phase 2: the same walk for the `Allow` list. Position-sorted so the
  // list reads in registration order, deduping shadowed same-method
  // registrations (first one wins on dispatch, but both live in the table).
  const hits: { seq: number; method: string }[] = [];
  node = index.root;
  depth = 0;
  while (node !== undefined) {
    for (const route of node.plain) {
      // Phase 1 already proved these miss the path — they cannot 405.
      if (methodCompatible(route.method, m)) continue;
      const params = matchParts(route.segments, parts, depth);
      if (params !== undefined) {
        hits.push({
          seq: index.seq.get(route) ?? Number.MAX_SAFE_INTEGER,
          method: route.method,
        });
      }
    }
    const indexed = node.indexed;
    if (indexed !== undefined) {
      for (const [pos, byValue] of indexed) {
        const part = parts[pos];
        if (part === undefined) continue;
        const bucket = byValue.get(part);
        if (bucket === undefined) continue;
        for (const route of bucket) {
          if (methodCompatible(route.method, m)) continue;
          const params = matchParts(route.segments, parts, depth);
          if (params !== undefined) {
            hits.push({
              seq: index.seq.get(route) ?? Number.MAX_SAFE_INTEGER,
              method: route.method,
            });
          }
        }
      }
    }
    const part = parts[depth];
    if (part === undefined) break;
    node = node.statics.get(part);
    depth += 1;
  }
  if (hits.length === 0) {
    return undefined;
  }
  hits.sort((a, b) => a.seq - b.seq);
  const allowed: string[] = [];
  for (const hit of hits) {
    if (!allowed.includes(hit.method)) {
      allowed.push(hit.method);
    }
  }
  return { allowedMethods: allowed };
}

/**
 * Builds a {@link MatchFn} over {@link matchRoutes} with a fixed `strict`
 * setting — the default matcher `createApp` installs, so `strict: false`
 * survives the three-argument `MatchFn` surface.
 */
export function createMatcher(options: { strict?: boolean } = {}): MatchFn {
  const strict = options.strict ?? true;
  return (routes, method, pathname) =>
    matchRoutes(routes, method, pathname, strict);
}
