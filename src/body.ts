import type { Ctx } from './types';

import { httpError } from './errors';

/**
 * Request bodies are single-read. All parse results are cached per ctx so
 * the same body can be read again (double `readJson`, or a handler that
 * read the JSON and an error reporter that wants the text) without hitting
 * "body already consumed" TypeErrors.
 *
 * The cache keeps raw bytes, not text: a multipart form with binary parts
 * must survive every read path byte-exactly.
 */
type BodyCache = {
  raw: Promise<ArrayBuffer>;
  text?: string;
  form?: FormData;
};

export type BodyOptions = {
  /**
   * Maximum body size in bytes. The first read counts bytes as they arrive
   * and rejects oversize bodies with a 413 `HttpError` before buffering
   * them whole; a later limited read of an already-buffered body enforces
   * the same limit after the fact. Default: unlimited.
   */
  limit?: number;
};

const bodyCache = new WeakMap<Ctx, BodyCache>();

/**
 * Reads the request body with a byte budget: counts as the stream arrives
 * and throws the moment the limit is crossed, so an oversized body never
 * sits in memory. The reader is abandoned (not cancelled) at that point —
 * the platform decides whether the connection drains or closes, and the
 * 413 is still delivered.
 */
async function readLimited(req: Request, limit: number): Promise<ArrayBuffer> {
  const reader = req.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      throw httpError(413, 'Request body too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

function cacheFor(ctx: Ctx, limit: number | undefined): BodyCache {
  const cached = bodyCache.get(ctx);
  if (cached !== undefined) {
    if (limit !== undefined) {
      // The bytes were already buffered by an earlier unlimited read — a
      // later limited read can only enforce after the fact.
      cached.raw = cached.raw.then((buffer) => {
        if (buffer.byteLength > limit) {
          throw httpError(413, 'Request body too large');
        }
        return buffer;
      });
    }
    return cached;
  }
  const raw =
    limit === undefined
      ? ctx.req.arrayBuffer()
      : ctx.req.body === null
        ? Promise.resolve(new ArrayBuffer(0))
        : readLimited(ctx.req, limit);
  const fresh: BodyCache = { raw };
  bodyCache.set(ctx, fresh);
  return fresh;
}

export async function readText(
  ctx: Ctx,
  options: BodyOptions = {}
): Promise<string> {
  const cache = cacheFor(ctx, options.limit);
  // Await even when text is cached: a later limited read wraps `raw` with
  // the post-hoc size check, and that rejection must surface here.
  await cache.raw;
  if (cache.text === undefined) {
    cache.text = new TextDecoder().decode(await cache.raw);
  }
  return cache.text;
}

export async function readJson<T = unknown>(
  ctx: Ctx,
  options: BodyOptions = {}
): Promise<T> {
  const body = await readText(ctx, options);
  try {
    return JSON.parse(body) as T;
  } catch {
    throw httpError(400, 'Invalid JSON body');
  }
}

export async function readForm(
  ctx: Ctx,
  options: BodyOptions = {}
): Promise<FormData> {
  const cache = cacheFor(ctx, options.limit);
  if (cache.form === undefined) {
    const bytes = await cache.raw;
    // The original stream may already be consumed by readText/readJson;
    // replay the cached bytes through a fresh Request so the platform's
    // urlencoded/multipart parser runs with the original content-type.
    const init: RequestInit = { method: 'POST', body: bytes };
    const contentType = ctx.req.headers.get('content-type');
    if (contentType !== null) init.headers = { 'content-type': contentType };
    // The replay URL is never observed by urlencoded/multipart parsing — a
    // constant valid absolute URL keeps this free of ctx.url.
    cache.form = await new Request('http://s200.invalid/', init).formData();
  }
  return cache.form;
}
