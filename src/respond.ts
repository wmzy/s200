import type { Ctx } from './types';

import { isLightRequest, LightHeaders, LightResponse } from './light';

/** Headers for a response under construction: the duck-typed light view on
 * the light path (no platform construction, and {@link LightResponse}
 * keeps it by reference — zero copies), the platform `Headers` everywhere
 * else. Callers only use the structural surface both implement. */
function headersFor(ctx: Ctx, init: HeadersInit | undefined): Headers {
  return isLightRequest(ctx.req)
    ? (new LightHeaders(init) as unknown as Headers)
    : new Headers(init);
}

/** Byte length of a UTF-8 string: the ASCII fast path skips the encoder
 * allocation — JSON/HTML responses are overwhelmingly ASCII. Exported for
 * batteries that advertise content-length on strings they build. */
export function utf8Length(value: string): number {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 0x7f) {
      return new TextEncoder().encode(value).byteLength;
    }
  }
  return value.length;
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
  return (
    isLightRequest(ctx.req)
      ? new LightResponse(body, init)
      : new Response(body as BodyInit, init)
  ) as Response;
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
 * `Uint8Array` is widened beyond lib-dom's `BodyInit` because TS 5.7 made
 * plain `Uint8Array` mean `Uint8Array<ArrayBufferLike>` while `BodyInit`
 * only accepts the `ArrayBuffer`-backed flavor — every runtime (undici,
 * Bun, Deno) accepts any ArrayBufferView at runtime, and fs readers hand
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
  // RFC 9110 §8.6: no content-length on 1xx or 204 — a null-body send with
  // such a status must not advertise the empty size.
  const status = init?.status ?? 200;
  const nullBodyStatus = status >= 100 && status < 200 || status === 204;
  if (length !== undefined && !nullBodyStatus) {
    headers.set('content-length', String(length));
  }
  ctx.res = newResponse(ctx, body, {
    status: init?.status,
    statusText: init?.statusText,
    headers,
  });
  return ctx.res as StatusedResponse<S>;
}

export function json<T = unknown, S extends number = 200>(
  ctx: Ctx,
  data: T,
  init?: ResponseInit & { readonly status?: S }
): JsonResponse<T, S> {
  const body = JSON.stringify(data);
  const headers = headersFor(ctx, init?.headers);
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  headers.set('content-length', String(utf8Length(body)));
  ctx.res = newResponse(ctx, body, {
    status: init?.status,
    statusText: init?.statusText,
    headers,
  });
  return ctx.res as JsonResponse<T, S>;
}

/** Builds a Headers view of `init` with a default content-type filled in —
 * explicit headers always win over defaults. */
function defaultedHeaders(
  ctx: Ctx,
  init: ResponseInit | undefined,
  fallback: string
): Headers {
  const headers = headersFor(ctx, init?.headers);
  if (!headers.has('content-type')) {
    headers.set('content-type', fallback);
  }
  return headers;
}

export function text<S extends number = 200>(
  ctx: Ctx,
  body: string,
  init?: ResponseInit & { readonly status?: S }
): StatusedResponse<S> {
  const headers = defaultedHeaders(ctx, init, 'text/plain; charset=utf-8');
  headers.set('content-length', String(utf8Length(body)));
  ctx.res = newResponse(ctx, body, {
    status: init?.status,
    statusText: init?.statusText,
    headers,
  });
  return ctx.res as StatusedResponse<S>;
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
  const headers = defaultedHeaders(ctx, init, 'text/html; charset=utf-8');
  headers.set('content-length', String(utf8Length(body)));
  ctx.res = newResponse(ctx, body, {
    status: init?.status,
    statusText: init?.statusText,
    headers,
  });
  return ctx.res as StatusedResponse<S>;
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
