/**
 * Runtime response-contract enforcement (`s200/response-check`): the
 * `responses[status].schema` annotations `describeRoute` collects — the
 * same shapes `s200/openapi` documents — become checks the server
 * actually runs. The check happens on the unwind, against the
 * materialized response, so it sees exactly what the client will
 * receive: the same one-source-of-truth `withRouteValidation` gives the
 * request side, now for the response side.
 *
 * Scope, on purpose narrow:
 *
 * - only routes whose annotation carries a schema for the RESPONSE's
 *   status — unannotated routes and statuses pay one lookup;
 * - only JSON bodies (`application/json`, parameters ignored, or any
 *   `…+json` vendor type);
 * - only byte-backed bodies — an explicit `content-length`, the same
 *   detection `s200/etag` uses. Streamed responses (`s200/streaming`,
 *   SSE, chunked) are skipped, never buffered. A bodyless response
 *   (204/304/HEAD) is skipped too;
 * - a JSON-typed body that fails to parse is itself a root-level
 *   mismatch (`{ path: [], message: 'invalid JSON body' }`);
 * - undeclared object keys violate the schema — `checkSchema`'s closed
 *   shape, the `additionalProperties: false` reading `serialize`
 *   applies on output.
 *
 * The battery is a contract check, not a type layer: it never changes
 * client-side response typing (`s200/client`'s compile-time channel).
 *
 * @module
 */

import type { App } from './app';
import type { Ctx, Middleware } from './types';

import type { SchemaIssue, SerializeSchema } from './serialize';

import { httpError } from './errors';
import { getRouteMeta } from './meta';
import { newResponse } from './respond';
import { checkSchema } from './serialize';
import { formatIssuePath } from './validate';

/** The `'fail'` mode's message and envelope key. */
const MISMATCH = 'Response schema mismatch';

/** JSON media test: `application/json` (parameters ignored) or any
 * `…+json` vendor type, case-insensitively. */
function isJson(contentType: string | null): boolean {
  if (contentType === null) return false;
  const media = contentType.split(';')[0]!.trim().toLowerCase();
  return media === 'application/json' || media.endsWith('+json');
}

/** Parses and checks a JSON body text; a parse failure is itself a
 * root-level mismatch — a JSON-typed response that is not JSON breaks
 * the contract like any type error does. */
function checkJson(
  schema: SerializeSchema,
  body: string
): readonly SchemaIssue[] {
  try {
    return checkSchema(schema, JSON.parse(body));
  } catch {
    return [{ path: [], message: 'invalid JSON body' }];
  }
}

/** The `details` payload shape: the {@link formatIssuePath} string (the
 * root is `''`). */
function view(issue: SchemaIssue): { path: string; message: string } {
  return { path: formatIssuePath(issue.path), message: issue.message };
}

export type ResponseCheckOptions = {
  /**
   * What a mismatch does. `'fail'` (default) throws an
   * `httpError(500, 'Response schema mismatch')` on the unwind — the
   * normal error mapping answers (`onError` included), the client sees a
   * 500 instead of the lying body. `'report'` keeps the response and
   * calls {@link ResponseCheckOptions.onIssue} with the issues.
   */
  readonly onMismatch?: 'fail' | 'report';
  /**
   * Attach the issue paths to the `'fail'` 500 body
   * (`{ error, issues: [{ path, message }, …] }`). Default `false` —
   * paths name internal response structure, so `true` leaks it to
   * clients; keep it for development and staged environments.
   */
  readonly details?: boolean;
  /** The `'report'` sink: receives every issue of one response plus its
   * ctx. Never called in `'fail'` mode (the throw already carries the
   * failure through `onError`/`logError`). */
  readonly onIssue?: (issues: readonly SchemaIssue[], ctx: Ctx) => void;
};

/**
 * Response-contract middleware (app-level via `use`). Takes the app it
 * guards for parity with the app-scoped batteries; the check itself
 * deliberately reads the LIVE route off `ctx.route` — route tables are
 * snapshot-replaced (`withRouteValidation` rebuilds route objects,
 * re-attaching annotations), so anything captured here at creation time
 * could go stale.
 *
 * On the unwind, for every response whose route declares a schema for
 * its status: JSON byte-backed bodies are read, parsed, and checked with
 * `checkSchema`. A conforming response is rebuilt VERBATIM (the read
 * consumed the body — same status, headers, and bytes; content-length
 * still matches). A mismatch follows `onMismatch`: `'fail'` throws
 * `httpError(500, …)` (normal error mapping; `details` opts into the
 * issue-path list), `'report'` rebuilds verbatim and calls `onIssue`.
 * Everything else — no route (404/405 fallbacks), no schema for the
 * status, non-JSON content-type, bodyless, or streamed — passes through
 * untouched.
 *
 * Ordering: with `s200/compress`, register this AFTER it
 * (`use(app, compress()); use(app, responseCheck(app))`) — the unwind
 * runs reverse, so the check sees the uncompressed JSON before compress
 * rewrites it.
 */
export function responseCheck(
  app: App,
  options: ResponseCheckOptions = {}
): Middleware {
  const mode = options.onMismatch ?? 'fail';
  const details = options.details === true;
  return async (ctx: Ctx, next) => {
    await next();
    const res = ctx.res;
    // Nothing written (a custom onError declined even after the fallback)
    // or no route's handler ran (404/405) — no contract to check.
    if (res === undefined || ctx.route === undefined) return;
    const schema = getRouteMeta(ctx.route)?.responses?.[res.status]?.schema;
    if (schema === undefined) return;
    if (!isJson(res.headers.get('content-type'))) return;
    if (res.body === null) return;
    // Byte-backed detection, the etag contract: streamed bodies carry no
    // explicit content-length — skip them, never buffer.
    if (res.headers.get('content-length') === null) return;
    const body = await res.text();
    const issues = checkJson(schema, body);
    if (issues.length > 0) {
      if (mode === 'fail') {
        // Through the normal error mapping: an unwind throw is caught by
        // handle's outer boundary — onError/toErrorResponse answer it.
        // `toErrorResponse` ships the body verbatim, so the details form
        // carries the envelope key itself.
        throw httpError(
          500,
          MISMATCH,
          details
            ? { error: MISMATCH, issues: issues.map(view) }
            : undefined
        );
      }
      options.onIssue?.(issues, ctx);
    }
    // The read consumed the body — rebuild verbatim so the same bytes,
    // status, and headers (content-length included) ship.
    ctx.res = newResponse(ctx, body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
}
