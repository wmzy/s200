import type { Ctx } from './types';

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
): void {
  ctx.res = new Response(body as BodyInit, init);
}

export function json(ctx: Ctx, data: unknown, init?: ResponseInit): void {
  ctx.res = Response.json(data, init);
}

/**
 * Merges a default content-type into an init unless the caller provided one —
 * explicit headers win over defaults.
 */
function withContentType(init: ResponseInit | undefined, fallback: string): ResponseInit {
  if (init === undefined) {
    return { headers: { 'content-type': fallback } };
  }
  if (init.headers === undefined) {
    return { ...init, headers: { 'content-type': fallback } };
  }
  const headers = new Headers(init.headers);
  if (!headers.has('content-type')) {
    headers.set('content-type', fallback);
  }
  return { ...init, headers };
}

export function text(ctx: Ctx, body: string, init?: ResponseInit): void {
  ctx.res = new Response(body, withContentType(init, 'text/plain; charset=utf-8'));
}

export function html(ctx: Ctx, body: string, init?: ResponseInit): void {
  ctx.res = new Response(body, withContentType(init, 'text/html; charset=utf-8'));
}

export function redirect(ctx: Ctx, location: string, status = 302): void {
  ctx.res = new Response(null, { status, headers: { location } });
}
