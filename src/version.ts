/**
 * API versioning battery: NestJS-style version negotiation as a gate
 * middleware. Two header-borne strategies — `header` (a dedicated
 * `x-api-version: 2` request header) and `mediaType` (a `version`
 * parameter on the vendor JSON type: `Accept:
 * application/vnd.api+json;version=2`). The resolved version lands on
 * `ctx.state.version` before `next()` runs, and the response that unwinds
 * through the gate carries `Vary` naming the negotiated header, so shared
 * caches key per version instead of poisoning each other.
 *
 * URI versioning is deliberately not rebuilt here: mounting a sub-app per
 * version (`mount(app, '/v1', v1App)`) is the router-native equivalent and
 * composes with every other battery — this module only covers the two
 * strategies a mount cannot express.
 *
 * @module
 */

import type { Ctx, Middleware, Next } from './types';

import { parseRanges } from './accepts';
import { withVary } from './compress';
import { httpError } from './errors';

export type ApiVersionOptions = {
  /** Where the request carries its version; default `'header'`. */
  readonly strategy?: 'header' | 'mediaType';
  /** Header name for the `'header'` strategy; default `'x-api-version'`. */
  readonly header?: string;
  /**
   * Vendor subtype for the `'mediaType'` strategy, default `'vnd.api'`:
   * the gate matches `application/<mediaType>+json` entries in Accept
   * (case-insensitively) and reads their `version` parameter.
   */
  readonly mediaType?: string;
  /**
   * The supported versions — required, non-empty, matched exactly
   * (case-sensitive) against what the request carries.
   */
  readonly versions: readonly string[];
  /**
   * Version assumed when the request carries none. Without it, a
   * versionless request answers 404 `API version required`.
   */
  readonly default?: string;
};

/** The version a dedicated request header carries, blank values ignored. */
function headerVersion(ctx: Ctx, header: string): string | undefined {
  const raw = ctx.req.headers.get(header);
  if (raw === null) {
    return undefined;
  }
  const value = raw.trim();
  return value === '' ? undefined : value;
}

/**
 * The `version` parameter of the first acceptable `fullType` entry in
 * Accept that carries one — parsed by the shared Accept grammar
 * (`parseRanges`), so entries may interleave params (`;q=0.9;version=2`),
 * values may be quoted (`version="2"`), and matching is case-insensitive
 * on the type. A q=0 entry is a ban, not a preference (RFC 9110 §12.4.2,
 * the same semantics `accepts` keeps): a banned vendor type never donates
 * its version — it is skipped, so a later acceptable entry (or none)
 * decides. A vendor entry without a `version` parameter reads as
 * versionless, not as an error.
 */
function mediaTypeVersion(accept: string, fullType: string): string | undefined {
  for (const { value, q, params } of parseRanges(accept)) {
    if (value !== fullType || q === 0) continue;
    const version = params.get('version');
    if (version !== undefined && version !== '') return version;
  }
  return undefined;
}

/**
 * Resolves the request's API version and gates the chain on it: an
 * unsupported version or a versionless request without a
 * {@link ApiVersionOptions.default} answers 404 in place — the handler
 * never runs. On success `ctx.state.version` holds the version (typed
 * `unknown` by the default state bag; read it as `string` in handlers,
 * or narrow it per app via the `declare module 's200'` State merge).
 */
export function apiVersion(options: ApiVersionOptions): Middleware {
  if (!Array.isArray(options.versions) || options.versions.length === 0) {
    throw new Error('apiVersion: options.versions must be a non-empty list');
  }
  const strategy = options.strategy ?? 'header';
  const supported = new Set(options.versions);
  const header = options.header ?? 'x-api-version';
  const fullType = `application/${options.mediaType ?? 'vnd.api'}+json`.toLowerCase();
  const fallback = options.default;
  const vary = strategy === 'mediaType' ? 'Accept' : header;
  return async (ctx: Ctx, next: Next): Promise<void> => {
    const requested =
      strategy === 'mediaType'
        ? mediaTypeVersion(ctx.req.headers.get('accept') ?? '', fullType)
        : headerVersion(ctx, header);
    const version = requested ?? fallback;
    if (version === undefined) {
      throw httpError(404, 'API version required');
    }
    if (!supported.has(version)) {
      throw httpError(404, `API version not supported: ${version}`);
    }
    ctx.state.version = version;
    await next();
    // Only responses that unwind through this gate can be stamped — the
    // 404s thrown above materialize in handle's outer error path, beyond
    // this middleware's reach.
    if (ctx.res !== undefined) {
      withVary(ctx.res.headers, vary);
    }
  };
}
