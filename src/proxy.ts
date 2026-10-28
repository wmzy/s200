/**
 * In-process reverse proxy: fetch-based primitives completing s200's
 * gateway story. `s200/gateway` generates the nginx/K8s/ALB configs,
 * `s200/shard-dev` dispatches across in-process shards, and this module
 * is the runtime hop itself — stream a request to an upstream URL over
 * `fetch`, hand the upstream response back, hop-by-hop headers stripped
 * both ways.
 *
 * ## Semantics
 *
 * - The request body streams through (`ctx.req.body` is handed to fetch
 *   with `duplex: 'half'`): nothing is buffered, the upstream sees bytes
 *   as the client produces them. A proxy hop consumes the request body —
 *   a middleware that already read it (`readJson` & co) breaks the
 *   forwarding and `proxyRequest` throws a plain `Error` saying so.
 * - Hop-by-hop request headers (RFC 9110 §7.6.1: `connection`,
 *   `keep-alive`, `proxy-authenticate`, `proxy-authorization`, `te`,
 *   `trailer`, `transfer-encoding`, `upgrade` — plus every token the
 *   incoming `connection` header names) are never forwarded; the same set
 *   is stripped from the upstream response.
 * - `x-forwarded-proto`, `x-forwarded-host`, and `x-forwarded-for` are
 *   APPENDED to whatever chains arrived (a proxy chain must accumulate,
 *   not overwrite). The proto/host come from the incoming request; the
 *   address comes from {@link ProxyInit.clientAddress} — a hop with no
 *   address to claim leaves `x-forwarded-for` untouched rather than
 *   appending garbage that poisons first-hop keying (`s200/rate-limit`)
 *   and `s200/trust-proxy` consumers.
 * - `accept-encoding` is pinned to `identity` upstream: the fetch
 *   transport transparently decodes content-codings, so a compressed
 *   upstream would pair a decoded body with stale `content-encoding`/
 *   `content-length` headers. Pinning identity keeps the proxied bytes
 *   and headers honest end to end; an explicit `accept-encoding` in
 *   `init.headers` overrides the pin.
 * - `redirect: 'manual'` by default: a reverse proxy passes a 3xx (and
 *   its `Location`) through verbatim instead of fetch's silent follow —
 *   no Location rewriting happens here; override with `init.redirect`.
 * - Responses pass through byte-for-byte: whatever content-length the
 *   upstream set rides along, none is fabricated, and the body stays a
 *   stream. Protocol upgrades (websockets) are NOT proxied — fetch has
 *   no upgrade path; terminate those with `s200/websocket` instead.
 * - `Host` follows the fetch spec: pinned to the target URL's authority
 *   by spec-strict runtimes (undici/node, browsers) regardless of the
 *   forwarded header set. `preserveHost: true` forwards the incoming
 *   `host` header verbatim — honored by runtimes that allow a caller-set
 *   Host (Bun), overridden on spec-strict ones; the reliable carrier of
 *   the original host is the appended `x-forwarded-host`.
 *
 * ## Failure mapping
 *
 * A fetch that rejects maps to `httpError`: if the linked signal aborted
 * — client disconnect, or a timeout battery's deadline firing on
 * `ctx.signal` — the error is `499 Client Closed Request` (nginx's
 * convention: the request's own side gave up, not the upstream); any
 * other network failure (connection refused, DNS, TLS) is `502 Bad
 * Gateway`. Both ride the standard error boundary, so `onError` and the
 * in-chain response contract apply.
 *
 * @module
 */

import type { Ctx, Middleware } from './types';

import { httpError } from './errors';
import { adoptResponse } from './respond';
import { splitTokens } from './raw-headers';

/** Hop-by-hop header names (RFC 9110 §7.6.1) — never forwarded either way. */
const HOP_BY_HOP: readonly string[] = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

/** Statuses whose responses cannot carry a body — the pass-through body
 * is dropped for them (the platform would throw on construction). */
const BODYLESS_STATUSES: readonly number[] = [204, 205, 304];

/**
 * The client address a hop can claim for `x-forwarded-for`: a fixed
 * string, or a per-request resolver (an adapter that knows the peer
 * address reads it from its own plumbing).
 */
export type ClientAddressSource = string | ((ctx: Ctx) => string | undefined);

/** Options for {@link proxyRequest}. */
export type ProxyInit = {
  /** Extra upstream request headers, applied after the forwarded set —
   * an explicit header (e.g. `accept-encoding`, `authorization`) wins. */
  readonly headers?: HeadersInit;
  /** An extra abort source, composed with `ctx.signal` via `AbortSignal.any`. */
  readonly signal?: AbortSignal;
  /** Forward the incoming `host` header verbatim; default drops it and
   * the runtime pins Host from the target URL (see the module docblock). */
  readonly preserveHost?: boolean;
  /** The address this hop appends to `x-forwarded-for`; omit when the
   * hop knows none — the existing chain then passes through untouched. */
  readonly clientAddress?: ClientAddressSource;
  /** Upstream redirect mode; default `'manual'` passes 3xx through. */
  readonly redirect?: RequestRedirect;
};

/** Options for {@link createProxy}. */
export type CreateProxyOptions = {
  /** Base URL of the upstream — origin plus optional path prefix; its own
   * query/hash are a setup error (the request's query is what ships). */
  readonly upstream: string | URL;
  /** Rewrites the pathname before forwarding — e.g. strip the mount
   * prefix: `rewrite: (p) => p.replace(/^\/api/, '') || '/'`. */
  readonly rewrite?: (pathname: string) => string;
  /** Forward the incoming `host` header (see {@link ProxyInit.preserveHost}). */
  readonly preserveHost?: boolean;
  /** The address appended to `x-forwarded-for` (see {@link ProxyInit.clientAddress}). */
  readonly clientAddress?: ClientAddressSource;
};

