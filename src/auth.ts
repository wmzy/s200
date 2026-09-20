/**
 * Authentication gates: `basicAuth` and `bearerAuth` — zero-dependency
 * header verification middleware. The `verify` function decides; a failed
 * or missing credential is answered in place with `401` +
 * `WWW-Authenticate`, and the rest of the chain never runs.
 *
 * Note: credential comparison inside `verify` is yours — use a
 * constant-time compare for secrets (e.g. the same technique
 * `s200/cookies` uses for signatures).
 *
 * @module
 */

import type { Ctx, Middleware } from './types';

import { json } from './respond';

function unauthorized(ctx: Ctx, challenge: string): Response {
  return json(ctx, { error: 'Unauthorized' }, {
    status: 401,
    headers: { 'www-authenticate': challenge },
  });
}

/**
 * Decodes `Basic base64(user:pass)`. atob yields the base64 payload as
 * latin1 bytes; decoding them as UTF-8 lets non-ASCII credentials
 * round-trip. Malformed input returns `undefined` (→ 401, never a throw).
 */
function decodeBasic(header: string): [string, string] | undefined {
  const match = /^Basic\s+(.+)$/i.exec(header);
  const payload = match?.[1];
  if (payload === undefined) return undefined;
  let text: string;
  try {
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    text = new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
  const colon = text.indexOf(':');
  if (colon < 0) return undefined;
  return [text.slice(0, colon), text.slice(colon + 1)];
}

export type BasicAuthOptions = {
  /** Realm advertised in the 401 challenge; default `'s200'`. */
  readonly realm?: string;
};

/**
 * Basic-auth gate: `verify(username, password, ctx)` decides. Truthy →
 * `next()`; otherwise 401 with a `Basic` challenge, in place.
 */
export function basicAuth(
  verify: (username: string, password: string, ctx: Ctx) => boolean | Promise<boolean>,
  options: BasicAuthOptions = {}
): Middleware {
  const challenge = `Basic realm="${options.realm ?? 's200'}"`;
  return async (ctx, next) => {
    const header = ctx.req.headers.get('authorization');
    const creds = header === null ? undefined : decodeBasic(header);
    if (creds === undefined || !(await verify(creds[0], creds[1], ctx))) {
      unauthorized(ctx, challenge);
      return;
    }
    return next();
  };
}

export type BearerAuthOptions = {
  /** Realm advertised in the 401 challenge; default `'s200'`. */
  readonly realm?: string;
};

/**
 * Bearer-token gate: `verify(token, ctx)` decides. Truthy → `next()`;
 * otherwise 401 with a `Bearer` challenge, in place.
 */
export function bearerAuth(
  verify: (token: string, ctx: Ctx) => boolean | Promise<boolean>,
  options: BearerAuthOptions = {}
): Middleware {
  const challenge = `Bearer realm="${options.realm ?? 's200'}"`;
  return async (ctx, next) => {
    const header = ctx.req.headers.get('authorization');
    const token =
      header === null ? undefined : /^Bearer\s+(.+)$/i.exec(header)?.[1];
    if (token === undefined || !(await verify(token, ctx))) {
      unauthorized(ctx, challenge);
      return;
    }
    return next();
  };
}
