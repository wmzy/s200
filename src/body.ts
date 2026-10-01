import type { Ctx } from './types';

import { httpError } from './errors';
import { neverSignal } from './signal';

/**
 * Request bodies are single-read. All parse results are cached per ctx so
 * the same body can be read again (double `readJson`, or a handler that
 * read the JSON and an error reporter that wants the text) without hitting
 * "body already consumed" TypeErrors.
 *
 * The cache keeps raw bytes, not text: a multipart form with binary parts
 * must survive every read path byte-exactly.
 *
 * `readStream` is the exception: it never buffers, so it parks a
 * {@link StreamedMarker} in the cache and every later buffered read
 * rejects with a 409 instead of replaying nothing.
 */
type StreamedMarker = { readonly streamed: true };

type BufferedCache = {
  raw: Promise<ArrayBuffer>;
  text?: string;
  form?: FormData;
};

type BodyCache = StreamedMarker | BufferedCache;

export type BodyOptions = {
  /**
   * Maximum body size in bytes. The first read counts bytes as they arrive
   * and rejects oversize bodies with a 413 `HttpError` before buffering
   * them whole; a later limited read of an already-buffered body enforces
   * the same limit after the fact. Default: unlimited.
   *
   * `readStream` enforces the same budget without buffering: the stream
   * counts bytes as they flow through, errors with a 413 `HttpError` the
   * moment the budget is crossed and cancels the platform body so the
   * upload stops being received.
   */
  limit?: number;
};

const bodyCache = new WeakMap<Ctx, BodyCache>();

/** The cooperative-cancellation rejection every aborted body read settles
 * with — same shape `signal.throwIfAborted()` produces for a reason-less
 * abort, kept hand-rolled for the zero-dep style. */
function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

/** Entry check for every read path: an already-aborted `ctx.signal` means
 * the request is dead — refuse before touching the stream. `undefined` and
 * the shared {@link neverSignal} (contexts without cooperative
 * cancellation) pass through untouched. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal !== undefined && signal.aborted) {
    throw abortError();
  }
}

/**
 * One `reader.read()` raced against `ctx.signal`. On abort the source is
 * cancelled — via the reader, because the body stream is locked to it and
 * `req.body.cancel()` would throw on the lock — so upstream producers
 * observe the drop, and the rejection (an `AbortError`) wakes this reader
 * plus every waiter on the cached raw-bytes promise. When the signal can
 * never abort (`undefined` or the shared `neverSignal()`), the read is passed
 * through with zero listener wiring — the default path pays nothing.
 */
function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal === undefined || signal === neverSignal()) {
    return reader.read();
  }
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      void reader.cancel().catch(() => undefined);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

/**
 * Reads the request body with a byte budget: counts as the stream arrives
 * and throws the moment the limit is crossed, so an oversized body never
 * sits in memory. The reader is abandoned (not cancelled) at that point —
 * the platform decides whether the connection drains or closes, and the
 * 413 is still delivered. `limit === undefined` is the unlimited
 * cooperative path: same loop, no budget, raced against `signal` so an
 * aborted request stops buffering.
 */
async function readLimited(
  req: Request,
  limit: number | undefined,
  signal: AbortSignal | undefined
): Promise<ArrayBuffer> {
  const reader = req.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await readChunk(reader, signal);
    if (done) break;
    size += value.byteLength;
    if (limit !== undefined && size > limit) {
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

function cacheFor(ctx: Ctx, limit: number | undefined): BufferedCache {
  throwIfAborted(ctx.signal);
  const cached = bodyCache.get(ctx);
  if (cached !== undefined) {
    if ('streamed' in cached) {
      // `readStream` consumed the body without buffering — there are no
      // cached bytes to serve, and pretending otherwise would replay an
      // empty body as if it were the real one.
      throw httpError(409, 'Body already streamed');
    }
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
  // The shared cached promise is what makes an aborted mid-read reject for
  // every waiter: a later read of the same ctx awaits the same (rejected)
  // raw promise instead of hanging or replaying stale bytes.
  const cooperative = ctx.signal !== undefined && ctx.signal !== neverSignal();
  const raw =
    !cooperative && limit === undefined
      ? ctx.req.arrayBuffer()
      : ctx.req.body === null
        ? Promise.resolve(new ArrayBuffer(0))
        : readLimited(ctx.req, limit, ctx.signal);
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

/** A stream born errored — the cheap terminal for dead-on-arrival reads
 * (aborted signal, already-streamed body): one wrapper, no reader, no
 * source touched. */
function erroredStream(error: unknown): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(error);
    },
  });
}

/** Replay of already-buffered bytes as a single chunk — the mixed-order
 * path where a buffered read (`readJson` & co) ran first. The cached
 * promise settles the stream whether it holds bytes, a post-hoc 413 or a
 * prior rejection, so concurrent waiters and late streamers agree. */
