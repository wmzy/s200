import type { Ctx } from './types';

/** Byte length of a UTF-8 string: the ASCII fast path skips the encoder
 * allocation — JSON/HTML responses are overwhelmingly ASCII. */
function utf8Length(value: string): number {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 0x7f) {
      return new TextEncoder().encode(value).byteLength;
    }
  }
  return value.length;
}

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
  ctx.res = new Response(body as BodyInit, {
    status: init?.status,
    statusText: init?.statusText,
    headers,
  });
  return ctx.res;
}

export function json(ctx: Ctx, data: unknown, init?: ResponseInit): Response {
  const body = JSON.stringify(data);
  const headers = new Headers(init?.headers);
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  headers.set('content-length', String(utf8Length(body)));
  ctx.res = new Response(body, {
    status: init?.status,
    statusText: init?.statusText,
    headers,
  });
  return ctx.res;
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
  ctx.res = new Response(body, {
    status: init?.status,
    statusText: init?.statusText,
    headers,
  });
  return ctx.res;
}

export function html(ctx: Ctx, body: string, init?: ResponseInit): Response {
  const headers = defaultedHeaders(init, 'text/html; charset=utf-8');
  headers.set('content-length', String(utf8Length(body)));
  ctx.res = new Response(body, {
    status: init?.status,
    statusText: init?.statusText,
    headers,
  });
  return ctx.res;
}

export function redirect(ctx: Ctx, location: string, status = 302): Response {
  ctx.res = new Response(null, { status, headers: { location } });
  return ctx.res;
}
