/**
 * Request-id middleware: canonical request correlation id per request.
 * Incoming ids are honored (proxies stamp their own); missing ones are
 * generated. The id is exposed on `ctx.state.requestId` and stamped onto
 * the response — error responses included, since the error boundary
 * materializes them inside the chain.
 *
 * @module
 */

import type { Ctx, Middleware, Next } from './types';

export type RequestIdOptions = {
  /** Request/response header name; default `x-request-id`. */
  readonly header?: string;
  /** Id generator; default `crypto.randomUUID()`. */
  readonly generator?: () => string;
};

export function requestId(options: RequestIdOptions = {}): Middleware {
  const header = options.header ?? 'x-request-id';
  const generator = options.generator ?? (() => crypto.randomUUID());
  return (ctx: Ctx, next: Next): Promise<void> => {
    let id = ctx.req.headers.get(header);
    if (id === null || id.trim() === '') {
      id = generator();
    }
    ctx.state.requestId = id;
    ctx.req.headers.set(header, id);
    return next().then(() => {
      if (ctx.res !== undefined) {
        ctx.res.headers.set(header, id);
      }
    });
  };
}
