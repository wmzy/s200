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
  S extends `:${infer Name}`
    ? Name
    : S extends `*${infer Name}`
      ? Name
      : never;

/**
 * Compile-time params of a pattern: `ParamsOf<'/users/:id'>` is
 * `{ id: string }`, `ParamsOf<'/files/*path'>` is `{ path: string }`, plain
 * patterns give `{}`. Mapped over a name union (not an intersection) so the
 * result stays assignable to `Params` for any `P extends string`.
 */
export type ParamsOf<P extends string> = Record<SegmentNames<P>, string>;

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
      const name = part.slice(1);
      if (!NAME_RE.test(name)) {
        throw new Error(
          `Invalid route pattern '${pattern}': param '${part}' must be a whole ':name' segment with name matching [A-Za-z0-9_]+`
        );
      }
      assertUniqueName(names, name, pattern);
      segments.push({ _tag: 'param', name });
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
      params[segment.name] = parts.slice(i).join('/');
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
      params[segment.name] = part;
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
 * One static-prefix trie node. `list` holds the routes whose static prefix
 * ends here — each route is filed exactly once, at its stopping node (the
 * node reached after its leading static segments). Ordering across nodes is
 * recovered by the position map instead (see {@link RouteIndex.seq}).
 */
type StaticNode = {
  readonly statics: Map<string, StaticNode>;
  readonly list: Route[];
};

/** The per-route-table match index: a trie plus registration positions. */
type RouteIndex = {
  readonly root: StaticNode;
  /** Registration position per route object; decides cross-node ties. */
  readonly seq: WeakMap<Route, number>;
};

// The index is cached per routes array and versions on length — routes are
// push-only by contract (same assumption as the app chain cache). A route
// object hand-built without `createRoute` still gets a position here, so
// array order stays authoritative for mixed tables.
const indexCache = new WeakMap<
  readonly Route[],
  { readonly count: number; readonly index: RouteIndex }
>();

function buildRouteIndex(routes: readonly Route[]): RouteIndex {
  const root: StaticNode = { statics: new Map(), list: [] };
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
        child = { statics: new Map(), list: [] };
        node.statics.set(segment.value, child);
      }
      node = child;
      depth += 1;
    }
    node.list.push(route);
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
 * are scanned first; only when none of them matches the path is the path's
 * node chain scanned again for non-compatible hits, to build the `Allow`
 * list in registration order.
 *
 * The request walks the trie nodes its own segments spell out; every node
 * visited is scanned (shallow to deep) and the best match by registration
 * position wins — a route registered earlier than another always wins, even
 * when the loser sits at a shallower node.
 */
export function matchRoutes(
  routes: readonly Route[],
  method: string,
  pathname: string
): MatchResult | undefined {
  const parts = splitPath(pathname);
  if (parts === undefined) {
    return undefined;
  }
  const m = method.toUpperCase();
  const index = getRouteIndex(routes);

  // Phase 1: the shallowest-first node walk with a position-min best match.
  let best: { seq: number; route: Route; params: Params } | undefined;
  let node: StaticNode | undefined = index.root;
  let depth = 0;
  while (node !== undefined) {
    for (const route of node.list) {
      if (!methodCompatible(route.method, m)) {
        continue;
      }
      const params = matchParts(route.segments, parts, depth);
      if (params === undefined) {
        continue;
      }
      const seq = index.seq.get(route) ?? Number.MAX_SAFE_INTEGER;
      if (best === undefined || seq < best.seq) {
        best = { seq, route, params };
      }
    }
    const part = parts[depth];
    if (part === undefined) {
      break;
    }
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
    for (const route of node.list) {
      // Phase 1 already proved these miss the path — they cannot 405.
      if (methodCompatible(route.method, m)) {
        continue;
      }
      const params = matchParts(route.segments, parts, depth);
      if (params !== undefined) {
        hits.push({
          seq: index.seq.get(route) ?? Number.MAX_SAFE_INTEGER,
          method: route.method,
        });
      }
    }
    const part = parts[depth];
    if (part === undefined) {
      break;
    }
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
