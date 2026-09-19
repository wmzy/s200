import type {
  Ctx,
  ErrorHandler,
  Handler,
  MatchFn,
  Middleware,
  NotFoundHandler,
  Plugin,
  Route,
} from './types';

import type { ParamsOf } from './router';

import { toErrorResponse } from './errors';
import { compose } from './compose';
import { createRoute, matchRoutes } from './router';

/**
 * Options for {@link createApp}: the router is replaceable via `match`, and
 * error/404 rendering is customizable per app.
 */
export type AppOptions = {
  match?: MatchFn;
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
    match: options.match ?? matchRoutes,
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
 * Shared body of every route registration. The `Handler<never>` parameter
 * accepts both literal-typed handlers (contravariance: `Ctx<never>` is
 * assignable to every `Ctx<P>`) and the dynamic-pattern `Handler`, so one
 * implementation serves both overloads of each public registrar.
 */
function register(app: App, method: string, pattern: string, handler: Handler<never>): App {
  // matchRoutes guarantees the params keys for this pattern; the runtime
  // table stores the erased shape.
  app.routes.push(createRoute(method, pattern, handler as unknown as Handler));
  return app;
}

export function addRoute<P extends string>(
  app: App,
  method: string,
  pattern: P,
  handler: Handler<ParamsOf<P>>
): App;
export function addRoute(app: App, method: string, pattern: string, handler: Handler): App;
export function addRoute(app: App, method: string, pattern: string, handler: Handler<never>): App {
  return register(app, method, pattern, handler);
}

export function get<P extends string>(app: App, pattern: P, handler: Handler<ParamsOf<P>>): App;
export function get(app: App, pattern: string, handler: Handler): App;
export function get(app: App, pattern: string, handler: Handler<never>): App {
  return register(app, 'GET', pattern, handler);
}

export function post<P extends string>(app: App, pattern: P, handler: Handler<ParamsOf<P>>): App;
export function post(app: App, pattern: string, handler: Handler): App;
export function post(app: App, pattern: string, handler: Handler<never>): App {
  return register(app, 'POST', pattern, handler);
}

export function put<P extends string>(app: App, pattern: P, handler: Handler<ParamsOf<P>>): App;
export function put(app: App, pattern: string, handler: Handler): App;
export function put(app: App, pattern: string, handler: Handler<never>): App {
  return register(app, 'PUT', pattern, handler);
}

export function patch<P extends string>(app: App, pattern: P, handler: Handler<ParamsOf<P>>): App;
export function patch(app: App, pattern: string, handler: Handler): App;
export function patch(app: App, pattern: string, handler: Handler<never>): App {
  return register(app, 'PATCH', pattern, handler);
}

export function del<P extends string>(app: App, pattern: P, handler: Handler<ParamsOf<P>>): App;
export function del(app: App, pattern: string, handler: Handler): App;
export function del(app: App, pattern: string, handler: Handler<never>): App {
  return register(app, 'DELETE', pattern, handler);
}

export function head<P extends string>(app: App, pattern: P, handler: Handler<ParamsOf<P>>): App;
export function head(app: App, pattern: string, handler: Handler): App;
export function head(app: App, pattern: string, handler: Handler<never>): App {
  return register(app, 'HEAD', pattern, handler);
}

export function options<P extends string>(app: App, pattern: P, handler: Handler<ParamsOf<P>>): App;
export function options(app: App, pattern: string, handler: Handler): App;
export function options(app: App, pattern: string, handler: Handler<never>): App {
  return register(app, 'OPTIONS', pattern, handler);
}

export function all<P extends string>(app: App, pattern: P, handler: Handler<ParamsOf<P>>): App;
export function all(app: App, pattern: string, handler: Handler): App;
export function all(app: App, pattern: string, handler: Handler<never>): App {
  return register(app, 'ALL', pattern, handler);
}

export async function handle(app: App, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const matched = app.match(app.routes, request.method, url.pathname);
  const ctx: Ctx = {
    req: request,
    params: matched === undefined ? {} : matched.params,
    query: url.searchParams,
    state: {},
    res: undefined,
  };
  // Terminator: the innermost "middleware" running the matched handler. It is
  // a no-op on unmatched requests so middlewares still run (a static
  // middleware may respond) and onNotFound stays reachable.
  const dispatch: Middleware = async (routeCtx) => {
    if (matched === undefined) return;
    const returned = await matched.route.handler(routeCtx);
    if (returned instanceof Response && routeCtx.res === undefined) {
      routeCtx.res = returned;
    }
  };
  try {
    await compose([...app.middlewares, dispatch])(ctx);
  } catch (error) {
    if (app.onError === undefined) {
      ctx.res = toErrorResponse(error);
    } else {
      try {
        await app.onError(ctx, error);
      } catch (handlerError) {
        // A crashing error handler is itself a failure — default mapping.
        ctx.res = toErrorResponse(handlerError);
      }
    }
  }
  if (ctx.res === undefined) {
    if (matched === undefined) {
      if (app.onNotFound !== undefined) {
        await app.onNotFound(ctx);
      }
      if (ctx.res === undefined) {
        ctx.res = Response.json({ error: 'Not Found' }, { status: 404 });
      }
    } else {
      ctx.res = Response.json({ error: 'No response written' }, { status: 500 });
    }
  }
  if (request.method === 'HEAD') {
    const res = ctx.res;
    // HEAD must not carry a body, but content-length stays so the client can
    // learn the size a GET would have returned.
    ctx.res = new Response(null, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }
  return ctx.res;
}
