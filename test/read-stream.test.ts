import type { HttpError } from '../src/errors';

import { describe, it } from 'vitest';

import { createApp, handle, post } from '../src/app';
import { readJson, readStream } from '../src/body';

// vitest's should chain has no chai-as-promised plugins (no `rejectedWith`),
// so capture rejections manually and assert on the tagged value.
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined; // resolved — property assertions below will fail
}

/** A source that yields one chunk per pull — chunk boundaries are exact and
 * it is never closed ahead of the consumer, so a mid-flight cancel always
 * reaches the `cancel` callback. */
function pacedSource(
  total: number,
  chunkSize: number,
  onCancel?: () => void
): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      const chunk = new Uint8Array(chunkSize).fill(sent & 0xff);
      sent += chunkSize;
      controller.enqueue(chunk);
    },
    cancel() {
      onCancel?.();
    },
  });
}

/** A source that emits fixed chunks eagerly. */
function chunkedSource(
  chunks: readonly Uint8Array[],
  onCancel?: () => void
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
    cancel() {
      onCancel?.();
    },
  });
}

/** A source that emits one chunk, then stalls forever — the mid-stream
 * abort case: the consumer's next read() can only end via the signal. */
function stallingSource(
  first: Uint8Array,
  onCancel: () => void
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first);
    },
    cancel() {
      onCancel();
    },
  });
}

function bodyRequest(source: ReadableStream<Uint8Array>): Request {
  return new Request('http://localhost/', {
    method: 'POST',
    body: source,
    // Node requires duplex for streaming bodies.
    duplex: 'half',
  } as RequestInit & { duplex?: 'half' });
}

describe('readStream', () => {
  it('round-trips a multi-chunk binary body byte-exactly', async () => {
    // Multi-byte UTF-8 deliberately split across chunk boundaries (7-byte
    // cuts) plus raw non-UTF-8 bytes: nothing may be re-encoded on the way
    // through.
    const payload = new TextEncoder().encode(
      'héllo wörld ☃ snowman — no re-encoding'
    );
    payload.set([0x00, 0xff, 0xfe, 0x80, 0xc3, 0x28], payload.length - 6);
    const cuts: Uint8Array[] = [];
    for (let offset = 0; offset < payload.length; offset += 7) {
      cuts.push(payload.slice(offset, offset + 7));
    }

    const app = createApp();
    post(app, '/', (ctx) => new Response(readStream(ctx)));

    const res = await handle(app, bodyRequest(chunkedSource(cuts)));
    res.status.should.equal(200);
    new Uint8Array(await res.arrayBuffer()).should.deep.equal(payload);
  });

  it('errors with 413 mid-stream, cancels the source and delivers at most limit + one chunk', async () => {
    let cancelled = false;

    const app = createApp();
    post(app, '/', async (ctx) => {
      const reader = readStream(ctx, { limit: 150 }).getReader();
      let delivered = 0;
      for (;;) {
        try {
          const result = await reader.read();
          if (result.done) break;
          delivered += result.value.byteLength;
        } catch (error) {
          const err = error as HttpError;
          // Let reader.cancel() reach the source's cancel callback.
          await new Promise((resolve) => setTimeout(resolve, 10));
          return Response.json({
            tag: err._tag,
            status: err.status,
            message: err.message,
            delivered,
          });
        }
      }
      return Response.json({ status: 0, delivered });
    });

    const res = await handle(
      app,
      bodyRequest(pacedSource(5 * 64, 64, () => (cancelled = true)))
    );
    const report = (await res.json()) as {
      tag: string;
      status: number;
      message: string;
      delivered: number;
    };
    report.tag.should.equal('HttpError');
    report.status.should.equal(413);
    report.message.should.equal('Payload too large');
    // Two 64-byte chunks fit under 150; the third crosses the budget and is
    // withheld — never more than limit + one chunk delivered.
    report.delivered.should.be.at.most(150 + 64);
    cancelled.should.equal(true);
  });
});

