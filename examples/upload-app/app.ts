/**
 * Upload landing + serving — a slice of `s200/upload` + the static layer.
 *
 * Batteries on show:
 *   - `uploadForm` walks a multipart POST through the gates (an `accept`
 *     prefix allowlist, a per-file 5 MB cap, a total 10 MB limit enforced
 *     while the body streams) into an injected sink — s200 itself stays
 *     zero-dependency, the sink is where a runtime belongs: here
 *     `node:fs/promises` writeFile into ./uploads
 *   - the sink mints the served name (uuid + extension), never the client
 *     filename — uploads are bytes in, ids out, and no request path is
 *     ever derived from client input
 *   - `serveStatic` serves the same directory back, with the node
 *     adapter's stat + readRange injections: ETag/Last-Modified/304
 *     conditional requests and streamed 206 byte ranges
 *
 * Run: node app.ts (PORT env overrides 3000).
 */
import type { App } from 's200';
import type { UploadFile } from 's200/upload';

import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createApp, get, json, post, serveStatic, use } from 's200';
import { uploadForm } from 's200/upload';
import { createFileRangeReader, createFileReader, createFileStat, serve } from 's200/node';

/** Where landed files live — resolved next to this module, whatever the
 * process cwd happens to be, so `node app.ts` and the smoke script land
 * in the same place regardless of where they were launched from. */
export const uploadsDir = fileURLToPath(new URL('./uploads', import.meta.url));

// The directory is part of the app's shape, not of the repo — create it on
// import so a fresh clone serves its first upload without a setup step.
await mkdir(uploadsDir, { recursive: true });

/** Where a file lands: a uuid-named write into ./uploads, the id back. */
const sink = async (file: UploadFile): Promise<string> => {
  const id = `${randomUUID()}${extname(file.filename)}`;
  await writeFile(join(uploadsDir, id), file.data);
  return id;
};

export const app: App = createApp();

// Uploaded files come back from the same directory they landed in. The
// readers are already rooted at uploadsDir, so serveStatic's `root` stays
// unset (it would double the prefix); stat turns on conditional requests,
// readRange streams byte ranges without whole-file buffering.
use(
  app,
  serveStatic({
    read: createFileReader(uploadsDir),
    stat: createFileStat(uploadsDir),
    readRange: createFileRangeReader(uploadsDir),
    prefix: '/files',
  })
);

// The index: what has landed so far.
get(app, '/', async (ctx) => json(ctx, { files: await readdir(uploadsDir) }));

// The landing route. Gates in order before the sink: accept (415 for a
// content type outside the image allowlist), maxFileSize (413 per file),
// limit (413 total, rejected mid-receive while bytes are still arriving).
post(app, '/upload', async (ctx) => {
  const { files } = await uploadForm(ctx, sink, {
    accept: ['image/'],
    maxFileSize: 5 * 1024 * 1024,
    limit: 10 * 1024 * 1024,
  });
  return json(ctx, { files });
});

export async function main(): Promise<void> {
  const server = await serve(app, { port: Number(process.env.PORT ?? 3000) });
  console.log(`upload-app listening on ${server.url} — POST an image to /upload`);
}

// Serve only when executed directly (`node app.ts`), not when smoke.ts
// imports the app to drive it on an ephemeral port.
const entry =
  process.argv[1] === undefined
    ? undefined
    : pathToFileURL(realpathSync(process.argv[1])).href;
if (entry === import.meta.url) {
  await main();
}
