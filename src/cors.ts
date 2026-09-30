/**
 * CORS middleware: answers preflights in place and stamps allow-origin
 * headers onto actual responses.
 *
 * Middleware order matters: the stamping runs on the unwind, after the
 * chain terminal materialized the 404/405/500 fallback, so error responses
 * carry CORS headers too — a browser reading the error body needs them.
 *
 * @module
 */

import type { Ctx, Middleware, Next } from './types';

import { newResponse } from './respond';

/**
 * Options for {@link cors}. The default `'*'` origin emits the literal
 * wildcard and skips `Vary: Origin`. Browsers refuse credentialed requests
 * against a wildcard origin (fail-closed) — pair `credentials` with an
 * explicit origin or a per-request resolver.
 */
export type CorsOptions = {
  /** Fixed origin, allowlist, or per-request resolver. */
  readonly origin?:
    | string
    | readonly string[]
    | ((ctx: Ctx) => string | undefined);
  /** Preflight `Access-Control-Allow-Methods`; default echoes the request. */
  readonly methods?: string | readonly string[];
  /** Preflight `Access-Control-Allow-Headers`; default echoes the request. */
  readonly headers?: string | readonly string[];
  /** Response headers page scripts may read: `Access-Control-Expose-Headers`. */
  readonly exposeHeaders?: string | readonly string[];
  readonly credentials?: boolean;
  readonly maxAge?: number;
};

/**
 * CORS middleware (app-level via `use`, or per-route). Preflights are
 * answered in place with a 204 — the handler and any 405 fallback never
 * run. Actual responses get the CORS headers stamped on the unwind; the
 * 404/405/500 fallbacks are materialized inside the chain, so they carry
 * the headers too.
 */
export function cors(options: CorsOptions = {}): Middleware {
  const {
    origin = '*',
    methods,
    headers,
    exposeHeaders,
    credentials = false,
    maxAge,
  } = options;

  return (ctx: Ctx, next: Next): Promise<void> | void => {
    const requestOrigin = ctx.req.headers.get('origin');
    if (requestOrigin === null) {
      return next(); // not a CORS request
    }
    const resolved = resolveOrigin(origin, ctx);
    if (
      resolved === undefined ||
      (resolved !== '*' && resolved !== requestOrigin)
    ) {
      return next(); // not allowed: no CORS headers, the browser enforces
    }

    const corsHeaders: Record<string, string> = {
      'access-control-allow-origin': resolved,
    };
    const expose = toList(exposeHeaders);
    if (expose !== undefined) {
      corsHeaders['access-control-expose-headers'] = expose;
    }
    if (credentials) {
      corsHeaders['access-control-allow-credentials'] = 'true';
    }
    // Responses vary per origin whenever the origin is not the literal
    // wildcard — shared caches must be partitioned.
    if (resolved !== '*') {
      corsHeaders.vary = 'origin';
    }

    // Preflight: OPTIONS + Access-Control-Request-Method. Answered in
    // place; the handler (and any 405) must not run.
    const acrm = ctx.req.headers.get('access-control-request-method');
    if (ctx.req.method === 'OPTIONS' && acrm !== null) {
      corsHeaders['access-control-allow-methods'] = toList(methods) ?? acrm;
      const allowHeaders =
        toList(headers) ?? ctx.req.headers.get('access-control-request-headers');
      if (allowHeaders !== null) {
        corsHeaders['access-control-allow-headers'] = allowHeaders;
      }
      if (maxAge !== undefined) {
        corsHeaders['access-control-max-age'] = String(maxAge);
      }
      // newResponse keeps the light path light (a LightResponse instead of
      // a platform one) and never advertises content-length on the null
      // body — RFC 9110 §8.6 forbids it on 204.
      ctx.res = newResponse(ctx, null, { status: 204, headers: corsHeaders });
      return;
    }

    return next().then(() => {
      // Actual response: stamp on the unwind, when one was written.
      if (ctx.res !== undefined) {
        for (const [name, value] of Object.entries(corsHeaders)) {
          ctx.res.headers.set(name, value);
        }
      }
    });
  };
}

function toList(
  value: string | readonly string[] | undefined
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === 'string' ? value : value.join(', ');
}

function resolveOrigin(
  origin: CorsOptions['origin'],
  ctx: Ctx
): string | undefined {
  if (origin === undefined || origin === '*') {
    return '*';
  }
  if (typeof origin === 'function') {
    return origin(ctx);
  }
  if (typeof origin !== 'string') {
    // Allowlist: reflect the request origin only when listed.
    const requestOrigin = ctx.req.headers.get('origin');
    return requestOrigin !== null && origin.includes(requestOrigin)
      ? requestOrigin
      : undefined;
  }
  return origin;
}
