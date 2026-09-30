/**
 * Tagged HTTP error data — no `Error` subclassing, no `instanceof`.
 *
 * @module
 */

import type { Middleware } from './types';

// Only the codes a framework actually emits; anything else falls back to
// the bare word so the message stays honest instead of inventing RFC text.
const STATUS_TEXT: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  503: 'Service Unavailable',
};

/** Plain tagged data — check it with {@link isHttpError}, never `instanceof`.
 * `body` is the optional structured payload: when present,
 * {@link toErrorResponse} ships it verbatim instead of the default
 * `{ error: message }` envelope. */
export type HttpError = {
  readonly _tag: 'HttpError';
  readonly status: number;
  readonly message: string;
  readonly body?: unknown;
};

/**
 * Builds an `HttpError` value. `status` must be an integer in `[400, 599]`
 * (client/service error range only — redirect and success codes are not
 * errors). Throws a plain `Error` on anything else: a bad status is a
 * programmer error, not a runtime failure to report. The status literal
 * brands the return (`err.status` is `403`, not `number`) so `throws`
 * gates and client-side switches line up with what ships.
 *
 * `body`, when given, becomes the error response's JSON payload verbatim —
 * the return type brands it (`err.body` is `B`, not `unknown`) so callers
 * can hand structured error shapes to clients without a second envelope.
 *
 * Returning the value from a handler is sugar for throwing it: `handle`
 * rethrows a returned `HttpError` into the same error boundary, and the
 * route's phantom log infers the branch from the return type (a function
 * body's `throw` sites are invisible to the checker).
 */
export function httpError<S extends number = number, B = undefined>(
  status: S,
  message?: string,
  body?: B
): HttpError & { readonly status: S; readonly body?: B } {
  if (!Number.isInteger(status) || status < 400 || status > 599) {
    throw new Error(
      `Invalid HTTP error status ${String(status)}: expected an integer in [400, 599]`
    );
  }
  return {
    _tag: 'HttpError',
    status,
    // Default reads like a status line: "HTTP 404 Not Found" / "HTTP 418 Error".
    message: message ?? `HTTP ${String(status)} ${STATUS_TEXT[status] ?? 'Error'}`,
    // Spread, not `body`: the key must not exist when no body was given —
    // `deep.equal` consumers see today's exact shape either way.
    ...(body !== undefined ? { body } : {}),
  };
}

/** Shape predicate — duck typing is the only safe check for tagged data. */
export function isHttpError(e: unknown): e is HttpError {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { _tag?: unknown })._tag === 'HttpError' &&
    typeof (e as { status?: unknown }).status === 'number' &&
    typeof (e as { message?: unknown }).message === 'string'
  );
}

/**
 * Terminal mapping from any thrown value to a `Response`. `HttpError` keeps
 * its status and message — and when it carries a `body`, that payload ships
 * verbatim (a structured error shape instead of the default envelope);
 * everything else becomes an anonymous 500 — the error's internals never
 * leak to the client.
 */
export function toErrorResponse(error: unknown): Response {
  if (isHttpError(error)) {
    return error.body !== undefined
      ? Response.json(error.body, { status: error.status })
      : Response.json({ error: error.message }, { status: error.status });
  }
  return Response.json({ error: 'Internal Server Error' }, { status: 500 });
}

/**
 * Declares the error branches a route may answer with — a type-level
 * gate, not a runtime one: the middleware is a pure pass-through
 * (`(_ctx, next) => next()`), and the declaration exists so the route
 * log's `errors` channel can carry the shapes a thrown {@link httpError}
 * would ship to `s200/client`.
 *
 * Two flavors, mirroring `httpError` itself:
 *
 * - `throws(401, 404)` — bare statuses; an `httpError` without a `body`
 *   answers with the default `{ error: string }` envelope, so that is
 *   the declared shape;
 * - `throws({ 422: { issues: string[] } })` — a record of status → body
 *   shape, for the `httpError(status, message, body)` calls that ship a
 *   structured payload verbatim.
 *
 * Registrars collect the phantom `_errors` brand into the route def's
 * `errors` channel (`ChainErrors`); several `throws` gates on one route
 * merge their records. On the client, `res.status` gains the declared
 * literals and `res.json()` unions the declared body shapes. The checker
 * verifies none of it — the handler still has to actually throw.
 */
export function throws<S extends number>(
  ...statuses: S[]
): Middleware & { readonly _errors?: Readonly<Record<S, { error: string }>> };
export function throws<E extends Readonly<Record<number, unknown>>>(
  errors: E
): Middleware & { readonly _errors?: E };
export function throws(): Middleware {
  // Deliberately takes no runtime input: `throws` is a declaration for
  // the type checker, not a runtime check. A zero-argument signature
  // satisfies both overloads (callers always go through them).
  return (_ctx, next) => next();
}
