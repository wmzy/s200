/**
 * Security-headers middleware: stamps a safe-by-default baseline onto
 * every response on the unwind — fallback 404/405/500 responses included,
 * since they materialize inside the chain.
 *
 * Headers the response already carries are never overwritten (an
 * explicit header from a handler wins). `strictTransportSecurity`,
 * `contentSecurityPolicy`, `permissionsPolicy`,
 * `crossOriginEmbedderPolicy` and `xDnsPrefetchControl` are opt-in;
 * `removeHeaders` strips named headers (e.g. `x-powered-by`) from every
 * response.
 *
 * @module
 */

import type { Middleware } from './types';

/** One CSP/permissions-policy directive: a value, several values, or an
 * empty array for a valueless directive (`upgrade-insecure-requests`). */
export type Directive = string | readonly string[];

/** Directive map — keys serialize in insertion order. */
export type Directives = Readonly<Record<string, Directive>>;

/** Serializes a directives object into a header value: `key value(s)`
 * joined by `; ` — keys in insertion order, arrays space-joined, a
 * valueless directive renders as the bare key. */
function serializeDirectives(directives: Directives): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(directives)) {
    const values = typeof value === 'string' ? value : value.join(' ');
    parts.push(values === '' ? key : `${key} ${values}`);
  }
  return parts.join('; ');
}

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
  /** `content-security-policy`; off by default — a raw header value or a
   * directives object (`{ 'default-src': ["'self'"] }` serializes to
   * `default-src 'self'`, keys in insertion order). */
  readonly contentSecurityPolicy?: Directives | string | false;
  /** `permissions-policy`; off by default — same shapes as CSP. */
  readonly permissionsPolicy?: Directives | string | false;
  /** `cross-origin-opener-policy`; default `same-origin`. */
  readonly crossOriginOpenerPolicy?: string | false;
  /** `cross-origin-resource-policy`; default `same-origin`. */
  readonly crossOriginResourcePolicy?: string | false;
  /** `cross-origin-embedder-policy`; off by default — it requires every
   * subresource to opt in via CORP/CORS, which typically breaks images
   * and scripts from CDNs until they send CORP headers. */
  readonly crossOriginEmbedderPolicy?: string | false;
  /** `x-dns-prefetch-control`; off by default. */
  readonly xDnsPrefetchControl?: string | false;
  /** Headers stripped from every response (default none) — e.g.
   * `['x-powered-by']` to drop a framework tell. */
  readonly removeHeaders?: readonly string[];
};

/**
 * A cryptographically random 128-bit nonce, standard-base64 encoded
 * (24 chars) — for `'nonce-…'` CSP sources. Generate one per request in
 * a middleware, embed it in both the CSP header and the HTML:
 *
 * ```ts
 * use(app, secureHeaders());
 * use(app, async (ctx, next) => {
 *   const nonce = cspNonce();
 *   await next();
 *   ctx.res?.headers.set(
 *     'content-security-policy',
 *     `default-src 'self'; script-src 'nonce-${nonce}'`,
 *   );
 * });
 * ```
 *
 * Registered after `secureHeaders`, this middleware's unwind runs first,
 * so the per-request CSP lands before the static fill-only pass.
 */
export function cspNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

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
  if (
    options.crossOriginOpenerPolicy !== false
  ) {
    wanted.set('cross-origin-opener-policy', options.crossOriginOpenerPolicy ?? 'same-origin');
  }
  if (
    options.crossOriginResourcePolicy !== false
  ) {
    wanted.set('cross-origin-resource-policy', options.crossOriginResourcePolicy ?? 'same-origin');
  }
  if (
    options.crossOriginEmbedderPolicy !== undefined &&
    options.crossOriginEmbedderPolicy !== false
  ) {
    wanted.set('cross-origin-embedder-policy', options.crossOriginEmbedderPolicy);
  }
  if (
    options.xDnsPrefetchControl !== undefined &&
    options.xDnsPrefetchControl !== false
  ) {
    wanted.set('x-dns-prefetch-control', options.xDnsPrefetchControl);
  }
  const addDirectives = (
    name: string,
    value: Directives | string | false | undefined
  ): void => {
    if (value === undefined || value === false) return;
    wanted.set(
      name,
      typeof value === 'string' ? value : serializeDirectives(value)
    );
  };
  addDirectives('content-security-policy', options.contentSecurityPolicy);
  addDirectives('permissions-policy', options.permissionsPolicy);
  const remove = options.removeHeaders;
  return async (ctx, next) => {
    await next();
    const res = ctx.res;
    if (res === undefined) return;
    for (const [name, value] of wanted) {
      if (!res.headers.has(name)) {
        res.headers.set(name, value);
      }
    }
    // Removal runs after the fill pass so a named header is stripped from
    // every response — baseline default or handler-set alike.
    if (remove !== undefined) {
      for (const name of remove) res.headers.delete(name);
    }
  };
}
