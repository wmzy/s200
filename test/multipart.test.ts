import type { FormPart } from '../src/multipart';
import type { HttpError } from '../src/errors';

import { describe, it } from 'vitest';

import { createApp, handle, post } from '../src/app';
import { readJson } from '../src/body';
import { streamForm } from '../src/multipart';

const BOUNDARY = 's200testboundary';
const CONTENT_TYPE = `multipart/form-data; boundary=${BOUNDARY}`;
const DASH_LEN = 2 + BOUNDARY.length;

const enc = new TextEncoder();

function text(s: string): Uint8Array {
  return enc.encode(s);
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Builds a multipart body from labeled segments, recording each label's
 * absolute byte offset so tests can cut chunks at exact, adversarial
 * positions (mid-boundary, mid-CRLF, exact delimiter edge, …). */
function buildBody(
  segments: readonly { label: string; bytes: Uint8Array }[]
): { bytes: Uint8Array; at: (label: string) => number } {
  const offsets = new Map<string, number>();
  let total = 0;
  for (const seg of segments) {
    offsets.set(seg.label, total);
    total += seg.bytes.length;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const seg of segments) {
    bytes.set(seg.bytes, offset);
    offset += seg.bytes.length;
  }
  return { bytes, at: (label) => offsets.get(label) ?? -1 };
}

function splitBytes(bytes: Uint8Array, cuts: readonly number[]): Uint8Array[] {
  const points = [...new Set(cuts.filter((c) => c > 0 && c < bytes.length))].sort(
    (a, b) => a - b
  );
  const chunks: Uint8Array[] = [];
  let prev = 0;
  for (const point of points) {
    chunks.push(bytes.subarray(prev, point));
    prev = point;
  }
  chunks.push(bytes.subarray(prev));
  return chunks;
}

function singleBytes(bytes: Uint8Array): Uint8Array[] {
  const cuts: number[] = [];
  for (let i = 1; i < bytes.length; i += 1) cuts.push(i);
  return splitBytes(bytes, cuts);
}

/** Eager source: everything enqueued up front, then closed. */
function eagerBody(
  chunks: readonly Uint8Array[],
  onCancel?: () => void
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
    cancel() {
      onCancel?.();
    },
  });
}

/** A source that enqueues every chunk up front and then never closes — a
 * cancel can only ever surface through the `cancel` callback (a stream
 * that closed itself would swallow it). */
function stallingBody(
  chunks: readonly Uint8Array[],
  onCancel?: () => void
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
    },
    cancel() {
      onCancel?.();
    },
  });
}

function formRequest(
  source: ReadableStream<Uint8Array>,
  contentType: string
): Request {
  return new Request('http://localhost/', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: source,
    // Node requires duplex for streaming bodies.
    duplex: 'half',
  } as RequestInit & { duplex?: 'half' });
}

type EchoPart = {
  name: string;
  filename?: string;
  contentType?: string;
  data: number[];
};

type Outcome = {
  parts: EchoPart[];
  error: { status?: number; message?: string; name?: string } | null;
};

/** Drives streamForm through a real app/handler cycle and reports the
 * collected parts plus whatever streamForm threw. */
async function runForm(
  source: ReadableStream<Uint8Array>,
  contentType: string,
  options: {
    limit?: number;
    onPart?: (part: FormPart) => void | Promise<void>;
  } = {}
): Promise<Outcome> {
  const parts: FormPart[] = [];
  const app = createApp();
  post(app, '/', async (ctx) => {
    let error: Outcome['error'] = null;
    try {
      await streamForm(
        ctx,
        options.onPart ?? ((part) => { parts.push(part); }),
        { limit: options.limit }
      );
    } catch (e) {
      const err = e as { status?: number; message?: string; name?: string };
      error = { status: err.status, message: err.message, name: err.name };
    }
    return Response.json({
      parts: parts.map((p) => ({
        name: p.name,
        filename: p.filename,
        contentType: p.contentType,
        data: Array.from(p.data),
      })),
      error,
    });
  });
  const res = await handle(app, formRequest(source, contentType));
  return (await res.json()) as Outcome;
}

// Binary file bytes: NUL/0xff plus decoys that LOOK like the boundary —
// one char short, and boundary+garbage (an invalid delimiter follow). Both
// must survive byte-exactly as part data.
const FILE_BYTES = concat(
  text('binary:'),
  Uint8Array.of(0x00, 0x01, 0xfe, 0xff),
  text(`\r\n--${BOUNDARY.slice(0, -1)}`),
  Uint8Array.of(0x0d, 0x0a, 0x00, 0xff),
  text(`\r\n--${BOUNDARY}Z`),
  Uint8Array.of(0xff, 0x00)
);

