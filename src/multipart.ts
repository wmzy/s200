/**
 * Incremental multipart/form-data parsing: `streamForm` walks the request
 * body chunk by chunk over {@link readStream} — the whole body is NEVER
 * buffered, and each part is handed to `onPart` the moment its closing
 * boundary is seen.
 *
 * Memory is bounded per part, not per body: one part's bytes accumulate
 * until its delimiter arrives (a part IS the unit of buffering — stream a
 * huge form as many small parts, never as one huge part), plus a scan
 * window of `max(boundary length + 8, 64)` bytes held across chunk edges
 * so a delimiter can match when it straddles two chunks. Each part's
 * header block is capped at 16 KiB and the transport padding after a
 * boundary at 256 bytes; a body crossing either is rejected as malformed.
 *
 * Budget and cancellation ride through from `readStream`: `options.limit`
 * rejects an oversized upload with a 413 `HttpError` while the platform
 * body is cancelled mid-receive, an aborted `ctx.signal` surfaces as an
 * `AbortError`, and an already-consumed body rejects with the same 409.
 * `streamForm` is terminal for the body — a later `readJson`/`readText`/
 * `readForm` (or a second stream) rejects with the 409. The other order
 * works: if a buffered read already cached the bytes, they are replayed
 * through the same scanner.
 *
 * @module
 */

import type { Ctx } from './types';

import { readStream } from './body';
import { httpError } from './errors';

/** One parsed form field: name plus (for file parts) client metadata and
 * the part's raw bytes — binary-safe, byte-exact. */
export type FormPart = {
  /** Field name from Content-Disposition's `name` parameter. */
  readonly name: string;
  /** Only for file parts: the client-side filename, unquoted. */
  readonly filename?: string;
  /** Only when the part carries its own Content-Type header. */
  readonly contentType?: string;
  /** The part's body bytes. */
  readonly data: Uint8Array;
};

const CR = 0x0d;
const LF = 0x0a;
const DASH = 0x2d;
const SPACE = 0x20;
const TAB = 0x09;

/** A part's header block is the one place the parser buffers text before
 * validating it — cap it so an adversarial stream cannot grow it forever. */
const HEADER_BLOCK_MAX = 16_384;
/** RFC 2046 allows arbitrary LWSP "transport padding" after a boundary;
 * real senders emit none. Past this many bytes the match is treated as
 * body data instead of waiting out an endless pad run. */
const TRANSPORT_PAD_MAX = 256;

const encoder = new TextEncoder();

function appendBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (b.length === 0) return a;
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** `haystack.indexOf(needle)` for bytes, scanning from `from` — first-byte
 * quick reject, then a compare loop. Needles are ASCII line/boundary
 * fragments a few bytes long, so this stays cheaper than any cleverness. */
function indexOfBytes(
  haystack: Uint8Array,
  needle: Uint8Array,
  from: number
): number {
  const last = haystack.length - needle.length;
  const first = needle[0] ?? -1;
  for (let i = Math.max(0, from); i <= last; i += 1) {
    if (haystack[i] !== first) continue;
    let k = 1;
    while (k < needle.length && haystack[i + k] === needle[k]) k += 1;
    if (k === needle.length) return i;
  }
  return -1;
}

function concatParts(
  chunks: readonly Uint8Array[],
  length: number
): Uint8Array {
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Splits a parameter list on `;` while honoring quoted strings (a `;`
 * inside quotes is data, not a separator). Backslash escapes inside
 * quotes are carried through verbatim for {@link paramValue} to unfold. */
function splitParams(s: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i] ?? '';
    if (quoted) {
      if (c === '\\') {
        current += c + (s[i + 1] ?? '');
        i += 1;
      } else {
        if (c === '"') quoted = false;
        current += c;
      }
    } else if (c === '"') {
      quoted = true;
      current += c;
    } else if (c === ';') {
      out.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  out.push(current);
  return out;
}

/** Unfolds one parameter value: a quoted-string has its quotes dropped and
 * backslash escapes unfolded; a bare token is returned as-is (trimmed). */
function paramValue(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    const inner = t.slice(1, -1);
    let out = '';
    for (let i = 0; i < inner.length; i += 1) {
      const c = inner[i] ?? '';
      if (c === '\\' && i + 1 < inner.length) {
        out += inner[i + 1] ?? '';
        i += 1;
      } else {
        out += c;
      }
    }
    return out;
  }
  return t;
}

/** Parses `k=v; k="v"` parameters into a lowercase-keyed map. Parameter
 * names are case-insensitive; values keep their case. */
function parseParams(s: string): Map<string, string> {
  const params = new Map<string, string>();
  for (const piece of splitParams(s)) {
    const eq = piece.indexOf('=');
    if (eq <= 0) continue;
    const key = piece.slice(0, eq).trim().toLowerCase();
    if (key === '') continue;
    params.set(key, paramValue(piece.slice(eq + 1)));
  }
  return params;
}

