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
import type { MergeRecords, Params, RouteDef, Segment, State } from './types';

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
 * absent for plain patterns (the `init` moves up one position). The
 * resolved value is the route's status-discriminated response union
 * ({@link ClientBranches}) — one {@link BranchResponse} per status the
 * route's branches and error declarations name, so `res.status` narrows
 * `res.json()`. Input phantoms ride the same signature: a `jsonBody` gate
 * types (and demands) `init.body`, a `queryParams` gate narrows
 * `init.query`; routes with neither gate keep the loose
 * {@link ClientInit} exactly. */
type RouteCall<D extends RouteDef> = D extends {
  readonly pattern: infer P extends string;
}
  ? keyof ParamsOf<P> extends never
    ? (path: P, ...init: InitArg<D>) => Promise<ClientBranches<D>>
    : (path: P, args: ParamsOf<P>, ...init: InitArg<D>) => Promise<ClientBranches<D>>
  : never;

/** The init argument as a rest tuple: a JSON-body brand makes init
 * required (the route reads a body — the caller must send one); every
 * other route keeps today's optional init. */
type InitArg<D extends RouteDef> = [DefBody<D>] extends [undefined]
  ? [init?: RouteInit<D>]
  : [init: RouteInit<D>];

/** The init one route accepts: unbranded routes keep {@link ClientInit}
 * verbatim; a `jsonBody` brand retypes `body` as the gate's parse type (a
 * JSON shape by contract — the client stringifies it at call time); a
 * `queryParams` brand replaces the loose `query` sugar with the gate's
 * declared read. `body`/`query` are omitted-and-readded so the branded
 * members win instead of intersecting the platform's looser ones. */
type RouteInit<D extends RouteDef> = [DefBody<D>] extends [undefined]
  ? [DefQuery<D>] extends [undefined]
    ? ClientInit
    : ClientInit & { query: DefQuery<D> }
  : [DefQuery<D>] extends [undefined]
    ? Omit<ClientInit, 'body'> & { body: DefBody<D> }
    : Omit<ClientInit, 'body' | 'query'> & {
        body: DefBody<D>;
        query: DefQuery<D>;
      };

/** The response-body type a route def carries, `unknown` when untyped. */
type DefOut<D extends RouteDef> = D extends { readonly out: infer O }
  ? O
  : unknown;

/** The response-status type a route def carries (its handler's status
 * brands, unioned across a union-returning handler), `number` when the
 * def has none — the status-side twin of {@link DefOut}. */
type DefStatus<D extends RouteDef> = D extends { readonly status: infer St }
  ? St
  : number;

/** The input shape a route def carries (its gates' merged `_in` brands),
 * `unknown` when the route has no input gates — the request-side twin of
 * {@link DefOut}. */
type DefIn<D extends RouteDef> = D extends { readonly in: infer I }
  ? I
  : unknown;

/** The error branches a route def carries (its `throws` gates' merged
 * `_errors` brands), an empty record when the route declares none —
 * neutral to {@link ClientResponse}'s unions: its value union is `never`
 * and its keys intersected with `number` are `never`, so error-less
 * routes keep today's exact `json()` and `status` types. */
type DefErrors<D extends RouteDef> = D extends { readonly errors: infer E }
  ? E
  : Record<never, never>;

/** The union of a record's value types — here: the body shapes a route's
 * declared error statuses may ship. */
type ValueOf<E> = E[keyof E];

/** The JSON-body type a route's `jsonBody` gate declares, `undefined`
 * when there is none. Tuple-guarded: `unknown` (the gate-less `in`) must
 * fall through to the absent case, not distribute into the pattern. */
type DefBody<D extends RouteDef> = [DefIn<D>] extends [
  { readonly json: infer T }
]
  ? T
  : undefined;

/** The query type a route's `queryParams` gate declares, `undefined` when
 * there is none. */
type DefQuery<D extends RouteDef> = [DefIn<D>] extends [
  { readonly query: infer Q }
]
  ? Q
  : undefined;

/**
 * A `Response` whose `json()` resolves to the route's declared body type —
 * a type-level view over the real fetch response (hono's `ClientResponse`
 * shape). Untyped routes resolve `unknown`, not `any`: the body is real,
 * its shape is unproven. `St` narrows `status` to the route's branded
 * status literals (`number` when the handler's statuses are unbranded);
 * across several same-method routes the intersection widens it to their
 * union — a switch over `res.status` follows. `E` adds the route's
 * `throws`-declared error branches: `json()` unions the declared error
 * body shapes onto `O` and `status` gains the declared status literals
 * (an empty record — the default — leaves both channels untouched).
 *
 * This is the FLAT view — `status` and `json()` stay uncorrelated. Route
 * calls resolve to its discriminated refinement ({@link BranchResponse}
 * unions via {@link ClientBranches}); this shape remains for consumers
 * that want one body union regardless of status.
 *
 * `json` is Omit-readded, not intersected: a plain `Response & { json() }`
 * keeps BOTH signatures, and calls resolve to the platform's
 * `Promise<any>` — the brand would exist only on paper. With the member
 * replaced, `res.json()` is the branded promise at every call site.
 */
