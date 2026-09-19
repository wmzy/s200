/**
 * Tagged HTTP error data — no `Error` subclassing, no `instanceof`.
 *
 * @module
 */

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

/** Plain tagged data — check it with {@link isHttpError}, never `instanceof`. */
export type HttpError = {
  readonly _tag: 'HttpError';
  readonly status: number;
  readonly message: string;
};

/**
 * Builds an `HttpError` value. `status` must be an integer in `[400, 599]`
 * (client/service error range only — redirect and success codes are not
 * errors). Throws a plain `Error` on anything else: a bad status is a
 * programmer error, not a runtime failure to report.
 */
export function httpError(status: number, message?: string): HttpError {
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
 * its status and message; everything else becomes an anonymous 500 — the
 * error's internals never leak to the client.
 */
export function toErrorResponse(error: unknown): Response {
  if (isHttpError(error)) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  return Response.json({ error: 'Internal Server Error' }, { status: 500 });
}