/** Extracts the boundary from a `multipart/form-data` content-type.
 * Media type and parameter names compare case-insensitively; the boundary
 * value (quoted or bare) keeps its case. Anything else is a 415. */
function boundaryOf(header: string | null): string {
  if (header !== null) {
    const semi = header.indexOf(';');
    const media = (semi < 0 ? header : header.slice(0, semi)).trim().toLowerCase();
    if (media === 'multipart/form-data') {
      const boundary = parseParams(semi < 0 ? '' : header.slice(semi + 1)).get('boundary');
      if (boundary !== undefined && boundary !== '') return boundary;
    }
  }
  throw httpError(415, 'Unsupported Media Type');
}

/** What follows a `CRLF--boundary` match at `j`, per RFC 2046: `--` closes
 * the form, optional transport padding then CRLF opens the next part.
 * Anything else means the match was body data that merely resembles a
 * boundary — report it invalid and keep scanning. */
type Follow =
  | { readonly kind: 'need' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'part'; readonly next: number }
  | { readonly kind: 'final'; readonly next: number };

function delimiterFollow(bytes: Uint8Array, j: number): Follow {
  if (j >= bytes.length) return { kind: 'need' };
  if (bytes[j] === DASH) {
    if (j + 1 >= bytes.length) return { kind: 'need' };
    return bytes[j + 1] === DASH
      ? { kind: 'final', next: j + 2 }
      : { kind: 'invalid' };
  }
  let k = j;
  while (k < bytes.length && (bytes[k] === SPACE || bytes[k] === TAB)) k += 1;
  if (k >= bytes.length) {
    return k - j > TRANSPORT_PAD_MAX ? { kind: 'invalid' } : { kind: 'need' };
  }
  if (bytes[k] !== CR) return { kind: 'invalid' };
  if (k + 1 >= bytes.length) return { kind: 'need' };
  return bytes[k + 1] === LF ? { kind: 'part', next: k + 2 } : { kind: 'invalid' };
}

/** Reads a part's header block (already stripped of its terminating empty
 * line): CRLF-separated `Name: value` lines, names case-insensitive.
 * Content-Disposition yields `name`/`filename` (quoted-string with
 * backslash escapes — RFC 5987 percent-encoding is not attempted);
 * Content-Type is kept whole. A part without a `name` is malformed. */
function parsePartHeaders(block: string): {
  name: string;
  filename?: string;
  contentType?: string;
} {
  let name: string | undefined;
  let filename: string | undefined;
  let contentType: string | undefined;
  for (const line of block.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'content-disposition') {
      const params = parseParams(value);
      name = params.get('name');
      filename = params.get('filename');
    } else if (key === 'content-type') {
      contentType = value;
    }
  }
  if (name === undefined) throw httpError(400, 'Malformed multipart body');
  return {
    name,
    ...(filename !== undefined ? { filename } : {}),
    ...(contentType !== undefined ? { contentType } : {}),
  };
}

/**
 * The scanner: pulls chunks from `reader` and drives the three-stage state
 * machine (preamble → headers → body, per part) over a small carry buffer.
 *
 * The carry never exceeds the scan window (`max(boundary + 8, 64)` bytes)
 * plus the in-flight chunk — everything else is either discarded (preamble,
 * epilogue) or already flushed into the current part's accumulation. A
 * delimiter match is only accepted once its follow bytes (`--`, or padding
 * + CRLF) are seen, so binary data containing the boundary string followed
 * by junk survives byte-exactly. A truncated body (stream ends before the
 * final boundary) is a 400.
 */