export type ClientResponse<
  O,
  St extends number = number,
  E = Record<never, never>
> = Omit<
  Response,
  'json'
> & {
  json(): Promise<O | ValueOf<E>>;
  readonly status: St | (keyof E & number);
};

/**
 * A `Response` narrowed to ONE status/out branch: `status` is the branch's
 * literal and `json()` resolves to that branch's body type. The union of a
 * route's branches is a discriminated union, so `if (res.status === 404)`
 * narrows `res.json()` to the 404 body. Both members are Omit-readded for
 * the reason {@link ClientResponse} re-adds `json`: an intersection with
 * the platform members keeps BOTH signatures and calls resolve to the
 * platform's `Promise<any>` — the branch would exist only on paper.
 */
export type BranchResponse<S extends number, T> = Omit<
  Response,
  'json' | 'status'
> & {
  readonly status: S;
  json(): Promise<T>;
};

/** The branches channel a def carries — logs registered before the channel
 * existed (hand-built defs) fall back to the loose out/status pair. */
type DefBranches<D extends RouteDef> = D extends { readonly branches: infer B }
  ? B
  : { status: DefStatus<D>; out: DefOut<D> };

/** Every status a branch union mentions. */
type BranchStatus<B> = B extends { status: infer S extends number } ? S : never;

/** Flattens a branch union into one status → body record: same-status
 * bodies union, and a `number`-status member covers every status its union
 * partners name (its body rides along, conservatively). */
type BranchRecord<B> = {
  [K in B extends unknown ? BranchStatus<B> : never]: B extends unknown
    ? K extends BranchStatus<B>
      ? B extends { out: infer T }
        ? T
        : never
      : never
    : never;
};

/** A status → body record as one {@link BranchResponse} per status. */
type BranchPairs<R> = {
  [K in keyof R & number]: BranchResponse<K, R[K]>;
}[keyof R & number];

/**
 * The response union one route call resolves to: the def's `branches`
 * channel (its handler's status → body pairs) merged with its `errors`
 * channel (`throws` gates + returned `httpError` branches) — same-status
 * bodies union — then one {@link BranchResponse} per status. Untyped
 * routes keep today's exact surface: a single `number`-status member with
 * an `unknown` body.
 */
type ClientBranches<D extends RouteDef> = [BranchPairs<
  MergeRecords<BranchRecord<DefBranches<D>>, DefErrors<D>>
>] extends [never]
  ? BranchResponse<number, unknown>
  : BranchPairs<MergeRecords<BranchRecord<DefBranches<D>>, DefErrors<D>>>;

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
 * Whether a request body is a JSON shape (a plain object or array — the
 * typed `body` of a `jsonBody` route is a JSON shape by contract) rather
 * than one of the Web's structured body types. Checked with `instanceof`
 * against the web-standard classes only — strings, `null`, and streams,
 * blobs, forms, and byte buffers all fall through untouched.
 */
function isJsonBody(value: unknown): value is object {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof ReadableStream) &&
    !(value instanceof Blob) &&
    !(value instanceof ArrayBuffer) &&
    !(value instanceof URLSearchParams) &&
    !(value instanceof FormData) &&
    !ArrayBuffer.isView(value)
  );
}

/**
 * Builds one path-filling call for a route: static segments verbatim,
 * `:param` values percent-encoded, `*wildcard` values kept slash-joined
 * (each piece encoded, `/` preserved). Params are checked at call time —
 * a missing one is a programmer error on the caller's side.
 */
function buildPathFn(
  base: string,
  pattern: string,
  method: string,
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
    // A JSON-shape body (the typed `body` of a `jsonBody` route, or any
    // plain object passed on a loose route) is stringified and stamped
    // with `content-type: application/json` — a Headers copy, so an
    // explicitly set content-type wins. Strings and structured bodies
    // (streams, blobs, forms, buffers) pass through to fetch untouched.
    if (isJsonBody(rest.body)) {
      const headers = new Headers(rest.headers);
      if (!headers.has('content-type')) {
        headers.set('content-type', 'application/json');
      }
      return fetcher(path, { ...rest, headers, body: JSON.stringify(rest.body), method });
    }
    // The method group rides every init — a client built from the route
    // table speaks the table's methods (a stray `method` in init loses).
    return fetcher(path, { ...rest, method });
  };
}

/**
 * Creates a typed HTTP client over an app's route table. Routes are
 * compiled once (no per-call route matching); each call fills its pattern
 * with the given params and issues one fetch against `baseUrl + path`.
 *
 * Inputs type from the same route log: the pattern fixes the path and
 * params, and the route's gates tighten `init` — a `jsonBody` gate types
 * and demands `init.body` (a JSON shape, stringified with a default
 * `content-type: application/json` unless already set), a `queryParams`
 * gate replaces the loose `init.query` sugar. Response bodies still type
 * from the handler's `json()` branding alone.
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
    group.set(pattern, { fn: buildPathFn(base, pattern, method, segments, fetcher), hasParams });
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
