/**
 * Timeout middleware: races the rest of the chain against a deadline. When
 * the deadline wins, the chain below rejects with a 503 `HttpError` — the
 * app's error path renders it, and the unwind middlewares (logger, cors)
 * observe the real status.
 *
 * The losing work is not cancelled (it keeps running detached, like hono's
 * timeout and most ecosystems' — truly aborting it needs cooperative
 * `AbortSignal` plumbing through the handler); this only bounds the
 * response time.
 *
 * @module
 */

import type { Ctx, Middleware, Next } from './types';

import { httpError } from './errors';

export function timeout(ms: number): Middleware {
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`Invalid timeout ${String(ms)}ms: must be positive`);
  }
  return (_ctx: Ctx, next: Next): Promise<void> => {
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(httpError(503, 'Request timeout'));
      }, ms);
    });
    // The losing member must not reject unhandled: a chain that fails after
    // the deadline already won would otherwise surface as an
    // unhandledRejection (fatal under --unhandled-rejections=throw).
    const chain = next();
    chain.catch(() => undefined);
    return Promise.race([chain, deadline]).finally(() => {
      clearTimeout(timer);
    });
  };
}
