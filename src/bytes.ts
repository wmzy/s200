/**
 * Shared byte-buffer helpers — the concat/collect loop every battery
 * needs. A plain internal module (crypto-util.ts precedent): imported
 * via relative paths, never re-exported from the barrel.
 *
 * @module
 */

/**
 * Copies chunks into one fresh buffer of `length` bytes; `length`
 * defaults to the chunks' total, so the explicit form exists only for
 * callers (body, multipart) that already tracked the size while
 * streaming and would otherwise re-walk the array.
 *
 * @internal
 */
export function concatBytes(
  chunks: readonly Uint8Array[],
  length?: number
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(
    length ?? chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  );
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Collects a stream into one buffer.
 *
 * `copySingle: false` (the default) returns a lone chunk without copying
 * — compress's fast path, where the common small response skips one
 * allocation; the caller must not mutate the result, since it aliases
 * the stream's own chunk. `copySingle: true` always copies — light's
 * rule that a materialized body must never alias its source chunks, so
 * later mutation of the result cannot corrupt anything the class still
 * holds.
 *
 * @internal
 */
export async function collectStream(
  stream: ReadableStream<Uint8Array>,
  options?: { readonly copySingle?: boolean }
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const single =
    options?.copySingle !== true && chunks.length === 1
      ? chunks[0]
      : undefined;
  if (single !== undefined) return single;
  return concatBytes(chunks);
}
