/**
 * Type-safe fetch client derived from an app's route table — the `data +
 * functions` payoff on the calling side. `createClient(app)` builds, at
 * creation time, one path-filling function per registered route; the
 * `Client<R>` type (driven by the app's phantom route log) restricts calls
 * to registered pattern literals with typed params.
 *
 * The client sends plain `fetch` requests (any base URL, any `fetch`
 * implementation) and returns Web Standard `Response`s — read the body
 * with `(await client.get(...)).json()`. It adds nothing to the wire
 * protocol: an s200 client talks to any server that speaks the same
 * patterns, not just an s200 app.
 *
 * @module
 */

import type { App } from './app';
import type { Params, RouteDef, Segment, State } from './types';

import type { ParamsOf } from './router';

/** `RequestInit` plus s200's query-string sugar. */
export type ClientInit = RequestInit & {
  /**
   * Query parameters appended to the request URL. Array values repeat the
   * key (`{ tag: ['a', 'b'] }` → `?tag=a&tag=b`); `undefined` values are
   * skipped; numbers and booleans stringify.
   */
  query?: Record<
    string,
    string | number | boolean | readonly (string | number | boolean)[] | undefined
  >;
};

export type ClientOptions = {
  /** Base URL prepended to every path (origin + optional prefix, no query). */
  baseUrl?: string;
  /** Fetch implementation — injectable for tests and edge runtimes. */
  fetch?: typeof fetch;
};

/** One route's call signature: params required exactly when the pattern
 * captures them (`:id`), optional when the pattern declares them (`:id?`),
 * absent for plain patterns (the `init` moves up one position). */
type RouteCall<D extends RouteDef> = D extends {
  readonly pattern: infer P extends string;
}
  ? keyof ParamsOf<P> extends never
    ? (path: P, init?: ClientInit) => Promise<Response>
    : (path: P, args: ParamsOf<P>, init?: ClientInit) => Promise<Response>
  : never;

/** Union → intersection: a union of signatures is not an overload (calls
 * require an argument matching the *intersection* of the parameters); an
 * intersection is a true overload set where each call resolves its own
 * signature. */
type Intersect<T> = (T extends unknown ? (x: T) => void : never) extends (
  x: infer I
) => void
  ? I
  : never;

/** The call signatures registered for method `M` — `ALL` routes serve
 * every method. Intersected so the method is an overloaded call target,
 * not a parameter-intersecting union. */
type MethodCalls<
  R extends readonly RouteDef[],
  M extends string
> = Intersect<
  RouteCall<Extract<R[number], { readonly method: M | 'ALL' }>>
>;

/**
 * A typed view of the app's route table. Each method is an overloaded
 * call: the first argument is a registered pattern literal, and params
 * follow exactly when that pattern captures them. Calling a method with a
 * pattern the app never registered is a compile error; a method with no
 * routes at all types `never` (not callable).
 *
 * Malformed calls (unknown pattern, missing param, non-string param)
 * throw synchronously — caller bugs fail fast instead of becoming
 * unhandled rejections; only the fetch itself is asynchronous.
 */
export type Client<R extends readonly RouteDef[]> = {
  get: MethodCalls<R, 'GET'>;
  post: MethodCalls<R, 'POST'>;
  put: MethodCalls<R, 'PUT'>;
  patch: MethodCalls<R, 'PATCH'>;
  delete: MethodCalls<R, 'DELETE'>;
  /** Alias of {@link Client.delete} — matches the `del` registrar's name. */
  del: MethodCalls<R, 'DELETE'>;
  head: MethodCalls<R, 'HEAD'>;
  options: MethodCalls<R, 'OPTIONS'>;
};

const ALL_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

type PathFn = (args: Params | undefined, init: ClientInit | undefined) => Promise<Response>;

/**
 * Builds one path-filling call for a route: static segments verbatim,
 * `:param` values percent-encoded, `*wildcard` values kept slash-joined
 * (each piece encoded, `/` preserved). Params are checked at call time —
 * a missing one is a programmer error on the caller's side.
 */
