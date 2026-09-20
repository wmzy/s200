/**
 * Streaming response helpers: `stream` for chunked plain output and
 * `streamSSE` for Server-Sent Events. Both build on a `ReadableStream`
 * pushed by a pump function — zero dependencies, every Web Standard runtime
 * serves the resulting `Response` natively.
 *
 * Call inside a handler or middleware: the helper writes `ctx.res` in place
 * and returns it, like `json`/`text` do. The pump runs detached from the
 * middleware chain — return without awaiting anything; `handle` already
 * holds the Response.
 *
 * @module
 */

import type { Ctx } from './types';

/** Chunk writer handed to a `stream` pump. */
export type StreamWriter = {
  /**
   * Writes one chunk. Resolves when the chunk is buffered; when the
   * consumer lags (backpressure), it waits — await it inside the pump.
   */
  write(chunk: string | Uint8Array): Promise<void>;
  /** Ends the stream normally; the pump finishing without close() does too. */
  close(): void;
  /** Aborts with an error, failing the response stream. */
  abort(error?: unknown): void;
};

/** SSE writer: {@link StreamWriter} plus event framing. */
export type SseWriter = StreamWriter & {
  /** Writes one SSE event: `{ id?, event?, data, retry? }`. */
  writeSSE(event: SseEvent): Promise<void>;
  /** Keep-alive comment line (`: msg\n\n`) — clients ignore comments. */
  heartbeat(message?: string): Promise<void>;
};

export type SseEvent = {
  readonly id?: string;
  readonly event?: string;
  readonly data: string | unknown;
  readonly retry?: number;
};

const encoder = new TextEncoder();

/**
 * Builds a push-driven ReadableStream and runs the pump against it. The
 * pump's completion closes the stream; its failure aborts it. `write`
 * cooperates with backpressure: when the queue is full it parks until the
 * consumer pulls.
 */
function runPump<T>(
  enhance: (base: StreamWriter) => T,
  pump: (writer: T) => Promise<void> | void
): ReadableStream<Uint8Array> {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let drained: (() => void) | undefined;
  let settled = false;
  const finish = (): void => {
    if (settled) return;
    settled = true;
    drained?.();
    drained = undefined;
    try {
      controller.close();
    } catch {
      // already closed/errored — nothing left to do
    }
  };
  const fail = (error: unknown): void => {
    if (settled) return;
    settled = true;
    drained?.();
    drained = undefined;
    try {
      controller.error(error);
    } catch {
      // already errored — nothing left to do
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    pull() {
      // The queue drained enough — release a parked writer.
      drained?.();
      drained = undefined;
    },
    cancel() {
      settled = true;
      drained?.();
      drained = undefined;
    },
  });
  const write = (chunk: string | Uint8Array): Promise<void> => {
    if (settled) return Promise.resolve();
    const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
    controller.enqueue(bytes);
    if (controller.desiredSize !== null && controller.desiredSize <= 0) {
      return new Promise<void>((resolve) => {
        drained = resolve;
      });
    }
    return Promise.resolve();
  };
  const base: StreamWriter = {
    write,
    close: finish,
    abort: fail,
  };
  const writer = enhance(base);
  void Promise.resolve()
    .then(() => pump(writer))
    .then(finish, fail);
  return stream;
}

/** Frames one SSE event per the event-stream format. */
function formatSse(event: SseEvent): string {
  let out = '';
  if (event.id !== undefined) out += `id: ${event.id}\n`;
  if (event.event !== undefined) out += `event: ${event.event}\n`;
  const data =
    typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
  for (const line of data.split('\n')) out += `data: ${line}\n`;
  if (event.retry !== undefined) out += `retry: ${event.retry}\n`;
  return `${out}\n`;
}

/**
 * Starts a chunked streaming response (`application/octet-stream` by
 * default — override via `init`). The pump receives a writer; await its
 * `write` calls so backpressure reaches the source.
 */
export function stream(
  ctx: Ctx,
  pump: (writer: StreamWriter) => Promise<void> | void,
  init?: ResponseInit
): Response {
  const body = runPump<StreamWriter>((base) => base, pump);
  ctx.res = new Response(body, {
    ...init,
    headers: {
      'content-type': 'application/octet-stream',
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  return ctx.res;
}

/**
 * Starts an SSE response (`text/event-stream`, `cache-control: no-cache`).
 * Events write through `writeSSE`; `heartbeat` emits keep-alive comments.
 * A client disconnect cancels the stream — subsequent writes resolve
 * silently and the pump should stop.
 */
export function streamSSE(
  ctx: Ctx,
  pump: (writer: SseWriter) => Promise<void> | void,
  init?: ResponseInit
): Response {
  const body = runPump<SseWriter>((base) => ({
    ...base,
    writeSSE: (event) => base.write(formatSse(event)),
    heartbeat: (message = 'heartbeat') =>
      base.write(`: ${message}\n\n`),
  }), pump);
  ctx.res = new Response(body, {
    ...init,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  return ctx.res;
}
