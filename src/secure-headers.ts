/**
 * Security-headers middleware: stamps a safe-by-default baseline onto
 * every response on the unwind — fallback 404/405/500 responses included,
 * since they materialize inside the chain.
 *
 * Headers the response already carries are never overwritten (an
 * explicit header from a handler wins). `strictTransportSecurity` is
 * opt-in: behind a TLS-terminating proxy a stray HSTS header can pin a
 * domain to a broken setup.
 *
 * @module
 */

import type { Middleware } from './types';

export type SecureHeadersOptions = {
  /** `x-content-type-options`; default `nosniff`. `false` drops it. */
  readonly xContentTypeOptions?: string | false;
  /** `x-frame-options`; default `DENY` (a SAMEORIGIN/embedding app may
   * want `SAMEORIGIN` or a CSP frame-ancestors policy instead). */
  readonly xFrameOptions?: string | false;
  /** `referrer-policy`; default `strict-origin-when-cross-origin`. */
  readonly referrerPolicy?: string | false;
  /** `strict-transport-security`; off by default — enable explicitly. */
  readonly strictTransportSecurity?: string | false;
};

/**
 * Baseline security headers (app-level via `use`). Runs on the unwind and
 * only fills headers the response does not already set, so handlers can
 * override anything per-route.
 */
export function secureHeaders(options: SecureHeadersOptions = {}): Middleware {
  const wanted = new Map<string, string>();
  if (options.xContentTypeOptions !== false) {
    wanted.set('x-content-type-options', options.xContentTypeOptions ?? 'nosniff');
  }
  if (options.xFrameOptions !== false) {
    wanted.set('x-frame-options', options.xFrameOptions ?? 'DENY');
  }
  if (options.referrerPolicy !== false) {
    wanted.set('referrer-policy', options.referrerPolicy ?? 'strict-origin-when-cross-origin');
  }
  if (
    options.strictTransportSecurity !== undefined &&
    options.strictTransportSecurity !== false
  ) {
    wanted.set('strict-transport-security', options.strictTransportSecurity);
  }
  return async (ctx, next) => {
    await next();
    const res = ctx.res;
    if (res === undefined) return;
    for (const [name, value] of wanted) {
      if (!res.headers.has(name)) {
        res.headers.set(name, value);
      }
    }
  };
}
