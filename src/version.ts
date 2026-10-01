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

/** Appends `value` to Vary without duplicating it (compress's shape). */
function withVary(headers: Headers, value: string): void {
  const vary = headers.get('vary');
  if (vary === null) {
    headers.set('vary', value);
    return;
  }
  if (
    !vary.split(',').some((entry) => entry.trim().toLowerCase() === value.toLowerCase())
  ) {
    headers.set('vary', `${vary}, ${value}`);
  }
}

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
 * The `version` parameter of the first `fullType` entry in Accept that
 * carries one. Entries may interleave params (`;q=0.9;version=2` — q is
 * not consulted), values may be quoted (`version="2"`), and matching is
 * case-insensitive on the type. A vendor entry without a `version`
 * parameter reads as versionless, not as an error.
 */
function mediaTypeVersion(accept: string, fullType: string): string | undefined {
  for (const entry of accept.split(',')) {
    const parts = entry.split(';');
    const type = parts[0];
    if (type === undefined || type.trim().toLowerCase() !== fullType) {
      continue;
    }
    for (const param of parts.slice(1)) {
      const eq = param.indexOf('=');
      if (eq === -1) {
        continue;
      }
      if (param.slice(0, eq).trim().toLowerCase() !== 'version') {
        continue;
      }
      const raw = param.slice(eq + 1).trim();
      const value =
        raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')
          ? raw.slice(1, -1)
          : raw;
      if (value !== '') {
        return value;
      }
    }
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
