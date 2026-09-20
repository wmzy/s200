import type {
  Ctx,
  ErrorHandler,
  Handler,
  MatchFn,
  Middleware,
  Next,
  NotFoundHandler,
  Plugin,
  Route,
} from './types';

import type { ParamsOf } from './router';

import { isHttpError, toErrorResponse } from './errors';
import { compose } from './compose';
import { createMatcher, createRoute } from './router';

/**
 * Options for {@link createApp}: the router is replaceable via `match`, and
 * error/404 rendering is customizable per app.
 */
export type AppOptions = {
  match?: MatchFn;
  /** Trailing-slash tolerance for the default matcher; default true = strict. */
  strict?: boolean;
  onError?: ErrorHandler;
  onNotFound?: NotFoundHandler;
};

/**
 * An application is plain data — routes, middlewares, config — mutated
 * through the registration functions. No behavior hangs off it; dispatch
 * lives in {@link handle}.
 */
export type App = {
  routes: Route[];
  middlewares: Middleware[];
  match: MatchFn;
  onError: ErrorHandler | undefined;
  onNotFound: NotFoundHandler | undefined;
};

export function createApp(options: AppOptions = {}): App {
  return {
    routes: [],
    middlewares: [],
    match: options.match ?? createMatcher({ strict: options.strict }),
    onError: options.onError,
    onNotFound: options.onNotFound,
  };
}

export function use(app: App, middleware: Middleware): App {
  app.middlewares.push(middleware);
  return app;
}

export function usePlugin(app: App, plugin: Plugin): App {
  plugin(app);
  return app;
}

/**
 * Mounts every route of `sub` under `prefix`: patterns are joined
 * (`prefix '/v1'` + `/users/:id` → `/v1/users/:id`; the sub-app root `/`
 * becomes the bare `/v1`), and `sub`'s app-level middlewares are scoped
 * onto each mounted route, running after the parent chain and before the
 * sub route's own middlewares and handler.
 *
 * Pure data transform: `sub` is copied, never mutated, so one sub-app can
 * mount under many prefixes. `sub`'s `match`/`onError`/`onNotFound` are not
 * carried over — the parent dispatches (mount routes are parent routes) and
 * the parent's error/404 policy applies. Middlewares on an empty `sub` are
 * lost (no routes to carry them); gate on the prefix with a normal `use`
 * middleware instead.
 */
export function mount(app: App, prefix: string, sub: App): App {
  if (prefix !== '' && !prefix.startsWith('/')) {
    throw new Error(`Invalid mount prefix '${prefix}': must be empty or start with '/'`);
  }
  // Normalize: '' and '/' are no-prefix; a trailing slash would double up
  // against the pattern's leading slash.
  const base = prefix === '' || prefix === '/' ? '' : prefix.replace(/\/+$/, '');
  for (const route of sub.routes) {
    const pattern = base === '' ? route.pattern : route.pattern === '/' ? base : `${base}${route.pattern}`;
    const middlewares =
      sub.middlewares.length === 0
        ? route.middlewares
        : [...sub.middlewares, ...route.middlewares];
    app.routes.push(
      createRoute(route.method, pattern, route.handler as Handler, middlewares)
    );
  }
  return app;
}

/**
 * Shared body of every route registration. `chain` is the route's
 * `[...middlewares, handler]` tuple — every element but the last is a
 * route-scoped middleware. The `Handler<never>` element accepts both
 * literal-typed handlers (contravariance: `Ctx<never>` is assignable to
 * every `Ctx<P>`) and the dynamic-pattern `Handler`, so one implementation
 * serves both overloads of each public registrar.
 */
function register(
  app: App,
  method: string,
  pattern: string,
  chain: readonly [...Middleware[], Handler<never>]
): App {
  const handler = chain[chain.length - 1];
  if (handler === undefined) {
    throw new Error(`Invalid route ${method} '${pattern}': a terminal handler is required`);
  }
  const middlewares = chain.slice(0, -1) as Middleware[];
  // matchRoutes guarantees the params keys for this pattern; the runtime
  // table stores the erased shape.
  app.routes.push(createRoute(method, pattern, handler as unknown as Handler, middlewares));
  return app;
}

