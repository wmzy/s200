import type { Ctx, Params, State } from './types';

import { isLightRequest, LightHeaders, LightResponse } from './light';

/** Headers for a response under construction: the duck-typed light view on
 * the light path (no platform construction, and {@link LightResponse}
 * keeps it by reference — zero copies), the platform `Headers` everywhere
 * else. Callers only use the structural surface both implement.
 *
 * @internal */
export function headersFor(ctx: Ctx, init: HeadersInit | undefined): Headers {
  return isLightRequest(ctx.req)
    ? (new LightHeaders(init) as unknown as Headers)
    : new Headers(init);
}

/** Byte length of a UTF-8 string: the ASCII fast path skips the encode
 * pass — JSON/HTML responses are overwhelmingly ASCII. Exported for
 * batteries that advertise content-length on strings they build. */
const encoder = new TextEncoder();

export function utf8Length(value: string): number {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 0x7f) {
      return encoder.encode(value).byteLength;
    }
  }
  return value.length;
}

/** Headers stashed by {@link setHeader} while no response exists yet.
 * WeakKeyed: entries die with the request context. */
const pendingHeaders = new WeakMap<Ctx, Map<string, string>>();

/**
 * Applies and clears `ctx`'s pending {@link setHeader} entries onto `res`.
 * Every first response materialization funnels here — {@link newResponse},
 * the bare-`Response` adoption, and the error mapping in `app.ts` — so a
 * header set before any response exists rides whichever response the
 * request ends up with: the handler's, a 404/405/500 fallback, or an error
 * response. Low-level: battery/adapter authors adopting a response that
 * bypassed `newResponse` call this; application code never needs it.
 */
export function drainPendingHeaders(ctx: Ctx, res: Response): void {
  const pending = pendingHeaders.get(ctx);
  if (pending !== undefined) {
    for (const [name, value] of pending) {
      res.headers.set(name, value);
    }
    pendingHeaders.delete(ctx);
  }
}

/**
 * Adopts an externally built `Response` as the request's response: assigns
 * `ctx.res` and applies any headers deferred via {@link setHeader} — the
 * adopted response bypassed {@link newResponse}, so this is where deferred
 * headers ride it. The one-step form of `ctx.res = res;
 * drainPendingHeaders(ctx, res)`: terminators (handler-returned
 * responses), the error mapping, and the proxy all adopt responses they
 * did not build.
 */
export function adoptResponse(ctx: Ctx, res: Response): Response {
  ctx.res = res;
  drainPendingHeaders(ctx, res);
  return res;
}

/**
 * Builds the response object for this request context: a {@link LightResponse}
 * on the adapter's opt-in light path, the platform `Response` everywhere
 * else. Every in-chain response construction goes through here, so light
 * mode stays light end to end (fallback, HEAD rewrite, batteries).
 */
export function newResponse(
  ctx: Ctx,
  body: BodyInit | Uint8Array | null,
  init?: ResponseInit
): Response {
  const res = (
    isLightRequest(ctx.req)
      ? new LightResponse(body, init)
      : new Response(body as BodyInit, init)
  ) as Response;
  drainPendingHeaders(ctx, res);
  return res;
}

/**
 * Rebuilds a materialized response with a replacement body: the tail
 * every response-rewriting site shares — `s200/etag`'s restamp,
 * `s200/compress`'s re-encode, `s200/response-check`'s verbatim rebuild,
 * and the HEAD body-strip in `handle`. Keeps the original's status and
 * statusText; ships `headers` when the rewriter built a mutated copy,
 * otherwise a copy of the original's headers. Built on
 * {@link newResponse}, so the light path stays light.
 *
 * @internal
 */
export function rebuild(
  ctx: Ctx,
  res: Response,
  body: BodyInit | Uint8Array | null,
  headers?: Headers
): Response {
  return newResponse(ctx, body, {
    status: res.status,
    statusText: res.statusText,
    headers: headers ?? new Headers(res.headers),
  });
}

/**
 * Sets one response header — the concise form of
 * `ctx.res?.headers.set(name, value)`. After `await next()` the response is
 * always materialized, so the header lands on it directly; called earlier
 * (no response yet) it is deferred and stamped onto whichever response the
 * request first materializes. A deferred value overrides the response's own
 * header of the same name — middleware policy (`x-powered-by`,
 * `cache-control`, security headers) wins over what the handler built.
 */
export function setHeader(ctx: Ctx, name: string, value: string): void {
  if (ctx.res !== undefined) {
    ctx.res.headers.set(name, value);
    return;
  }
  const pending = pendingHeaders.get(ctx);
  if (pending !== undefined) {
    pending.set(name, value);
  } else {
    pendingHeaders.set(ctx, new Map([[name, value]]));
  }
}