// Preamble, padded delimiters, lowercase header names, escaped quotes in
// name/filename, binary decoys, padded final boundary, epilogue.
const ADVERSARIAL = buildBody([
  { label: 'preamble', bytes: text('preamble — skipped, never a part\r\n') },
  { label: 'd1', bytes: text(`--${BOUNDARY}  \r\n`) },
  { label: 'h1', bytes: text('Content-Disposition: form-data; name="a"\r\n\r\n') },
  { label: 'p1', bytes: text('hello') },
  { label: 'd2', bytes: text(`\r\n--${BOUNDARY}\r\n`) },
  // Escaped quotes on the wire: name="x\"y"; filename="we\"ird.bin"
  {
    label: 'h2',
    bytes: text(
      'content-disposition: form-data; name="x\\"y"; filename="we\\"ird.bin"\r\n\r\n'
    ),
  },
  { label: 'p2', bytes: text('quoted & escaped') },
  { label: 'd3', bytes: text(`\r\n--${BOUNDARY}\r\n`) },
  {
    label: 'h3',
    bytes: text(
      'Content-Disposition: form-data; name="file"; filename="data.bin"\r\nContent-Type: application/octet-stream\r\n\r\n'
    ),
  },
  { label: 'p3', bytes: FILE_BYTES },
  { label: 'd4', bytes: text(`\r\n--${BOUNDARY}--  \r\n`) },
  {
    label: 'epilogue',
    bytes: text('epilogue junk, ignored — not even read\r\n--nope--'),
  },
]);

function assertAdversarialParts(outcome: Outcome): void {
  // `.should` lives on Object.prototype — spell the null check out instead
  // of dereferencing null.
  (outcome.error === null).should.equal(true);
  outcome.parts.length.should.equal(3);

  // Absent optional fields surface as '<absent>' instead of a type lie.
  const field = (value: string | undefined): string => value ?? '<absent>';

  const [first, second, third] = outcome.parts;
  first!.name.should.equal('a');
  field(first!.filename).should.equal('<absent>');
  field(first!.contentType).should.equal('<absent>');
  first!.data.should.deep.equal(Array.from(text('hello')));

  second!.name.should.equal('x"y');
  field(second!.filename).should.equal('we"ird.bin');
  field(second!.contentType).should.equal('<absent>');
  second!.data.should.deep.equal(Array.from(text('quoted & escaped')));

  third!.name.should.equal('file');
  field(third!.filename).should.equal('data.bin');
  field(third!.contentType).should.equal('application/octet-stream');
  third!.data.should.deep.equal(Array.from(FILE_BYTES));
}

// The plain, producer-typical form: first boundary at byte 0, no preamble,
// no padding, standard final boundary.
const SIMPLE = buildBody([
  { label: 'd1', bytes: text(`--${BOUNDARY}\r\n`) },
  { label: 'h1', bytes: text('Content-Disposition: form-data; name="a"\r\n\r\n') },
  { label: 'p1', bytes: text('hello') },
  { label: 'd2', bytes: text(`\r\n--${BOUNDARY}\r\n`) },
  { label: 'h2', bytes: text('Content-Disposition: form-data; name="b"\r\n\r\n') },
  { label: 'p2', bytes: text('world') },
  { label: 'd3', bytes: text(`\r\n--${BOUNDARY}--\r\n`) },
]);

