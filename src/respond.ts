import type { Ctx } from './types';

import { isLightRequest, LightResponse } from './light';

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

/** The branded JSON response: `_out` carries the body type at compile time
 * (never at runtime) so the app's phantom route log can type
 * `client.get(...).json()`. Extraction happens in {@link ResolveOut}. */
export type JsonResponse<T> = Response & { readonly _out?: T };

/**
 * `Uint8Array` is widened beyond lib-dom's `BodyInit` because TS 5.7 made
 * plain `Uint8Array` mean `Uint8Array<ArrayBufferLike>` while `BodyInit`
 * only accepts the `ArrayBuffer`-backed flavor — every runtime (undici,
 * Bun, Deno) accepts any ArrayBufferView at runtime, and fs readers hand
 * out Buffers.
 */
export function send(
  ctx: Ctx,
  body: BodyInit | Uint8Array | null,
  init?: ResponseInit
): Response {
  const headers = new Headers(init?.headers);
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
  if (length !== undefined) {
    headers.set('content-length', String(length));
  }
  ctx.res = newResponse(ctx, body, {
    status: init?.status,
    statusText: init?.statusText,
    headers,
  });
  return ctx.res;
}

export function json<T = unknown>(
  ctx: Ctx,
  data: T,
  init?: ResponseInit
): JsonResponse<T> {
  const body = JSON.stringify(data);
  const headers = new Headers(init?.headers);
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  headers.set('content-length', String(utf8Length(body)));
  ctx.res = newResponse(ctx, body, {
    status: init?.status,
    statusText: init?.statusText,
    headers,
  });
  return ctx.res as JsonResponse<T>;
}

/** Builds a Headers view of `init` with a default content-type filled in —
 * explicit headers always win over defaults. */
function defaultedHeaders(
  init: ResponseInit | undefined,
  fallback: string
): Headers {
  const headers = new Headers(init?.headers);
  if (!headers.has('content-type')) {
    headers.set('content-type', fallback);
  }
  return headers;
}

export function text(ctx: Ctx, body: string, init?: ResponseInit): Response {
  const headers = defaultedHeaders(init, 'text/plain; charset=utf-8');
  headers.set('content-length', String(utf8Length(body)));
  ctx.res = newResponse(ctx, body, {
    status: init?.status,
    statusText: init?.statusText,
    headers,
  });
  return ctx.res;
}

/**
 * Writes an HTML response. The body is NOT escaped — templating user input
 * must run it through {@link escapeHtml} first, or use a template engine
 * that does (this mirrors `hono/html`'s explicit-escape contract).
 */
export function html(ctx: Ctx, body: string, init?: ResponseInit): Response {
  const headers = defaultedHeaders(init, 'text/html; charset=utf-8');
  headers.set('content-length', String(utf8Length(body)));
  ctx.res = newResponse(ctx, body, {
    status: init?.status,
    statusText: init?.statusText,
    headers,
  });
  return ctx.res;
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

export function redirect(ctx: Ctx, location: string, status = 302): Response {
  ctx.res = newResponse(ctx, null, { status, headers: { location } });
  return ctx.res;
}
