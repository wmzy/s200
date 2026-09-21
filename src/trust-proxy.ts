/**
 * Reverse-proxy awareness as an opt-in middleware. Behind a proxy,
 * `ctx.url` carries the proxy-facing origin and `req` knows only the
 * proxy's address — this battery corrects the public view: it rewrites
 * `ctx.url`'s protocol/host from `X-Forwarded-Proto`/`X-Forwarded-Host`
 * (when present) and records the client address in `ctx.state.proxy`.
 *
 * Hops matter: each trusted proxy appends to `X-Forwarded-For`, so with
 * `hops: 1` the client IP is the last entry — the one your own proxy
 * added. Values are picked right-to-left, skipping untrusted hops.
 *
 * Everything downstream that reasons about the URL — `redirect`'s
 * absolute forms, `s200/csrf`'s Origin check, HSTS decisions in
 * `s200/secure-headers` — sees the corrected origin; register this
 * middleware before them.
 *
 * @module
 */

import type { Ctx, Middleware } from './types';

export type TrustProxyInfo = {
  /** Public scheme as the client saw it (`https` when the proxy terminates TLS). */
  readonly proto?: string;
  /** Public host (`X-Forwarded-Host`, often `example.com:443`). */
  readonly host?: string;
  /** The client address derived from `X-Forwarded-For` at the trusted hops. */
  readonly clientIp?: string;
};

export type TrustProxyOptions = {
  /** Number of trusted proxies in front of the app; default 1. */
  readonly hops?: number;
  readonly protoHeader?: string;
  readonly hostHeader?: string;
  readonly forHeader?: string;
};

/** The entry written to `ctx.state.proxy` — augment `State` to read it typed. */
export type TrustProxyState = { readonly proxy?: TrustProxyInfo };

/**
 * Applies the forwarding headers for this request: `ctx.url` is rewritten
 * in place (protocol and host only — the path never changes) and the
 * client address lands on `ctx.state.proxy.clientIp`. A request without
 * forwarding headers passes through untouched.
 */
export function trustProxy(options: TrustProxyOptions = {}): Middleware {
  const hops = options.hops ?? 1;
  const protoHeader = options.protoHeader ?? 'x-forwarded-proto';
  const hostHeader = options.hostHeader ?? 'x-forwarded-host';
  const forHeader = options.forHeader ?? 'x-forwarded-for';

  return async (ctx: Ctx, next) => {
    const take = (name: string): string | undefined => {
      const value = ctx.req.headers.get(name);
      if (value === null) {
        return undefined;
      }
      const list = value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '');
      if (list.length === 0) {
        return undefined;
      }
      return list[Math.max(0, list.length - hops)];
    };
    const proto = take(protoHeader);
    const host = take(hostHeader);
    const clientIp = take(forHeader);
    const info: TrustProxyInfo = { proto, host, clientIp };
    ctx.state.proxy = info;
    if (proto === 'http' || proto === 'https') {
      ctx.url.protocol = `${proto}:`;
    }
    if (host !== undefined && host !== '') {
      try {
        ctx.url.host = host;
      } catch {
        // A malformed forwarded host is ignored — the proxy-facing URL
        // stays, rather than throwing the request away on a header.
      }
    }
    await next();
  };
}
