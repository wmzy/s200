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

const bodyCache = new WeakMap<Ctx, BodyCache>();

function cacheFor(ctx: Ctx): BodyCache {
  const cached = bodyCache.get(ctx);
  if (cached !== undefined) return cached;
  const fresh: BodyCache = { raw: ctx.req.arrayBuffer() };
  bodyCache.set(ctx, fresh);
  return fresh;
}

export async function readText(ctx: Ctx): Promise<string> {
  const cache = cacheFor(ctx);
  if (cache.text === undefined) {
    cache.text = new TextDecoder().decode(await cache.raw);
  }
  return cache.text;
}

export async function readJson<T = unknown>(ctx: Ctx): Promise<T> {
  const body = await readText(ctx);
  try {
    return JSON.parse(body) as T;
  } catch {
    throw httpError(400, 'Invalid JSON body');
  }
}

export async function readForm(ctx: Ctx): Promise<FormData> {
  const cache = cacheFor(ctx);
  if (cache.form === undefined) {
    const bytes = await cache.raw;
    // The original stream may already be consumed by readText/readJson;
    // replay the cached bytes through a fresh Request so the platform's
    // urlencoded/multipart parser runs with the original content-type.
    const init: RequestInit = { method: 'POST', body: bytes };
    const contentType = ctx.req.headers.get('content-type');
    if (contentType !== null) init.headers = { 'content-type': contentType };
    cache.form = await new Request(ctx.req.url, init).formData();
  }
  return cache.form;
}