describe('streamForm', () => {
  it('parses fields and a binary file byte-exactly across adversarial chunk boundaries', async () => {
    const at = ADVERSARIAL.at;
    const cuts = [
      at('d2') + 1, // between the \r and \n of a delimiter's CRLF
      at('d2') + 6, // mid boundary string
      at('h2') + 33, // mid header line
      at('p2') - 1, // between the \r and \n of the header block's blank line
      at('d3'), // chunk ends exactly where \r\n--boundary begins
      at('d3') + 2 + DASH_LEN, // chunk ends right after --boundary, before its CRLF
      at('p3') + 9, // mid binary decoys
      at('d4') + 2 + DASH_LEN + 2, // right after --boundary--, before padded CRLF
    ];
    assertAdversarialParts(
      await runForm(eagerBody(splitBytes(ADVERSARIAL.bytes, cuts)), CONTENT_TYPE)
    );
  });

  it('parses the same payload one byte per chunk', async () => {
    // Every delimiter, CRLF and header line is split mid-way — the
    // strongest stress of the cross-chunk scan window.
    assertAdversarialParts(
      await runForm(eagerBody(singleBytes(ADVERSARIAL.bytes)), CONTENT_TYPE)
    );
  });

  it('round-trips a plain form whose first boundary sits at byte 0', async () => {
    const outcome = await runForm(
      eagerBody(splitBytes(SIMPLE.bytes, [10, 25, 45, 70])),
      CONTENT_TYPE
    );
    (outcome.error === null).should.equal(true);
    outcome.parts.length.should.equal(2);
    outcome.parts[0]!.name.should.equal('a');
    outcome.parts[0]!.data.should.deep.equal(Array.from(text('hello')));
    outcome.parts[1]!.name.should.equal('b');
    outcome.parts[1]!.data.should.deep.equal(Array.from(text('world')));
  });

  it('accepts uppercase media type, uppercase parameter name and a quoted boundary', async () => {
    const outcome = await runForm(
      eagerBody(splitBytes(SIMPLE.bytes, [15])),
      `MULTIPART/FORM-DATA; BOUNDARY="${BOUNDARY}"`
    );
    (outcome.error === null).should.equal(true);
    outcome.parts.length.should.equal(2);
    outcome.parts[1]!.data.should.deep.equal(Array.from(text('world')));
  });

  it('throws 415 for a urlencoded body', async () => {
    const outcome = await runForm(
      eagerBody([text('a=1&b=2')]),
      'application/x-www-form-urlencoded'
    );
    (outcome.error as { status: number }).status.should.equal(415);
    outcome.parts.length.should.equal(0);
  });

  it('throws 415 when the boundary parameter is missing', async () => {
    const outcome = await runForm(
      eagerBody([text(`--${BOUNDARY}--\r\n`)]),
      'multipart/form-data'
    );
    (outcome.error as { status: number }).status.should.equal(415);
    outcome.parts.length.should.equal(0);
  });

  it('propagates the 413 when the limit is exceeded mid-part', async () => {
    const body = buildBody([
      { label: 'd1', bytes: text(`--${BOUNDARY}\r\n`) },
      { label: 'h1', bytes: text('Content-Disposition: form-data; name="a"\r\n\r\n') },
      { label: 'p1', bytes: text('0123456789') },
      { label: 'd2', bytes: text(`\r\n--${BOUNDARY}--\r\n`) },
    ]);
    const outcome = await runForm(eagerBody([body.bytes]), CONTENT_TYPE, {
      limit: 30,
    });
    (outcome.error as { status: number }).status.should.equal(413);
    outcome.parts.length.should.equal(0);
  });

  it('propagates onPart failures and cancels the source', async () => {
    let cancelled = false;
    const cuts = [SIMPLE.at('h1') + 10, SIMPLE.at('d2') + 6];
    const outcome = await runForm(
      stallingBody(splitBytes(SIMPLE.bytes, cuts), () => {
        cancelled = true;
      }),
      CONTENT_TYPE,
      { onPart: () => { throw new Error('boom'); } }
    );
    (outcome.error as { message: string }).message.should.equal('boom');
    (outcome.error as { name: string }).name.should.equal('Error');
    (outcome.error?.status === undefined).should.equal(true);
    outcome.parts.length.should.equal(0);
    cancelled.should.equal(true);
  });

  it('rejects readJson with 409 after streamForm consumed the body', async () => {
    const app = createApp();
    post(app, '/', async (ctx) => {
      const parts: FormPart[] = [];
      await streamForm(ctx, (part) => {
        parts.push(part);
      });
      // vitest's should chain has no rejectedWith — catch manually.
      let status = 0;
      let message = '';
      try {
        await readJson(ctx);
      } catch (error) {
        const err = error as HttpError;
        status = err.status;
        message = err.message;
      }
      return Response.json({ count: parts.length, status, message });
    });

    const res = await handle(
      app,
      formRequest(eagerBody(splitBytes(ADVERSARIAL.bytes, [40, 120])), CONTENT_TYPE)
    );
    const report = (await res.json()) as {
      count: number;
      status: number;
      message: string;
    };
    report.count.should.equal(3);
    report.status.should.equal(409);
    report.message.should.equal('Body already streamed');
  });

  it('rejects a body truncated mid final boundary with 400, keeping completed parts', async () => {
    const cut = ADVERSARIAL.at('d4') + 4; // through `\r\n--`, boundary incomplete
    const outcome = await runForm(
      eagerBody([ADVERSARIAL.bytes.subarray(0, cut)]),
      CONTENT_TYPE
    );
    outcome.parts.length.should.equal(2); // fields delivered; file part pending
    (outcome.error as { status: number }).status.should.equal(400);
  });
});
