/**
 * Pattern router: strict segment matching over registered routes, plus the
 * `ParamsOf` template-literal type that types route handlers at compile time.
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
 * Matches a parsed pattern against a pathname. Strict: trailing slashes are
 * significant (`'/a/'` never matches `/a` — only a wildcard can produce an
 * empty capture). Returns the captured params, or `undefined` on mismatch.
 */
export function matchSegments(
  segments: readonly Segment[],
  pathname: string
): Params | undefined {
  if (!pathname.startsWith('/')) {
    return undefined;
  }
  const rest = pathname.slice(1);
  const parts = rest === '' ? [] : rest.split('/');
  const params: Params = {};
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === undefined) {
      return undefined;
    }
    if (segment._tag === 'wildcard') {
      // Zero remaining segments is still a match: the capture is ''.
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
      params[segment.name] = part;
    }
  }
  // Every segment consumed — the pathname must be consumed exactly too
  // (rejects both trailing slashes and surplus path).
  if (parts.length !== segments.length) {
    return undefined;
  }
  return params;
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
 * First matching route in registration order, or — when the path matched
 * but no route's method did — the allowed methods (for a 405). Two phases
 * keep the common fast path untouched: method-compatible routes are scanned
 * first; only when none of them matches the path is the rest of the table
 * scanned for path hits, to build the `Allow` list.
 */
export function matchRoutes(
  routes: readonly Route[],
  method: string,
  pathname: string
): MatchResult | undefined {
  const m = method.toUpperCase();
  for (const route of routes) {
    if (!methodCompatible(route.method, m)) {
      continue;
    }
    const params = matchSegments(route.segments, pathname);
    if (params !== undefined) {
      return { route, params };
    }
  }
  const allowed: string[] = [];
  for (const route of routes) {
    // Phase 1 already proved these miss the path — they cannot 405.
    if (methodCompatible(route.method, m)) {
      continue;
    }
    const params = matchSegments(route.segments, pathname);
    // `includes` dedupes shadowed same-method registrations (first one wins
    // on dispatch, but both live in the table).
    if (params !== undefined && !allowed.includes(route.method)) {
      allowed.push(route.method);
    }
  }
  return allowed.length === 0 ? undefined : { allowedMethods: allowed };
}