/** {@link setHeader} for many headers at once, in insertion order. */
export function setHeaders(
  ctx: Ctx,
  headers: Readonly<Record<string, string>>
): void {
  for (const [name, value] of Object.entries(headers)) {
    setHeader(ctx, name, value);
  }
}

/** A {@link Ctx} as it exists after `await next()` settles: the in-chain
 * invariant materializes every response — the handler's, a gate's error,
 * the `404`/`405` fallback, the mapped `500` — before the unwind starts,
 * so `res` is no longer `undefined`. Type helper for post-`next()` code:
 * helpers typed `(ctx: SettledCtx<S>) => …` read `ctx.res.status` and
 * friends without the `?.` dance, and a `Ctx` whose `res` is known set
 * assigns into it. Compile-time only — no runtime wrapper exists. */
export type SettledCtx<S extends State = State> = Ctx<Params, S> & {
  res: Response;
};

/**
 * Reads `ctx.res` once the in-chain invariant holds — the concise,
 * narrowing form of `ctx.res!`. After `await next()` settles a response
 * always exists (handler's, error-mapped, or fallback — the chain
 * materializes all of them in-band), so middleware on the unwind uses
 * this to get the `Response` without asserting. Calling it earlier is a
 * programmer error and throws a plain `Error` (not an `HttpError` — it
 * never reaches the client; it names the misuse instead).
 */
export function resOf<P extends Params, S extends State>(
  ctx: Ctx<P, S>
): Response {
  const res = ctx.res;
  if (res === undefined) {
    throw new Error(
      'resOf(ctx): no response yet — ctx.res only exists after `await next()` ' +
        'settles (every response materializes in-chain). ' +
        'Called before next()? For pre-response headers use setHeader/setHeaders.'
    );
  }
  return res;
}

/** A `Response` branded with the status literal its builder used — the
 * request-side twin of {@link JsonResponse}'s `_out`. `_status` exists only
 * at compile time; extraction happens in {@link ResolveStatus}. */
export type StatusedResponse<S extends number = number> = Response & {
  readonly _status?: S;
};

/** The branded JSON response: `_out` carries the body type at compile time
 * (never at runtime) so the app's phantom route log can type
 * `client.get(...).json()`, and `_status` carries the status literal when
 * `init.status` was one. Extraction happens in {@link ResolveOut} and
 * {@link ResolveStatus}. */
export type JsonResponse<T, S extends number = 200> = Response & {
  readonly _out?: T;
  readonly _status?: S;
};

/**
 * The one materialization tail every byte-writing respond helper funnels
 * into: advertise the exact byte length, build through
 * {@link newResponse} (light path included), and assign into `ctx.res`.
 *
 * RFC 9110 §8.6: no content-length on 1xx or 204 — a null-body response
 * with such a status must not advertise the empty size. 304 joins them
 * (§15.4.5): the would-be length is the only honest size, and s200 omits
 * the header rather than echo the size or advertise 0 — conditional 304s
 * (static layer, `s200/etag`) build on this. `byteLength === undefined`
 * (size not known here) advertises nothing; the platform then serializes
 * the length lazily.
 */
function materialize<S extends number = 200>(
  ctx: Ctx,
  body: BodyInit | Uint8Array | null,
  init: (ResponseInit & { readonly status?: S }) | undefined,
  headers: Headers,
  byteLength: number | undefined
): StatusedResponse<S> {
  const status = init?.status ?? 200;
  const nullBodyStatus =
    (status >= 100 && status < 200) || status === 204 || status === 304;
  if (byteLength !== undefined && !nullBodyStatus) {
    headers.set('content-length', String(byteLength));
  }
  ctx.res = newResponse(ctx, body, {
    status: init?.status,
    statusText: init?.statusText,
    headers,
  });
  return ctx.res as StatusedResponse<S>;
}

/** Builds a Headers view of `init` with the helper's `defaults` filled in
 * only where the caller set nothing — explicit headers always win over
 * defaults. Built on {@link headersFor}, so every legal `HeadersInit`
 * shape (a `Headers` instance, a `[name, value]` pair list, a plain
 * record) lands identically and the light path keeps its zero-copy
 * {@link LightHeaders} view. The one fill-unset loop behind the respond
 * helpers' fallback content-type and `s200/streaming`'s multi-default
 * headers. Exported for batteries that fill defaults of their own
 * instead of hand-rolling a `new Headers`.
 *
 * @internal */
