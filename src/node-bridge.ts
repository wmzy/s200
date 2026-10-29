/**
 * Internal node-http→Web write-back bridge shared by the node adapter
 * (`s200/node`'s writeResponse) and the shard executor's child bridge
 * (executor-child.ts) so no second copy grows: one Response→node-res
 * writer built on the direct reader loop — getReader() + `once(res,
 * 'drain')` backpressure + disconnect-driven cancel — NOT
 * `Readable.fromWeb`, whose stream-to-node-stream conversion costs a
 * real per-request allocation and two event loops. The light fast path
 * (LightResponse.bytesSync + LightHeaders.fillRecord) stays in
 * `s200/node`: the child realm loads library code by URL under type
 * stripping and carries none of the light machinery — it calls this
 * writer with the default Headers mapping instead. NOT a public entry —
 * the barrel does not re-export this module; import it relatively from
 * within src.
 *
 * @internal
 */

import { once } from 'node:events';

import { headerRecordOf } from './raw-headers';

/** The response surface the writer needs — node:http's ServerResponse and
 * node:http2's compat response both satisfy it (the HTTP/1-style
 * writeHead/write/end/drain API). */
export type NodeResWriter = {
  writeHead(
    statusCode: number,
    statusMessage: string | undefined,
    headers: Record<string, string | string[]>
  ): unknown;
  write(chunk: Uint8Array): boolean;
  end(): unknown;
  on(event: 'drain', listener: () => void): unknown;
};

/**
 * Writes a web `Response` to a node res: `writeHead` with the header
 * record — assembled here through the shared `raw-headers` mapping
 * (repeated set-cookie stays an array; forEach would collapse it into one
 * comma-joined value, which is not a legal cookie list) when the caller
 * passes none pre-filled; `s200/node` fills its own first through the
 * light slot path — then the body through the direct reader loop. A null
 * body (204/304, a HEAD rebuild, an empty response) completes on the
 * header write alone.
 *
 * `signal` is the caller's per-request disconnect signal (the node
 * adapter's `abortOnDisconnect`); without one (the shard executor's
 * bridge) the loop rides plain backpressure.
 */
export async function writeWebResponseToNode(
  res: NodeResWriter,
  response: Response,
  signal: AbortSignal | undefined,
  headers: Record<string, string | string[]> = headerRecordOf(response.headers)
): Promise<void> {
  // Null body on either path (light or plain): the header write alone
  // completes the response.
  if (response.body === null) {
    res.writeHead(response.status, response.statusText, headers);
    res.end();
    return;
  }
  // Direct reader loop instead of Readable.fromWeb + pipeline: the
  // stream-to-node-stream conversion costs a real per-request allocation
  // and two event loops — at keep-alive throughput it is measurable
  // (hono's node adapter does the same reader loop). Backpressure is
  // honored through the drain event; a socket death mid-write rejects
  // and the caller destroys the response.
  const reader = response.body.getReader();
  // Disconnect propagation (signal = abortOnDisconnect's per-request
  // signal): cancel the reader when the client vanishes — a pending read
  // then resolves {done: true} and the source's cancel runs, so a
  // handler-side generator receives its finally and a stalled body cannot
  // outlive the socket. The drain waits below take the same signal: an
  // abort rejects them instead of hanging on a dead socket.
  const cancelOnAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  if (signal !== undefined) {
    signal.addEventListener('abort', cancelOnAbort, { once: true });
  }
  res.writeHead(response.status, response.statusText, headers);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      // done also follows an abort-driven cancel — res.end() on a closed
      // socket is a tolerated no-op (OutgoingMessage drops writes after
      // destroy), and dispatch's 'close' trigger already finished as
      // aborted.
      res.end();
      signal?.removeEventListener('abort', cancelOnAbort);
      return;
    }
    if (!res.write(value)) {
      await once(
        res as unknown as import('node:events').EventEmitter,
        'drain',
        signal === undefined ? undefined : { signal }
      );
    }
  }
}