describe('readStream cooperative cancellation', () => {
  it('rejects the first read with the AbortError on a pre-aborted signal', async () => {
    const app = createApp();
    post(app, '/', async (ctx) => {
      const reader = readStream(ctx).getReader();
      try {
        await reader.read();
        return Response.json({ name: 'none' });
      } catch (error) {
        const err = error as DOMException;
        return Response.json({ name: err.name, message: err.message });
      }
    });

    const controller = new AbortController();
    controller.abort();
    const res = await handle(
      app,
      new Request('http://localhost/', { method: 'POST', body: 'never read' }),
      { signal: controller.signal }
    );
    const report = (await res.json()) as { name: string; message: string };
    report.name.should.equal('AbortError');
    report.message.should.equal('Aborted');
  });

  it('rejects with the AbortError and cancels the source on mid-stream abort', async () => {
    let cancelled = false;
    let releaseFirst: () => void = () => undefined;
    const firstSeen = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const app = createApp();
    post(app, '/', async (ctx) => {
      const reader = readStream(ctx).getReader();
      const first = await reader.read();
      first.done.should.equal(false);
      releaseFirst();
      try {
        await reader.read(); // stalls against the stalling source
        return Response.json({ name: 'none' });
      } catch (error) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return Response.json({
          name: (error as DOMException).name,
          cancelled,
        });
      }
    });

    const controller = new AbortController();
    const pending = handle(
      app,
      bodyRequest(
        stallingSource(new Uint8Array(64).fill(1), () => (cancelled = true))
      ),
      { signal: controller.signal }
    );
    await firstSeen;
    controller.abort();
    const res = await pending;
    const report = (await res.json()) as { name: string; cancelled: boolean };
    report.name.should.equal('AbortError');
    cancelled.should.equal(true);
  });
});

describe('readStream is terminal for the body', () => {
  it('rejects readJson after readStream with a 409 HttpError', async () => {
    const app = createApp();
    post(app, '/', async (ctx) => {
      readStream(ctx); // terminal the moment it is called
      const err = (await rejectionOf(readJson(ctx))) as HttpError;
      return Response.json({ status: err.status, message: err.message });
    });

    const res = await handle(
      app,
      new Request('http://localhost/', {
        method: 'POST',
        body: '{"a":1}',
        headers: { 'content-type': 'application/json' },
      })
    );
    const report = (await res.json()) as { status: number; message: string };
    report.status.should.equal(409);
    report.message.should.equal('Body already streamed');
  });

  it('rejects a second readStream through the stream itself with a 409', async () => {
    const app = createApp();
    post(app, '/', async (ctx) => {
      void readStream(ctx).getReader();
      const reader = readStream(ctx).getReader();
      try {
        await reader.read();
        return Response.json({ status: 0 });
      } catch (error) {
        const err = error as HttpError;
        return Response.json({ status: err.status, message: err.message });
      }
    });

    const res = await handle(app, bodyRequest(pacedSource(64, 64)));
    const report = (await res.json()) as { status: number; message: string };
    report.status.should.equal(409);
    report.message.should.equal('Body already streamed');
  });

  it('replays cached bytes as one byte-exact chunk after readJson', async () => {
    const payload = new TextEncoder().encode('{"chunky":true,"n":42}');

    const app = createApp();
    post(app, '/', async (ctx) => {
      (await readJson<{ chunky: boolean; n: number }>(ctx)).should.deep.equal({
        chunky: true,
        n: 42,
      });
      const reader = readStream(ctx).getReader();
      const parts: Uint8Array[] = [];
      let chunks = 0;
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        chunks += 1;
        parts.push(result.value);
      }
      // True iff the replay stream closed cleanly after the cached chunk.
      const closed = await reader.closed.then(
        () => true,
        () => false
      );
      let size = 0;
      for (const part of parts) size += part.byteLength;
      const joined = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) {
        joined.set(part, offset);
        offset += part.byteLength;
      }
      return Response.json({
        chunks,
        closed,
        bytes: Array.from(joined),
      });
    });

    const res = await handle(
      app,
      new Request('http://localhost/', {
        method: 'POST',
        body: payload,
        headers: { 'content-type': 'application/json' },
      })
    );
    const report = (await res.json()) as {
      chunks: number;
      closed: boolean;
      bytes: number[];
    };
    report.chunks.should.equal(1);
    report.closed.should.equal(true);
    report.bytes.should.deep.equal(Array.from(payload));
  });
});

describe('readStream defaults', () => {
  it('streams an unlimited body with no options', async () => {
    // 200 KB of deterministic bytes — far past any plausible implicit
    // default, proving no options means no limit.
    const payload = new Uint8Array(200_000);
    for (let i = 0; i < payload.length; i++) {
      payload[i] = (i * 7 + 13) & 0xff;
    }
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < payload.length; offset += 8192) {
      chunks.push(payload.slice(offset, offset + 8192));
    }

    const app = createApp();
    post(app, '/', (ctx) => new Response(readStream(ctx)));

    const res = await handle(app, bodyRequest(chunkedSource(chunks)));
    new Uint8Array(await res.arrayBuffer()).should.deep.equal(payload);
  });
});