export function defaultedHeaders(
  ctx: Ctx,
  init: ResponseInit | undefined,
  defaults: Readonly<Record<string, string>>
): Headers {
  const headers = headersFor(ctx, init?.headers);
  for (const [name, value] of Object.entries(defaults)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return headers;
}

/**
 * The string-body tail {@link json}/{@link text}/{@link html} share with
 * `jsonRaw` (`s200/serialize`): fills the content-type default through
 * {@link defaultedHeaders} — built on {@link headersFor}, so the light
 * path keeps its zero-copy {@link LightHeaders} view — advertises the
 * exact UTF-8 byte length with {@link materialize}'s null-body guard, and
 * assigns the built response into `ctx.res`. Exported for batteries that
 * write pre-built strings, so they ride the same header and length
 * contract as the first-party helpers instead of hand-rolling a
 * `new Headers`.
 */
export function stringResponse<S extends number = 200>(
  ctx: Ctx,
  body: string,
  init?: ResponseInit & { readonly status?: S },
  fallbackContentType?: string
): StatusedResponse<S> {
  const headers =
    fallbackContentType === undefined
      ? headersFor(ctx, init?.headers)
      : defaultedHeaders(ctx, init, { 'content-type': fallbackContentType });
  return materialize(ctx, body, init, headers, utf8Length(body));
}

/**
 * `Uint8Array` is widened beyond lib-dom's `BodyInit` because TS 5.7 made
 * plain `Uint8Array` mean `Uint8Array<ArrayBufferLike>` while `BodyInit`
 * only accepts the `ArrayBuffer`-backed flavor — every runtime (undici,
 * Bun) accepts any ArrayBufferView at runtime, and fs readers hand
 * out Buffers.
 */
export function send<S extends number = 200>(
  ctx: Ctx,
  body: BodyInit | Uint8Array | null,
  init?: ResponseInit & { readonly status?: S }
): StatusedResponse<S> {
  const headers = headersFor(ctx, init?.headers);
  // Platforms set content-length lazily at serialization (undici), so
  // HEAD responses and size-aware middlewares (etag, compress) would never
  // see it. The size is known here — advertise it explicitly.
  let length: number | undefined;
  if (typeof body === 'string') {
    length = utf8Length(body);
  } else if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
    length = body.byteLength;
  } else if (body === null) {
    length = 0;
  }
  return materialize(ctx, body, init, headers, length);
}

export function json<T = unknown, S extends number = 200>(
  ctx: Ctx,
  data: T,
  init?: ResponseInit & { readonly status?: S }
): JsonResponse<T, S> {
  return stringResponse(
    ctx,
    JSON.stringify(data),
    init,
    'application/json'
  ) as JsonResponse<T, S>;
}

export function text<S extends number = 200>(
  ctx: Ctx,
  body: string,
  init?: ResponseInit & { readonly status?: S }
): StatusedResponse<S> {
  return stringResponse(ctx, body, init, 'text/plain; charset=utf-8');
}

/**
 * Writes an HTML response. The body is NOT escaped — templating user input
 * must run it through {@link escapeHtml} first, or use a template engine
 * that does (this mirrors `hono/html`'s explicit-escape contract).
 */
export function html<S extends number = 200>(
  ctx: Ctx,
  body: string,
  init?: ResponseInit & { readonly status?: S }
): StatusedResponse<S> {
  return stringResponse(ctx, body, init, 'text/html; charset=utf-8');
}

/** Escapes the five HTML-significant characters: `& < > " '`. */
export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (ch) =>
      (
        {
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        } as const
      )[ch as '&' | '<' | '>' | '"' | "'"] ?? ch
  );
}

export function redirect<S extends number = 302>(
  ctx: Ctx,
  location: string,
  status?: S
): StatusedResponse<S> {
  ctx.res = newResponse(ctx, null, {
    status: status ?? 302,
    headers: { location },
  });
  return ctx.res as StatusedResponse<S>;
}

/**
 * The `{ error }` JSON envelope every framework-level fallback speaks:
 * the in-chain 405/404/500 terminal of `app.ts` and the out-of-chain
 * no-shard 404 of `s200/shard-dev`. One shape — status,
 * `application/json`, extra headers riding along (405's `Allow`) — with
 * one deliberate split: in-chain callers pass their `Ctx` and get
 * {@link newResponse} materialization (light path included, assigned into
 * `ctx.res`) while staying length-silent, the fallback contract
 * size-aware batteries (`s200/etag`, `s200/response-check`) treat as
 * unstamped. An out-of-chain caller passes `undefined` — no chain ever
 * ran, so no `Ctx` exists and the bare platform Response (with its honest
 * byte length stamped, since nothing under s200's control will serialize
 * it lazily) is the whole answer.
 */
export function jsonFallback(
  ctx: Ctx | undefined,
  status: number,
  message: string,
  extraHeaders?: Readonly<Record<string, string>>
): Response {
  const body = JSON.stringify({ error: message });
  if (ctx === undefined) {
    return new Response(body, {
      status,
      headers: {
        'content-type': 'application/json',
        'content-length': String(utf8Length(body)),
        ...extraHeaders,
      },
    });
  }
  ctx.res = newResponse(ctx, body, {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
  return ctx.res;
}
