/**
 * Smoke test for upload-app — drives the real app.ts against the workspace
 * `src/` (the resolve hook in ../ts-resolve.mjs redirects the public
 * `s200*` entry names there), over a real HTTP server on an ephemeral port.
 *
 * Run: node smoke.ts — exits 0 when every check passes.
 */
import '../ts-resolve.mjs';

import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';

const { app, uploadsDir } = await import('./app.ts');
const { serve } = await import('s200/node');

let failures = 0;
const check = (name: string, ok: boolean, detail?: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${detail ?? ''}`}`);
  if (!ok) failures += 1;
};

const server = await serve(app, { port: 0 });
const base = server.url;

// A fake but honest PNG: the 8-byte magic (binary, non-UTF8) plus a
// payload, so byte-exactness through the whole round trip is observable.
const enc = new TextEncoder();
const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const PAYLOAD = enc.encode('fake but honest png payload');
const IMAGE = new Uint8Array(PNG.length + PAYLOAD.length);
IMAGE.set(PNG);
IMAGE.set(PAYLOAD, PNG.length);

const bytesOf = async (res: Response): Promise<Uint8Array> =>
  new Uint8Array(await res.arrayBuffer());
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);
const postForm = (form: FormData): Promise<Response> =>
  fetch(`${base}/upload`, { method: 'POST', body: form });

try {
  // Happy path: a PNG part lands and reports the sink-minted id.
  const good = new FormData();
  good.append('file', new Blob([IMAGE], { type: 'image/png' }), 'avatar.png');
  const uploaded = await postForm(good);
  const uploadBody = (await uploaded.json()) as {
    files?: { id?: string; size?: number }[];
  };
  const id = uploadBody.files?.[0]?.id ?? '';
  check('POST /upload png → 200', uploaded.status === 200);
  check('upload reports the sink id', id.endsWith('.png'), `id=${id}`);
  check('upload reports the byte size', uploadBody.files?.[0]?.size === IMAGE.length);

  // Read-back through the static layer: same bytes, right content type.
  const file = await fetch(`${base}/files/${id}`);
  check('GET /files/:id → 200', file.status === 200);
  check('served bytes match the uploaded png', sameBytes(await bytesOf(file), IMAGE));
  check('served content-type is image/png', file.headers.get('content-type') === 'image/png');

  // stat injection: validators on the response, and a revalidation 304.
  const etag = file.headers.get('etag');
  check('stat injection sets ETag', etag !== null);
  const revalidate = await fetch(`${base}/files/${id}`, {
    headers: { 'if-none-match': etag ?? '' },
  });
  check('If-None-Match → 304', revalidate.status === 304);

  // readRange injection: a slice request streams as a 206.
  const ranged = await fetch(`${base}/files/${id}`, {
    headers: { range: 'bytes=0-7' },
  });
  check('Range: bytes=0-7 → 206', ranged.status === 206);
  check('range slice is the PNG magic', sameBytes(await bytesOf(ranged), PNG));

  // accept gate: a text part is a 415 before the sink ever runs.
  const txt = new FormData();
  txt.append('file', new Blob([enc.encode('just notes')], { type: 'text/plain' }), 'notes.txt');
  const rejected = await postForm(txt);
  check('POST /upload txt → 415', rejected.status === 415);

  // maxFileSize gate: 5 MB + 1 byte → 413 (still under the 10 MB total
  // limit, so the rejection names the per-file cap).
  const big = new Uint8Array(5 * 1024 * 1024 + 1);
  big.set(PNG);
  const heavy = new FormData();
  heavy.append('file', new Blob([big], { type: 'image/png' }), 'big.png');
  const tooBig = await postForm(heavy);
  check('POST /upload over maxFileSize → 413', tooBig.status === 413);
  check(
    '413 names the per-file limit',
    ((await tooBig.json()) as { error?: string }).error?.includes('per-file limit') === true
  );

  // The index lists what landed.
  const list = await fetch(`${base}/`);
  const listed = (await list.json()) as { files?: string[] };
  check(
    'GET / lists the uploaded file',
    list.status === 200 && listed.files?.includes(id) === true
  );
} finally {
  await server.close();
  check('server closed (no longer listening)', server.server.listening === false);
  await rm(uploadsDir, { recursive: true, force: true });
  check('uploads dir cleaned up', !existsSync(uploadsDir));
}

process.exit(failures === 0 ? 0 : 1);
