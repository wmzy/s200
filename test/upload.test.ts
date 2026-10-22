import type { UploadFile, UploadOptions } from '../src/upload';

import { describe, it } from 'vitest';

import { createApp, handle, post } from '../src/app';
import { uploadForm } from '../src/upload';

const BOUNDARY = 's200uploadboundary';
const CONTENT_TYPE = `multipart/form-data; boundary=${BOUNDARY}`;

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

/** A field part (no filename, no Content-Type) — what `uploadForm`
 * collects into `fields`. */
function field(name: string, value: string): Uint8Array {
  return text(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
  );
}

/** A file part (filename present, Content-Type optional) — what walks the
 * gates and reaches the sink. */
function filePart(
  name: string,
  filename: string,
  contentType: string | undefined,
  data: Uint8Array
): Uint8Array {
  const type = contentType === undefined ? '' : `Content-Type: ${contentType}\r\n`;
  return concat(
    text(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\n${type}\r\n`
    ),
    data,
    text('\r\n')
  );
}

/** Each part enqueued as its own chunk, then the closing boundary and a
 * close — the eager producer-typical source. */
function bodyOf(...parts: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of parts) controller.enqueue(chunk);
      controller.enqueue(text(`--${BOUNDARY}--\r\n`));
      controller.close();
    },
  });
}

/** A source that never closes — a cancel can only surface through the
 * `cancel` callback (a stream that closed itself would swallow it). */
function stallingBody(
  chunks: readonly Uint8Array[],
  onCancel: () => void
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
    },
    cancel() {
      onCancel();
    },
  });
}

function formRequest(source: ReadableStream<Uint8Array>): Request {
  return new Request('http://localhost/', {
    method: 'POST',
    headers: { 'content-type': CONTENT_TYPE },
    body: source,
    // Node requires duplex for streaming bodies.
    duplex: 'half',
  } as RequestInit & { duplex?: 'half' });
}

type LandedFile = {
  name: string;
  filename?: string;
  contentType?: string;
  size: number;
  data: number[];
};

type UploadOutcome = {
  result: {
    files: readonly {
      name: string;
      filename?: string;
      contentType?: string;
      size: number;
      id?: string;
    }[];
    fields: Record<string, string | string[]>;
  } | null;
  landed: LandedFile[];
  error: { status?: number; message?: string; name?: string } | null;
};

/** Drives uploadForm through a real app/handler cycle, recording what the
 * sink saw plus whatever uploadForm threw or returned. */
async function runUpload(
  source: ReadableStream<Uint8Array>,
  sink: (file: UploadFile) => Promise<string | void> | string | void,
  options: UploadOptions = {}
): Promise<UploadOutcome> {
  const landed: LandedFile[] = [];
  const app = createApp();
  post(app, '/', async (ctx) => {
    let error: UploadOutcome['error'] = null;
    let result: UploadOutcome['result'] = null;
    try {
      result = await uploadForm(
        ctx,
        async (file) => {
          landed.push({
            name: file.name,
            filename: file.filename,
            ...(file.contentType !== undefined ? { contentType: file.contentType } : {}),
            size: file.size,
            data: Array.from(file.data),
          });
          return sink(file);
        },
        options
      );
    } catch (e) {
      const err = e as { status?: number; message?: string; name?: string };
      error = { status: err.status, message: err.message, name: err.name };
    }
    return Response.json({ result, landed, error });
  });
  const res = await handle(app, formRequest(source));
  return (await res.json()) as UploadOutcome;
}

// Binary payloads: the PNG/JPEG magics — non-UTF8 bytes that must reach
// the sink byte-exactly.
const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPEG = concat(text('jpeg:'), Uint8Array.of(0xff, 0xd8, 0xff, 0xe0));

describe('uploadForm', () => {
  it('lands a mixed form: fields collect, files reach the sink byte-exact', async () => {
    const outcome = await runUpload(
      bodyOf(
        field('title', 'holiday'),
        filePart('avatar', 'me.png', 'image/png', PNG),
        field('note', 'binary-safe'),
        filePart('photo', 'pic.jpg', 'image/jpeg', JPEG)
      ),
      (file) => `/tmp/${file.filename}`,
      { accept: ['image/'] }
    );
    (outcome.error === null).should.equal(true);
    outcome.result!.fields.should.deep.equal({ title: 'holiday', note: 'binary-safe' });
    outcome.landed.length.should.equal(2);
    outcome.landed[0]!.name.should.equal('avatar');
    outcome.landed[0]!.data.should.deep.equal(Array.from(PNG));
    outcome.landed[0]!.size.should.equal(PNG.length);
    outcome.landed[1]!.data.should.deep.equal(Array.from(JPEG));
    (outcome.landed[1]!.filename ?? '').should.equal('pic.jpg');
    (outcome.landed[1]!.contentType ?? '').should.equal('image/jpeg');

    const files = outcome.result!.files;
    files.length.should.equal(2);
    files[0]!.name.should.equal('avatar');
    (files[0]!.filename ?? '').should.equal('me.png');
    (files[0]!.contentType ?? '').should.equal('image/png');
    files[0]!.size.should.equal(8);
    (files[0]!.id ?? '').should.equal('/tmp/me.png');
    (files[1]!.id ?? '').should.equal('/tmp/pic.jpg');
  });

  it('collects repeated field names into arrays, single names into strings', async () => {
    const outcome = await runUpload(
      bodyOf(
        field('tag', 'a'),
        field('tag', 'b'),
        field('solo', 'x'),
        field('tag', 'c')
      ),
      () => undefined
    );
    (outcome.error === null).should.equal(true);
    outcome.result!.fields.should.deep.equal({ tag: ['a', 'b', 'c'], solo: 'x' });
    outcome.result!.files.length.should.equal(0);
  });

  it('rejects an off-allowlist content type with a 415 before the sink', async () => {
    const outcome = await runUpload(
      bodyOf(
        filePart('avatar', 'ok.png', 'image/png', PNG),
        filePart('doc', 'notes.txt', 'text/plain', text('notes'))
      ),
      (file) => `stored:${file.filename}`,
      { accept: ['image/'] }
    );
    (outcome.error as { status: number }).status.should.equal(415);
    (outcome.error as { message: string }).message.should.match(/text\/plain/);
    // The first file already landed — parts are processed sequentially.
    outcome.landed.length.should.equal(1);
    (outcome.result === null).should.equal(true);
  });

  it('rejects a file without a declared content type under a prefix allowlist', async () => {
    const outcome = await runUpload(
      bodyOf(filePart('blob', 'data.bin', undefined, PNG)),
      () => 'must-not-land',
      { accept: ['image/'] }
    );
    (outcome.error as { status: number }).status.should.equal(415);
    (outcome.error as { message: string }).message.should.match(/none declared/);
    outcome.landed.length.should.equal(0);
  });

  it('matches accept prefixes case-insensitively', async () => {
    const outcome = await runUpload(
      bodyOf(filePart('avatar', 'me.png', 'Image/PNG', PNG)),
      () => undefined,
      { accept: ['image/'] }
    );
    (outcome.error === null).should.equal(true);
    outcome.landed.length.should.equal(1);
    // Sink returned void: no id key on the result entry.
    (outcome.result!.files[0]!.id === undefined).should.equal(true);
  });

  it('accepts through a callback over the raw part', async () => {
    const outcome = await runUpload(
      bodyOf(filePart('avatar', 'me.PNG', 'Image/PNG', PNG)),
      (file) => `id-${file.filename}`,
      { accept: (part) => (part.filename ?? '').toLowerCase().endsWith('.png') }
    );
    (outcome.error === null).should.equal(true);
    outcome.landed.length.should.equal(1);
    (outcome.result!.files[0]!.id ?? '').should.equal('id-me.PNG');
  });

  it('enforces maxFiles with a 413 naming the count constraint', async () => {
    const outcome = await runUpload(
      bodyOf(
        filePart('a', 'a.png', 'image/png', PNG),
        filePart('b', 'b.png', 'image/png', PNG),
        filePart('c', 'c.png', 'image/png', PNG)
      ),
      () => 'ok',
      { maxFiles: 2 }
    );
    (outcome.error as { status: number }).status.should.equal(413);
    (outcome.error as { message: string }).message.should.match(/Too many files/);
    outcome.landed.length.should.equal(2);
    (outcome.result === null).should.equal(true);
  });

  it('caps a file part at maxFileSize with a 413, sink untouched', async () => {
    const outcome = await runUpload(
      bodyOf(
        filePart('small', 'ok.png', 'image/png', PNG),
        filePart('avatar', 'big.png', 'image/png', concat(PNG, PNG, PNG))
      ),
      () => 'ok',
      { maxFileSize: PNG.length * 2 }
    );
    (outcome.error as { status: number }).status.should.equal(413);
    // A field-independent file cap: the message names the file and the
    // per-file limit, not the shared per-part bound.
    (outcome.error as { message: string }).message.should.match(/big\.png/);
    (outcome.error as { message: string }).message.should.match(/per-file limit is 16/);
    // The good file before the oversize one landed; the oversize part
    // never reached the sink.
    outcome.landed.length.should.equal(1);
    outcome.landed[0]!.name.should.equal('small');
    (outcome.result === null).should.equal(true);
  });

  it('passes a large text field that exceeds maxFileSize', async () => {
    const bio = 'x'.repeat(4096);
    const outcome = await runUpload(
      bodyOf(field('bio', bio), filePart('avatar', 'me.png', 'image/png', PNG)),
      () => 'ok',
      { maxFileSize: 1024 }
    );
    // maxFileSize is a FILE cap: the 4 KiB field rides through untouched.
    (outcome.error === null).should.equal(true);
    (outcome.result!.fields['bio'] as string).should.equal(bio);
    outcome.landed.length.should.equal(1);
    outcome.landed[0]!.name.should.equal('avatar');
  });

  it('aborts a file past the streaming part bound: 413, source cancelled', async () => {
    let cancelled = false;
    const outcome = await runUpload(
      stallingBody(
        [
          filePart('small', 'ok.png', 'image/png', PNG),
          // Over the 8 MiB floor by more than the scanner's partial-
          // delimiter carry, so the cap trips on the flush itself.
          filePart(
            'avatar',
            'big.bin',
            'application/octet-stream',
            new Uint8Array(8 * 1024 * 1024 + 4096).fill(7)
          ),
        ],
        () => {
          cancelled = true;
        }
      ),
      () => 'ok',
      { maxFileSize: 1024 }
    );
    (outcome.error as { status: number }).status.should.equal(413);
    // A small maxFileSize never shrinks the 8 MiB streaming floor, which
    // cuts the receive before the part is fully buffered.
    (outcome.error as { message: string }).message.should.match(/part limit/);
    outcome.landed.length.should.equal(1);
    outcome.landed[0]!.name.should.equal('small');
    (outcome.result === null).should.equal(true);
    cancelled.should.equal(true);
  });

  it('bounds parts by uploadForm defaults: an 8 MiB+1 part rejects with 413', async () => {
    const over = new Uint8Array(8 * 1024 * 1024 + 1);
    const outcome = await runUpload(
      bodyOf(filePart('blob', 'big.bin', 'application/octet-stream', over)),
      () => 'ok'
    );
    (outcome.error as { status: number }).status.should.equal(413);
    (outcome.error as { message: string }).message.should.match(/part limit/);
    outcome.landed.length.should.equal(0);
  });

  it('enforces maxParts (fields count) with a 413 mid-stream', async () => {
    const outcome = await runUpload(
      bodyOf(field('a', '1'), field('b', '2'), field('c', '3')),
      () => 'ok',
      { maxParts: 2 }
    );
    (outcome.error as { status: number }).status.should.equal(413);
    (outcome.error as { message: string }).message.should.match(/Too many multipart parts/);
    outcome.landed.length.should.equal(0);
  });

  it('enforces the total limit while the body streams (413, zero files sunk)', async () => {
    const outcome = await runUpload(
      bodyOf(field('a', 'x'), filePart('avatar', 'me.png', 'image/png', PNG)),
      () => 'ok',
      { limit: 16 }
    );
    (outcome.error as { status: number }).status.should.equal(413);
    outcome.landed.length.should.equal(0);
  });

  it('propagates a sink rejection and cancels the source', async () => {
    let cancelled = false;
    // The trailing field chunk opens the file part's closing delimiter —
    // without it the stalling source would never deliver the part.
    const outcome = await runUpload(
      stallingBody(
        [filePart('avatar', 'me.png', 'image/png', PNG), field('after', 'y')],
        () => {
          cancelled = true;
        }
      ),
      () => {
        throw new Error('disk full');
      }
    );
    (outcome.error as { message: string }).message.should.equal('disk full');
    (outcome.error as { name: string }).name.should.equal('Error');
    (outcome.error?.status === undefined).should.equal(true);
    outcome.landed.length.should.equal(1);
    (outcome.result === null).should.equal(true);
    cancelled.should.equal(true);
  });
});