/** Lowercased token list of a `connection` header value (`keep-alive, x-named` → both). */
function connectionTokens(value: string | null): readonly string[] {
  return value === null ? [] : splitTokens(value);
}

/** Strips the hop-by-hop set plus the tokens `connection` names, in place. */
function stripHopByHop(headers: Headers): void {
  const tokens = connectionTokens(headers.get('connection'));
  for (const name of HOP_BY_HOP) {
    headers.delete(name);
  }
  for (const token of tokens) {
    headers.delete(token);
  }
}

/** Appends `value` to header `name`'s existing chain (`a, value`), or sets it. */
function appendForwarded(headers: Headers, name: string, value: string): void {
  const existing = headers.get(name);
  headers.set(name, existing === null || existing === '' ? value : `${existing}, ${value}`);
}

/** Resolves a {@link ClientAddressSource} for one request. */
function resolveAddress(
  source: ClientAddressSource | undefined,
  ctx: Ctx
): string | undefined {
  if (source === undefined) {
    return undefined;
  }
  return typeof source === 'function' ? source(ctx) : source;
}

/** `fetch`'s init widened by the stream-body knob (part of every modern
 * lib.dom; kept a local type so older DOM libs still compile the call). */
type FetchInit = RequestInit & { readonly duplex?: 'half' };

/**
 * Forwards `ctx`'s request to `target` (an absolute URL) over `fetch` and
 * returns the upstream response with hop-by-hop headers stripped — the
 * low-level primitive; callers own `ctx.res` (a handler returns the
 * result, a middleware assigns it). Pending `setHeader` values drain
 * onto the returned response, so headers stamped earlier in the chain
 * (request-id, security headers) ride the proxied response too.
 *
 * Throws an `HttpError` per the failure mapping in the module docblock
 * (499 on abort, 502 on network failure) — through the error boundary
 * both become in-chain responses like every s200 error.
 */
export async function proxyRequest(
  ctx: Ctx,
  target: string | URL,
  init: ProxyInit = {}
): Promise<Response> {
  if (ctx.req.bodyUsed) {
    throw new Error(
      'proxyRequest: the request body was already consumed — proxying needs the untouched stream'
    );
  }
  const url = new URL(target);
  const headers = new Headers(ctx.req.headers);
  stripHopByHop(headers);
  if (init.preserveHost !== true) {
    headers.delete('host');
  }
  // Pin identity before the caller merge, so an explicit accept-encoding wins.
  headers.set('accept-encoding', 'identity');
  if (init.headers !== undefined) {
    const extra = new Headers(init.headers);
    for (const [name, value] of extra) {
      headers.set(name, value);
    }
  }
  appendForwarded(headers, 'x-forwarded-proto', ctx.url.protocol.replace(/:$/, ''));
  appendForwarded(headers, 'x-forwarded-host', ctx.url.host);
  const address = resolveAddress(init.clientAddress, ctx);
  if (address !== undefined && address !== '') {
    appendForwarded(headers, 'x-forwarded-for', address);
  }
  const signal =
    init.signal === undefined ? ctx.signal : AbortSignal.any([ctx.signal, init.signal]);
  const body = ctx.req.body;
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: ctx.req.method,
      headers,
      body,
      redirect: init.redirect ?? 'manual',
      signal,
      ...(body !== null ? { duplex: 'half' } : {}),
    } satisfies FetchInit);
  } catch {
    // The error's transport detail (errno, TLS reason) stays internal —
    // the client learns the mapping, not the topology.
    throw httpError(
      signal.aborted ? 499 : 502,
      signal.aborted ? 'Client Closed Request' : 'Bad Gateway'
    );
  }
  const responseHeaders = new Headers(upstream.headers);
  stripHopByHop(responseHeaders);
  const passable = !BODYLESS_STATUSES.includes(upstream.status);
  const proxied = new Response(passable ? upstream.body : null, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
  // The upstream's answer becomes this ctx's response — deferred
  // setHeader values ride it. createProxy re-binds ctx.res to the same
  // object; direct proxyRequest callers keep the returned Response.
  return adoptResponse(ctx, proxied);
}

/**
 * Builds a reverse-proxy middleware: every request that reaches it is
 * forwarded to `upstream` (origin + optional path prefix + the rewritten
 * pathname + the incoming search) and the upstream response becomes
 * `ctx.res`. The middleware is a terminal — it never calls `next()` — so
 * `use(app, '/api', createProxy({ upstream, rewrite }))` is prefix
 * dispatch: everything under `/api` is now the upstream's, with `rewrite`
 * typically stripping the mount prefix.
 */
export function createProxy(options: CreateProxyOptions): Middleware {
  const base = new URL(options.upstream);
  if (base.search !== '' || base.hash !== '') {
    throw new Error(
      `createProxy: upstream must be a base URL without query/hash (got '${String(
        options.upstream
      )}') — the forwarded request carries the query`
    );
  }
  const prefix = base.pathname.replace(/\/+$/, '');
  return async (ctx) => {
    const path =
      options.rewrite === undefined ? ctx.url.pathname : options.rewrite(ctx.url.pathname);
    const target = new URL(
      `${base.origin}${prefix}${path.startsWith('/') ? path : `/${path}`}${ctx.url.search}`
    );
    ctx.res = await proxyRequest(ctx, target, {
      preserveHost: options.preserveHost,
      clientAddress: options.clientAddress,
    });
  };
}