export function addRoute<P extends string>(app: App, method: string, pattern: P, ...chain: [...Middleware[], Handler<ParamsOf<P>>]): App;
export function addRoute(app: App, method: string, pattern: string, ...chain: [...Middleware[], Handler]): App;
export function addRoute(app: App, method: string, pattern: string, ...chain: [...Middleware[], Handler<never>]): App {
  return register(app, method, pattern, chain);
}

export function get<P extends string>(app: App, pattern: P, ...chain: [...Middleware[], Handler<ParamsOf<P>>]): App;
export function get(app: App, pattern: string, ...chain: [...Middleware[], Handler]): App;
export function get(app: App, pattern: string, ...chain: [...Middleware[], Handler<never>]): App {
  return register(app, 'GET', pattern, chain);
}

export function post<P extends string>(app: App, pattern: P, ...chain: [...Middleware[], Handler<ParamsOf<P>>]): App;
export function post(app: App, pattern: string, ...chain: [...Middleware[], Handler]): App;
export function post(app: App, pattern: string, ...chain: [...Middleware[], Handler<never>]): App {
  return register(app, 'POST', pattern, chain);
}

export function put<P extends string>(app: App, pattern: P, ...chain: [...Middleware[], Handler<ParamsOf<P>>]): App;
export function put(app: App, pattern: string, ...chain: [...Middleware[], Handler]): App;
export function put(app: App, pattern: string, ...chain: [...Middleware[], Handler<never>]): App {
  return register(app, 'PUT', pattern, chain);
}

export function patch<P extends string>(app: App, pattern: P, ...chain: [...Middleware[], Handler<ParamsOf<P>>]): App;
export function patch(app: App, pattern: string, ...chain: [...Middleware[], Handler]): App;
export function patch(app: App, pattern: string, ...chain: [...Middleware[], Handler<never>]): App {
  return register(app, 'PATCH', pattern, chain);
}

export function del<P extends string>(app: App, pattern: P, ...chain: [...Middleware[], Handler<ParamsOf<P>>]): App;
export function del(app: App, pattern: string, ...chain: [...Middleware[], Handler]): App;
export function del(app: App, pattern: string, ...chain: [...Middleware[], Handler<never>]): App {
  return register(app, 'DELETE', pattern, chain);
}

export function head<P extends string>(app: App, pattern: P, ...chain: [...Middleware[], Handler<ParamsOf<P>>]): App;
export function head(app: App, pattern: string, ...chain: [...Middleware[], Handler]): App;
export function head(app: App, pattern: string, ...chain: [...Middleware[], Handler<never>]): App {
  return register(app, 'HEAD', pattern, chain);
}

export function options<P extends string>(app: App, pattern: P, ...chain: [...Middleware[], Handler<ParamsOf<P>>]): App;
export function options(app: App, pattern: string, ...chain: [...Middleware[], Handler]): App;
export function options(app: App, pattern: string, ...chain: [...Middleware[], Handler<never>]): App {
  return register(app, 'OPTIONS', pattern, chain);
}

export function all<P extends string>(app: App, pattern: P, ...chain: [...Middleware[], Handler<ParamsOf<P>>]): App;
export function all(app: App, pattern: string, ...chain: [...Middleware[], Handler]): App;
export function all(app: App, pattern: string, ...chain: [...Middleware[], Handler<never>]): App {
  return register(app, 'ALL', pattern, chain);
}

// Composed-chain caches. `compose`'s double-next `index` is created per
// invocation, so one composed function is safe to reuse across requests;
// only the continuation differs per request. The app cache versions on
// `middlewares.length` — `use` is push-only by contract.
const appChainCache = new WeakMap<
  App,
  { readonly count: number; readonly chain: ReturnType<typeof compose> }
>();
const routeChainCache = new WeakMap<Route, ReturnType<typeof compose>>();

function getAppChain(app: App): ReturnType<typeof compose> {
  const cached = appChainCache.get(app);
  if (cached !== undefined && cached.count === app.middlewares.length) {
    return cached.chain;
  }
  const chain = compose(app.middlewares);
  appChainCache.set(app, { count: app.middlewares.length, chain });
  return chain;
}