async function scanForm(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  delim: Uint8Array,
  onPart: (part: FormPart) => void | Promise<void>
): Promise<void> {
  const crlfcrlf = encoder.encode('\r\n\r\n');
  const decoder = new TextDecoder();
  // RFC 2046: the FIRST delimiter may sit at byte 0 with no leading CRLF.
  // A virtual CRLF in front of the stream lets the uniform CRLF-prefixed
  // search match it while still skipping any preamble before it.
  let carry: Uint8Array = encoder.encode('\r\n');
  let stage: 'preamble' | 'headers' | 'body' = 'preamble';
  let from = 0;
  let partChunks: Uint8Array[] = [];
  let partLen = 0;
  let name = '';
  let filename: string | undefined;
  let contentType: string | undefined;

  for (;;) {
    if (stage === 'preamble') {
      const i = indexOfBytes(carry, delim, from);
      if (i < 0) {
        // No delimiter yet: everything but a partial-delimiter tail is
        // preamble and gets dropped — never buffered, never re-scanned.
        const keep = delim.length - 1;
        if (carry.length > keep) carry = carry.subarray(carry.length - keep);
        from = 0;
      } else {
        const follow = delimiterFollow(carry, i + delim.length);
        if (follow.kind === 'invalid') {
          from = i + 1;
          continue;
        }
        if (follow.kind === 'need') {
          // match pending — hold the carry and pull more bytes below
        } else if (follow.kind === 'final') {
          return;
        } else {
          carry = carry.subarray(follow.next);
          stage = 'headers';
          from = 0;
          continue;
        }
      }
    } else if (stage === 'headers') {
      if (
        from === 0 &&
        carry.length >= 2 &&
        carry[0] === CR &&
        carry[1] === LF
      ) {
        // An empty line straight after the delimiter line is an empty
        // header block: no Content-Disposition, so no field name — a form
        // part must carry one (RFC 7578 §4.2).
        throw httpError(400, 'Malformed multipart body');
      }
      const i = indexOfBytes(carry, crlfcrlf, from);
      if (i < 0) {
        if (carry.length > HEADER_BLOCK_MAX) {
          throw httpError(400, 'Malformed multipart body');
        }
        from = Math.max(0, carry.length - 3);
      } else {
        const block = decoder.decode(carry.subarray(0, i));
        carry = carry.subarray(i + 4);
        ({ name, filename, contentType } = parsePartHeaders(block));
        stage = 'body';
        partChunks = [];
        partLen = 0;
        from = 0;
        continue;
      }
    } else {
      const i = indexOfBytes(carry, delim, from);
      if (i < 0) {
        // Mid-part: flush all but a partial-delimiter tail into the part.
        const keep = delim.length - 1;
        const flush = carry.length - keep;
        if (flush > 0) {
          partChunks.push(carry.subarray(0, flush));
          partLen += flush;
          carry = carry.subarray(flush);
        }
        from = 0;
      } else {
        const follow = delimiterFollow(carry, i + delim.length);
        if (follow.kind === 'invalid') {
          from = i + 1;
          continue;
        }
        if (follow.kind === 'need') {
          // match pending — hold the carry and pull more bytes below
        } else {
          // Bytes before the delimiter's leading CRLF are the part's data.
          if (i > 0) {
            partChunks.push(carry.subarray(0, i));
            partLen += i;
          }
          const part: FormPart = {
            name,
            ...(filename !== undefined ? { filename } : {}),
            ...(contentType !== undefined ? { contentType } : {}),
            data: concatParts(partChunks, partLen),
          };
          await onPart(part);
          carry = carry.subarray(follow.next);
          partChunks = [];
          partLen = 0;
          if (follow.kind === 'final') return;
          stage = 'headers';
          from = 0;
          continue;
        }
      }
    }

    const result = await reader.read();
    if (result.done) {
      // Ran out of body while still expecting bytes: no final boundary,
      // an unterminated header block or a dangling partial delimiter.
      throw httpError(400, 'Malformed multipart body');
    }
    if (result.value.length > 0) carry = appendBytes(carry, result.value);
  }
}

/**
 * Incrementally parses a `multipart/form-data` request body, delivering
 * each part to `onPart` in order — the whole body is never buffered, parts
 * are buffered individually (see the module doc for the exact memory
 * bound).
 *
 * Semantics:
 * - A content-type that is not `multipart/form-data` (case-insensitive)
 *   with a `boundary` parameter (name case-insensitive, value quoted or
 *   bare) rejects before the body is touched: 415 `HttpError`.
 * - `options.limit` and `ctx.signal` ride through `readStream`: an
 *   oversized body rejects with a 413 `HttpError` (platform body
 *   cancelled), an aborted request with an `AbortError`.
 * - `onPart` is awaited sequentially; a rejection propagates after the
 *   stream is cancelled, aborting the parse.
 * - Truncated or malformed bodies (no final boundary, headerless part,
 *   oversized header block) reject with a 400 `HttpError`.
 * - Preamble before the first delimiter and the epilogue after the final
 *   one are tolerated and skipped; the epilogue is never read — the source
 *   is cancelled once `--boundary--` is confirmed.
 * - Terminal for the body: a later `readJson`/`readText`/`readForm`
 *   rejects with a 409 `HttpError`.
 */
export async function streamForm(
  ctx: Ctx,
  onPart: (part: FormPart) => void | Promise<void>,
  options: { limit?: number } = {}
): Promise<void> {
  const boundary = boundaryOf(ctx.req.headers.get('content-type'));
  const reader = readStream(ctx, { limit: options.limit }).getReader();
  const delim = encoder.encode(`\r\n--${boundary}`);
  try {
    await scanForm(reader, delim, onPart);
  } catch (error) {
    // A failed parse must not leave the upload draining on the platform.
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  // The final boundary was seen: skip the epilogue by cutting the source.
  await reader.cancel().catch(() => undefined);
}
