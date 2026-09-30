/**
 * In-process testing toolkit — s200's answer to hono's `app.request()`:
 * dispatch real web-standard requests against an app with no server and
 * no network, plus a mechanical smoke probe derived from the route table.
 *
 * @module
 */

import type { App } from './app';

import type { Client } from './client';

import type { RouteDef, Segment, State } from './types';

import { handle } from './app';
import { createClient } from './client';


/**
 * Dummy origin for relative inputs. `new Request` demands an absolute URL,
 * so a string like `'/users/1'` must resolve against something before
 * construction — any host works, nothing ever leaves the process.
 */
const BASE_URL = 'http://s200.test';

/**
 * Resolves string inputs against the dummy origin (already-absolute
 * strings parse unchanged); URL and Request inputs are absolute by
 * construction and pass through.
 */
function toAbsolute(input: RequestInfo | URL): RequestInfo | URL {
  return typeof input === 'string' ? new URL(input, BASE_URL) : input;
}

/**
 * Dispatches one request against an app, in-process — the testing
 * equivalent of hono's `app.request()`. Relative string inputs
 * (`'/users/1'`) resolve against `http://s200.test`; URL and Request
 * inputs pass through. The full app semantics — route chains, scoped
 * middlewares, `onError`/`onNotFound`, the 404/405/500 fallbacks — come
 * free, because {@link handle} is the whole dispatch contract.
 */
export async function request<S extends State, R extends readonly RouteDef[]>(
  app: App<S, R>,
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  return handle(app, new Request(toAbsolute(input), init));
}

/**
 * A typed client over an app, routed entirely in-process:
 * `createClient` with a fetch that loops back into {@link request}.
 * Path filling, query sugar and the phantom route log are the real
 * client's; only transport is swapped.
 */
export function testClient<S extends State, R extends readonly RouteDef[]>(
  app: App<S, R>
): Client<R> {
  const inProcessFetch: typeof fetch = (input, init) => request(app, input, init);
  return createClient(app, { fetch: inProcessFetch });
}

/** One probed route's outcome: what was asked, and how it answered. */
export type ProbeRow = {
  readonly method: string;
  readonly pattern: string;
  readonly status: number;
  readonly ok: boolean;
};

/** How an `'ALL'` route is probed when no explicit list is given. */
const DEFAULT_METHODS_FOR_ALL: readonly string[] = ['GET', 'POST'];

/**
 * Synthesizes the pathname a route's own pattern guarantees to match:
 * static segments verbatim, every capture (`:name`, `:name?`, `*name`)
 * filled with the deterministic placeholder `'p' + name`. The route table
 * carries the parsed segments, so the probe is mechanically derivable —
 * no route needs a hand-written fixture.
 */
function probePath(segments: readonly Segment[]): string {
  let path = '';
  for (const segment of segments) {
    if (segment._tag === 'static') {
      path += `/${segment.value}`;
    } else {
      path += `/p${segment.name}`;
    }
  }
  return path === '' ? '/' : path;
}

/**
 * Smoke-probes every registered route: dispatches the route's own method
 * against a synthesized matching pathname and records the outcome, in
 * registration order. `'ALL'` routes are probed once per method in
 * `options.methodsForAll` (default `['GET', 'POST']`).
 *
 * The probe is a contract, not a correctness suite: every route must
 * *answer* (`ok` is `status < 500` — a thrown handler or an unwritten
 * response fails it), and params are synthesized from the pattern so a
 * miss can never masquerade as a 404. One `probeApp(app)` call in a test
 * pins the whole surface; route-table data makes it mechanical.
 */
export async function probeApp<S extends State, R extends readonly RouteDef[]>(
  app: App<S, R>,
  options: { readonly methodsForAll?: readonly string[] } = {}
): Promise<readonly ProbeRow[]> {
  const methodsForAll = options.methodsForAll ?? DEFAULT_METHODS_FOR_ALL;
  const rows: ProbeRow[] = [];
  for (const route of app.routes) {
    const path = probePath(route.segments);
    const methods = route.method === 'ALL' ? methodsForAll : [route.method];
    for (const method of methods) {
      const res = await request(app, new URL(path, BASE_URL), { method });
      rows.push({
        method,
        pattern: route.pattern,
        status: res.status,
        ok: res.status < 500,
      });
    }
  }
  return rows;
}