function getRouteChain(route: Route): ReturnType<typeof compose> {
  const cached = routeChainCache.get(route);
  if (cached !== undefined) {
    return cached;
  }
  // Terminator: the innermost "middleware" running the matched handler. A
  // returned Response is adopted only when nothing else wrote one first.
  const terminator: Middleware = async (routeCtx) => {
    const returned = await route.handler(routeCtx);
    if (returned instanceof Response && routeCtx.res === undefined) {
      routeCtx.res = returned;
    }
  };
  const chain = compose([...route.middlewares, terminator]);
  routeChainCache.set(route, chain);
  return chain;
}

/**
 * Maps a thrown value to a response through the app's error policy: custom
 * `onError` (its own failures degrade to the default mapping), or the
 * default — `HttpError` keeps its status/message, anything else logs via
 * `console.error` and becomes an anonymous 500. Shared by the in-chain
 * boundary (route/fallback errors) and the outer catch (middleware errors).
 */
async function mapError(app: App, ctx: Ctx, error: unknown): Promise<void> {
  if (app.onError === undefined) {
    // HttpErrors are intentional client errors mapped to responses; only
    // unexpected failures need surfacing — a silently swallowed 500 is
    // undebuggable in production.
    if (!isHttpError(error)) {
      console.error(error);
    }
    ctx.res = toErrorResponse(error);
    return;
  }
  try {
    await app.onError(ctx, error);
  } catch (handlerError) {
    // A crashing error handler is itself a failure — default mapping.
    ctx.res = toErrorResponse(handlerError);
  }
}

export async function handle(app: App, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const matched = app.match(app.routes, request.method, url.pathname);
  // 'route' in matched discriminates the MatchResult union: a path match
  // with no method match yields `allowedMethods` (a 405) instead of a route.
  const hit = matched !== undefined && 'route' in matched ? matched : undefined;
  const miss =
    matched !== undefined && 'allowedMethods' in matched ? matched : undefined;
  const route = hit?.route;
  const allowedMethods = miss?.allowedMethods;
  const ctx: Ctx = {
    req: request,
    url,
    params: hit?.params ?? {},
    query: url.searchParams,
    state: {},
    res: undefined,
  };
  // The chain terminal: when nothing wrote a response, the 405/404/500
  // fallback is materialized INSIDE the chain — after the route chain
  // settles but before the app middlewares unwind — so anything observing
  // the unwind (logger status, CORS stamping) sees the real response.
  const fallback = async (): Promise<void> => {
    if (ctx.res !== undefined) {
      return;
    }
    if (allowedMethods !== undefined) {
      // Path matched but no route's method did: RFC 9110 wants 405 + Allow.
      ctx.res = Response.json(
        { error: 'Method Not Allowed' },
        { status: 405, headers: { Allow: allowedMethods.join(', ') } }
      );
    } else if (route === undefined) {
      if (app.onNotFound !== undefined) {
        await app.onNotFound(ctx);
      }
      if (ctx.res === undefined) {
        ctx.res = Response.json({ error: 'Not Found' }, { status: 404 });
      }
    } else {
      ctx.res = Response.json({ error: 'No response written' }, { status: 500 });
    }
  };
  // The error boundary sits BELOW the app middlewares: a route handler (or
  // the fallback) that throws is mapped right here, so the app middlewares
  // unwind with the error response materialized — the same contract the
  // 404/405/500 fallbacks already honor. Errors thrown by a middleware
  // itself (above this boundary) are mapped by the outer catch below.
  const inner: Next = async () => {
    try {
      if (route !== undefined) {
        await getRouteChain(route)(ctx);
      }
      await fallback();
    } catch (error) {
      await mapError(app, ctx, error);
    }
  };
  try {
    await getAppChain(app)(ctx, inner);
  } catch (error) {
    await mapError(app, ctx, error);
  }
  // A custom onError may answer or leave the response unwritten — the
  // latter falls back like the in-chain terminal did (original semantics:
  // the 405/404/500 decision still applies after errors).
  if (ctx.res === undefined) {
    try {
      await fallback();
    } catch (error) {
      await mapError(app, ctx, error);
    }
  }
  if (request.method === 'HEAD') {
    // fallback()/mapError guarantee a response above, but the write happens
    // inside a closure tsc cannot see through.
    const res = ctx.res as Response;
    // HEAD must not carry a body, but content-length stays so the client can
    // learn the size a GET would have returned.
    ctx.res = new Response(null, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }
  return ctx.res as Response;
}