function replayStream(
  cache: BufferedCache,
  limit: number | undefined
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      cache.raw.then(
        (buffer) => {
          if (limit !== undefined && buffer.byteLength > limit) {
            controller.error(httpError(413, 'Payload too large'));
            return;
          }
          // A view over the cached buffer — byte-exact, no copy. Empty
          // bodies close without enqueuing a zero-length chunk.
          if (buffer.byteLength > 0) {
            controller.enqueue(new Uint8Array(buffer));
          }
          controller.close();
        },
        (error) => {
          controller.error(error);
        }
      );
    },
  });
}

/**
 * The live streaming wrapper: pulls the platform body chunk by chunk,
 * enqueues each one through and never holds more than the chunk in
 * flight. `pull` runs only while the consumer asks (default queue, HWM 1)
 * so backpressure rides straight through to the upload.
 *
 * Three exits, all settling the wrapper exactly once (`settled` guards the
 * late callbacks — `enqueue`/`close` on a settled stream would throw):
 * source done → close; over budget / aborted / source failed → `error` the
 * consumer plus `reader.cancel()` the source so upstream stops sending;
 * consumer cancelled → cancel rides through to the source unchanged.
 */
function streamSource(
  source: ReadableStream<Uint8Array>,
  limit: number | undefined,
  signal: AbortSignal | undefined
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const cooperative = signal !== undefined && signal !== neverSignal();
  let size = 0;
  let settled = false;
  let onAbort: (() => void) | undefined;
  const detach = (): void => {
    if (onAbort !== undefined) {
      signal!.removeEventListener('abort', onAbort);
      onAbort = undefined;
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (!cooperative) return;
      // One listener for the stream's whole life — not one per chunk. It
      // owns the abort race: pending or not, the consumer's read rejects
      // with the AbortError and the source is cancelled.
      onAbort = () => {
        if (settled) return;
        settled = true;
        onAbort = undefined;
        controller.error(abortError());
        void reader.cancel().catch(() => undefined);
      };
      signal!.addEventListener('abort', onAbort, { once: true });
    },
    pull(controller) {
      reader.read().then(
        (result) => {
          if (settled) return;
          if (result.done) {
            settled = true;
            detach();
            controller.close();
            return;
          }
          size += result.value.byteLength;
          if (limit !== undefined && size > limit) {
            settled = true;
            detach();
            // The budget is crossed: the consumer sees the 413, the
            // platform body is cancelled so the rest of the upload is
            // never received. Chunks already delivered stay delivered —
            // the consumer must discard them on error.
            controller.error(httpError(413, 'Payload too large'));
            void reader.cancel().catch(() => undefined);
            return;
          }
          controller.enqueue(result.value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          detach();
          controller.error(error);
        }
      );
    },
    cancel(reason) {
      settled = true;
      detach();
      return reader.cancel(reason);
    },
  });
}

/**
 * Streams the request body without ever buffering it whole: the returned
 * stream forwards the platform body chunk by chunk, so an upload can be
 * piped straight through (`new Response(readStream(ctx))`, `pipeThrough`)
 * at any size.
 *
 * Terminal for the body, exactly once: the ctx body cache is marked
 * consumed, so a later `readText`/`readJson`/`readForm` — or a second
 * `readStream` — rejects with a 409 `HttpError` ('Body already streamed')
 * surfacing through the returned stream's reads. The mixed order works the
 * other way: if a buffered read already cached the raw bytes, the cached
 * bytes are replayed as one byte-exact chunk (still without touching the
 * consumed platform stream).
 *
 * `options.limit` counts bytes as they flow through — never buffered. The
 * moment the budget is crossed the stream errors with a 413 `HttpError`
 * and the platform body is cancelled so the upload stops being received.
 * Chunks already delivered to the consumer stay delivered: on error the
 * consumer must discard what it received.
 *
 * `ctx.signal` is honored end to end: an already-aborted signal yields a
 * stream whose first `read()` rejects with the `AbortError`; aborting
 * mid-stream errors the stream the same way and cancels the source.
 *
 * Hot-path honest: no allocation beyond the wrapper itself (plus one abort
 * listener when the signal is cooperative) and the platform's own
 * per-`read()` promises.
 */
export function readStream(
  ctx: Ctx,
  options: BodyOptions = {}
): ReadableStream<Uint8Array> {
  const { limit } = options;
  const signal = ctx.signal;
  // A dead request never touches the source: the stream is born errored,
  // the platform body is cancelled and the cache is parked as streamed.
  if (signal !== undefined && signal !== neverSignal() && signal.aborted) {
    bodyCache.set(ctx, { streamed: true });
    ctx.req.body?.cancel().catch(() => undefined);
    return erroredStream(abortError());
  }

  const cached = bodyCache.get(ctx);
  if (cached !== undefined) {
    if ('streamed' in cached) {
      return erroredStream(httpError(409, 'Body already streamed'));
    }
    return replayStream(cached, limit);
  }

  // Live path: mark terminal before the first chunk moves so even a
  // same-tick buffered read sees the 409.
  bodyCache.set(ctx, { streamed: true });
  const source = ctx.req.body;
  if (source === null) {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
  }
  return streamSource(source, limit, signal);
}