function buildPathFn(
  base: string,
  pattern: string,
  segments: readonly Segment[],
  fetcher: typeof fetch
): PathFn {
  return (args, init) => {
    const pieces: string[] = [];
    for (const segment of segments) {
      if (segment._tag === 'static') {
        pieces.push(segment.value);
        continue;
      }
      const value = args?.[segment.name];
      if (value === undefined) {
        // An absent optional segment drops out entirely (no empty piece —
        // '/users/:id?' with no id builds '/users', not '/users/').
        if (segment._tag === 'param' && segment.optional) {
          continue;
        }
        throw new Error(`Missing param '${segment.name}' for route '${pattern}'`);
      }
      if (typeof value !== 'string') {
        throw new Error(`Param '${segment.name}' for route '${pattern}' must be a string`);
      }
      if (segment._tag === 'wildcard') {
        pieces.push(
          value
            .split('/')
            .map((piece) => encodeURIComponent(piece))
            .join('/')
        );
      } else {
        pieces.push(encodeURIComponent(value));
      }
    }
    let path = base + pieces.map((piece) => `/${piece}`).join('');
    const { query, ...rest } = init ?? {};
    if (query !== undefined) {
      const search = new URLSearchParams();
      for (const [name, value] of Object.entries(query)) {
        if (value === undefined) {
          continue;
        }
        if (Array.isArray(value)) {
          for (const item of value) {
            search.append(name, String(item));
          }
        } else {
          search.append(name, String(value));
        }
      }
      const qs = search.toString();
      if (qs !== '') {
        path += `?${qs}`;
      }
    }
    return fetcher(path, rest);
  };
}

/**
 * Creates a typed HTTP client over an app's route table. Routes are
 * compiled once (no per-call route matching); each call fills its pattern
 * with the given params and issues one fetch against `baseUrl + path`.
 *
 * Dynamic-pattern routes (registered via the `pattern: string` overload)
 * type as untyped calls; `ALL` routes are offered under every method.
 */
export function createClient<
  S extends State = State,
  R extends readonly RouteDef[] = readonly RouteDef[]
>(app: App<S, R>, options: ClientOptions = {}): Client<R> {
  const baseUrl = options.baseUrl ?? '';
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const fetcher = options.fetch ?? globalThis.fetch;
  const byMethod = new Map<string, Map<string, { fn: PathFn; hasParams: boolean }>>();
  const compile = (method: string, pattern: string, segments: readonly Segment[]): void => {
    let group = byMethod.get(method);
    if (group === undefined) {
      group = new Map();
      byMethod.set(method, group);
    }
    if (group.has(pattern)) {
      return;
    }
    let hasParams = false;
    for (const segment of segments) {
      if (segment._tag !== 'static') {
        hasParams = true;
        break;
      }
    }
    group.set(pattern, { fn: buildPathFn(base, pattern, segments, fetcher), hasParams });
  };
  for (const route of app.routes) {
    if (route.method === 'ALL') {
      for (const method of ALL_METHODS) {
        compile(method, route.pattern, route.segments);
      }
      continue;
    }
    compile(route.method, route.pattern, route.segments);
  }
  const call = (method: string) => {
    return (pattern: string, ...rest: unknown[]): Promise<Response> => {
      const entry = byMethod.get(method)?.get(pattern);
      if (entry === undefined) {
        throw new Error(`No ${method} route '${pattern}' in this app`);
      }
      // Routes with captures take (args, init); routes without take
      // (init) — the phantom types say the same, and the runtime matches.
      if (entry.hasParams) {
        return entry.fn(rest[0] as Params | undefined, rest[1] as ClientInit | undefined);
      }
      return entry.fn(undefined, rest[0] as ClientInit | undefined);
    };
  };
  // The phantom R exists only at compile time; the runtime object is
  // pattern-keyed maps. The casts are honest erasure, not narrowing.
  const client: Client<R> = {
    get: call('GET') as unknown as Client<R>['get'],
    post: call('POST') as unknown as Client<R>['post'],
    put: call('PUT') as unknown as Client<R>['put'],
    patch: call('PATCH') as unknown as Client<R>['patch'],
    delete: call('DELETE') as unknown as Client<R>['delete'],
    del: call('DELETE') as unknown as Client<R>['del'],
    head: call('HEAD') as unknown as Client<R>['head'],
    options: call('OPTIONS') as unknown as Client<R>['options'],
  };
  return client;
}
