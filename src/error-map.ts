/**
 * Shared error→response mapping for in-chain error boundaries. Lives in
 * its own (non-entry) module so both the HTTP dispatch (`app.ts`) and the
 * WebSocket upgrade decision (`websocket.ts`) map errors identically
 * without either exposing the helper on a public entry surface.
 *
 * @module
 */

import type { App } from './app';
import type { Ctx, Params, State } from './types';

import { isHttpError, toErrorResponse } from './errors';
import { adoptResponse, drainPendingHeaders } from './respond';

/**
 * The default {@link AppOptions.logError}: one leading context line —
 * method, pathname, and the request id when one is known — then the error
 * itself, via `console.error`. The id prefers the request-id battery's
 * `state.requestId` (set whatever header name the battery was configured
 * with) and falls back to a literal `x-request-id` header for apps that
 * set it without the battery. Runs only on the unhandled-500 path, never
 * on the hot path, so the template literal costs nothing per request.
 */
function defaultLogError(error: unknown, ctx: Ctx): void {
  const stamped = ctx.state.requestId;
  const requestId =
    typeof stamped === 'string' && stamped !== '' ? stamped : ctx.req.headers.get('x-request-id');
  // An httpError's `cause` — the wrapped db/upstream failure — is the one
  // thing the sink adds beyond the error itself: the client body never
  // carries it, so this line is where it surfaces for operators.
  const cause = isHttpError(error) ? error.cause : undefined;
  console.error(
    `[s500] ${ctx.req.method} ${ctx.url.pathname}${requestId ? ' ' + requestId : ''}`,
    error,
    ...(cause !== undefined ? [cause] : [])
  );
}

/**
 * Maps a thrown value to a response through the app's error policy: custom
 * `onError` (its own failures degrade to the default mapping), or the
 * default — `HttpError` keeps its status/message, anything else is logged
 * with request context (`logError`, default {@link defaultLogError}) and
 * becomes an anonymous 500. Shared by the in-chain boundary (route/fallback
 * errors), the outer catch (middleware errors), and the WebSocket upgrade
 * decision (`s200/websocket` maps chain errors identically).
 *
 * A thrown `HttpError`'s `headers` record (a gate's `WWW-Authenticate`
 * challenge, `Retry-After`, `RateLimit-*`) rides the default mapping via
 * `toErrorResponse`; deferred `setHeader` values then drain on top, so a
 * middleware's pending header still wins the collision.
 */
export async function mapError<S extends State = State>(
  app: App<S>,
  ctx: Ctx<Params, S>,
  error: unknown
): Promise<void> {
  if (app.onError === undefined) {
    // HttpErrors are intentional client errors mapped to responses; only
    // unexpected failures need surfacing — a silently swallowed 500 is
    // undebuggable in production. The sink is injectable per app. One
    // exception: an HttpError carrying a `cause` asked for it — the
    // wrapped origin is operator diagnostics, so it flows to the sink
    // while still mapping to its (client-safe) status.
    if (!isHttpError(error) || error.cause !== undefined) {
      (app.logError ?? defaultLogError)(error, ctx);
    }
    adoptResponse(ctx, toErrorResponse(error));
  } else {
    try {
      await app.onError(ctx, error);
    } catch (handlerError) {
      // A crashing error handler is itself a failure — default mapping.
      adoptResponse(ctx, toErrorResponse(handlerError));
    }
  }
  // An onError that wrote its response raw bypassed newResponse — headers
  // deferred onto this ctx still ride it; the default-mapping adoptions
  // above already drained.
  if (ctx.res !== undefined) {
    drainPendingHeaders(ctx, ctx.res);
  }
}
