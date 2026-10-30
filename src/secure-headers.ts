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

import { b64Encode } from './crypto-util';

/** One CSP/permissions-policy directive: a value, several values, or an
 * empty array for a valueless directive (`upgrade-insecure-requests`). */
export type Directive = string | readonly string[];

/** Directive map — keys serialize in insertion order. */
export type Directives = Readonly<Record<string, Directive>>;

/**
 * The nonce-carrying CSP shape of `contentSecurityPolicy`: `{ nonce: true,
 * policy }` wires the per-request nonce automatically. On entry a fresh
 * cryptographically random nonce (from {@link cspNonce}) is parked on
 * `ctx.state.cspNonce` (a string) so handlers can embed it in markup
 * (`<script nonce="…">`); on the unwind every `{{nonce}}` placeholder in
 * the policy is replaced with it before the header lands —
 * `script-src: ["'nonce-{{nonce}}'"]` ships as
 * `script-src 'nonce-m2Z…=='`. `reportOnly: true` stamps
 * `Content-Security-Policy-Report-Only` instead. The fill-only contract
 * is unchanged: a CSP header the response already carries wins, and the
 * handler builds its own from `ctx.state.cspNonce`.
 */
export type NonceCsp = {
  /** Literal `true` — the marker selecting this shape. */
  readonly nonce: true;
  /** Stamp the report-only header variant instead. */
  readonly reportOnly?: boolean;
  /** The policy — a directives object or a raw value, with `{{nonce}}`
   * wherever the nonce goes. */
  readonly policy: Directives | string;
};

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
  /** `content-security-policy`; off by default — a raw header value, a
   * directives object (`{ 'default-src': ["'self'"] }` serializes to
   * `default-src 'self'`, keys in insertion order), or the nonce-carrying
   * shape {@link NonceCsp} (`{ nonce: true, policy }` — per-request nonce
   * on `ctx.state.cspNonce`, `{{nonce}}` spliced in on the unwind). */
  readonly contentSecurityPolicy?: Directives | string | NonceCsp | false;
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
 *
 * Or skip the middleware: `secureHeaders({ contentSecurityPolicy: { nonce:
 * true, policy } })` generates the nonce per request, parks it on
 * `ctx.state.cspNonce`, and splices it into every `{{nonce}}` placeholder
 * in `policy` when the header lands — see {@link NonceCsp}.
 */
export function cspNonce(): string {
  return b64Encode(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * Baseline security headers (app-level via `use`). Runs on the unwind and
 * only fills headers the response does not already set, so handlers can
 * override anything per-route.
 */
export function secureHeaders(options: SecureHeadersOptions = {}): Middleware {
  const wanted = new Map<string, string>();
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
  // The single-value defaults: `false` opts out, a string overrides,
  // otherwise the hardcoded default wins.
  const addDefault = (name: string, value: string | false | undefined, fallback: string): void => {
    if (value === false) return;
    wanted.set(name, value ?? fallback);
  };
  addDefault('x-content-type-options', options.xContentTypeOptions, 'nosniff');
  addDefault('x-frame-options', options.xFrameOptions, 'DENY');
  addDefault('referrer-policy', options.referrerPolicy, 'strict-origin-when-cross-origin');
  addDirectives('strict-transport-security', options.strictTransportSecurity);
  addDefault('cross-origin-opener-policy', options.crossOriginOpenerPolicy, 'same-origin');
  addDefault('cross-origin-resource-policy', options.crossOriginResourcePolicy, 'same-origin');
  addDirectives('cross-origin-embedder-policy', options.crossOriginEmbedderPolicy);
  addDirectives('x-dns-prefetch-control', options.xDnsPrefetchControl);
  // The nonce shape is per-request (the placeholder is spliced in on the
  // unwind), so it never enters the static `wanted` map; every other
  // shape serializes once here.
  const csp = options.contentSecurityPolicy;
  const nonceWanted =
    typeof csp === 'object' && csp !== null && (csp as Partial<NonceCsp>).nonce === true;
  const cspHeaderName =
    nonceWanted && (csp as NonceCsp).reportOnly === true
      ? 'content-security-policy-report-only'
      : 'content-security-policy';
  const policy = nonceWanted ? (csp as NonceCsp).policy : undefined;
  const cspTemplate =
    policy === undefined
      ? undefined
      : typeof policy === 'string'
        ? policy
        : serializeDirectives(policy);
  if (!nonceWanted) {
    // The cast is honest: `nonceWanted === false` rules the NonceCsp shape
    // out, but the `nonce === true` runtime probe cannot narrow the union.
    addDirectives(
      'content-security-policy',
      csp as Directives | string | false | undefined
    );
  }
  addDirectives('permissions-policy', options.permissionsPolicy);
  const remove = options.removeHeaders;
  return async (ctx, next) => {
    // Entry segment, nonce shape only: generate and park the nonce where
    // handlers (and the unwind below) can read it. No CSP option, no
    // per-request crypto call — the static path stays exactly as it was.
    const nonce = nonceWanted ? cspNonce() : undefined;
    if (nonce !== undefined) {
      ctx.state.cspNonce = nonce;
    }
    await next();
    const res = ctx.res;
    if (res === undefined) return;
    if (nonce !== undefined && !res.headers.has(cspHeaderName)) {
      res.headers.set(cspHeaderName, (cspTemplate ?? '').replaceAll('{{nonce}}', nonce));
    }
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
