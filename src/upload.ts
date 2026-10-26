/**
 * Multipart upload landing: `uploadForm` parses a `multipart/form-data`
 * request over {@link streamForm} and walks every accepted file through an
 * injected sink — s200 stays zero-dependency, the sink decides where the
 * bytes land (disk, object storage, a hash). Field parts come back as
 * text, file parts as buffered {@link UploadFile}s plus whatever id the
 * sink returned.
 *
 * Gates, in order, before a file reaches the sink: `accept` (a 415 for a
 * content type outside the allowlist), `maxFiles` (a 413 naming the count
 * constraint), `maxFileSize` (a 413 naming the per-file limit). The last is
 * a FILE cap: field parts are never rejected for exceeding it. The
 * streaming per-part bound is the larger of `maxFileSize` and `streamForm`'s
 * 8 MiB default — a file past that floor aborts mid-receive, a file past
 * `maxFileSize` but under it rejects as its part completes (the sink never
 * sees either). The total `limit` and the part count `maxParts` (default
 * 256) are likewise enforced by `streamForm` mid-receive. Every rejection
 * and any sink error abort the upload: the parse stops, the platform source
 * is cancelled, the error bubbles for the error boundary.
 *
 * A part is the unit of buffering (see `s200/multipart`): each file sits
 * fully in memory by the time the sink sees it — right for typical
 * uploads, and `streamForm` remains the tool for truly huge files.
 *
 * Filenames arrive exactly as the client sent them. `safeFilename`
 * strips one down to a safe basename before it meets a path.
 *
 * @module
 */

import type { QueryRecord } from './query';
import type { Ctx } from './types';
import type { FormPart } from './multipart';

import { streamForm } from './multipart';
import { httpError } from './errors';

const decoder = new TextDecoder();

/** `streamForm`'s default per-part bound, mirrored here to keep the
 * streaming cap from dropping below it — the part cap is shared by field
 * and file parts, so `maxFileSize` must never shrink it. Kept in sync with
 * `multipart.ts`'s `DEFAULT_MAX_PART_SIZE`. */
const DEFAULT_PART_SIZE = 8 * 1024 * 1024;

/** Default bytes of head handed to the `sniff` hook per file part —
 * comfortably past every common content signature. */
const DEFAULT_SNIFF_BYTES = 512;

/** One file part, buffered whole and ready to land. `size` is
 * `data.length` — carried separately so sinks can log it cheaply. */
export type UploadFile = {
  /** Field name from Content-Disposition's `name` parameter. */
  readonly name: string;
  /** The client-side filename, unquoted. */
  readonly filename: string;
  /** The part's Content-Type header — absent when the client sent none. */
  readonly contentType?: string;
  /** The part's body bytes, binary-safe and byte-exact. */
  readonly data: Uint8Array;
  /** `data.length`. */
  readonly size: number;
};

/**
 * Where a file lands. Called once per accepted file part, awaited
 * sequentially; a returned string (a path, an object key, an id) is
 * reported as that file's `id` in the result. A rejection aborts the
 * whole upload — the parse stops, the source is cancelled, the error
 * bubbles. Sync sinks work too; the return type just accepts them.
 *
 * Plain disk landing, user side — s200 itself never touches `node:`
 * modules, so the sink is the one place a runtime belongs. The filename
 * is raw client input: splicing it straight into a path is a traversal
 * footgun (an `../../etc/cron.d/x` upload would escape the directory),
 * so route it through {@link safeFilename} first:
 *
 * ```ts
 * import { join } from 'node:path';
 * import { writeFile } from 'node:fs/promises';
 * uploadForm(ctx, (f) => writeFile(join(dir, safeFilename(f.filename)), f.data));
 * ```
 */
export type UploadSink = (file: UploadFile) => Promise<string | void> | string | void;

/**
 * Content-type allowlist for file parts: a list of media-type prefixes
 * (`['image/']` admits `image/png`, `image/webp`, …) or a predicate over
 * the raw part for anything a prefix cannot express.
 */
export type UploadAccept = readonly string[] | ((part: FormPart) => boolean);

/**
 * Content sniff hook — the injection seam for content-type trust: the
 * first `sniffBytes` bytes (default 512) of every file part, plus the
 * part itself, and the verdict is entirely yours. No magic tables ship —
 * the classic signatures (PNG's `\x89PNG`, JPEG's `\xff\xd8\xff`) are a
 * three-line predicate away:
 *
 * ```ts
 * uploadForm(ctx, sink, {
 *   sniff: (head, part) =>
 *     part.contentType === 'image/png'
 *       ? head[0] === 0x89 && head[1] === 0x50
 *       : true,
 * });
 * ```
 *
 * `false` rejects the upload with a `415` before the sink ever runs —
 * same mid-stream semantics as the other gates: the parse stops, later
 * parts are never read, the platform source is cancelled.
 */
export type UploadSniff = (
  head: Uint8Array,
  part: FormPart
) => boolean | Promise<boolean>;

export type UploadOptions = {
  /** Total byte budget for the whole body, streamed through `streamForm`:
   * an oversized upload rejects with a 413 while bytes are still
   * arriving. */
  readonly limit?: number;
  /** Per-FILE byte cap — file parts only; a text field is never rejected
   * for exceeding it (fields are bounded by the total `limit` and the
   * shared streaming part bound: 8 MiB by default, this value when it is
   * larger). A file past `maxFileSize` rejects with a 413 before the sink
   * sees it — mid-stream when it also crosses that shared bound, otherwise
   * as its part completes. */
  readonly maxFileSize?: number;
  /** Cap on the number of file parts. */
  readonly maxFiles?: number;
  /** Cap on the TOTAL number of parts, fields included (default 256,
   * `streamForm`'s bound): a form of endless parts rejects with a 413
   * mid-stream at the offending part's headers. */
  readonly maxParts?: number;
  /** Content-type allowlist for file parts — field parts are never
   * filtered. A prefix list only matches a declared Content-Type: a file
   * part without one is rejected (strict allowlist); the callback form
   * decides that case itself. */
  readonly accept?: UploadAccept;
  /**
   * Content sniff hook (see {@link UploadSniff}): the first
   * `sniffBytes` of every file part go in, `false` rejects with a `415`
   * before the sink runs. Gate order: `accept` → `maxFiles` →
   * `maxFileSize` → `sniff` → sink.
   */
  readonly sniff?: UploadSniff;
  /** Bytes of head handed to `sniff` per file part; default 512. A file
   * shorter than that hands its whole body — the head is a view into the
   * part buffer, not a copy. */
  readonly sniffBytes?: number;
};

/** One landed file in {@link UploadResult}. `id` is present exactly when
 * the sink returned a string for it. */
export type UploadedFile = {
  /** Field name from Content-Disposition's `name` parameter. */
  readonly name: string;
  /** The client-side filename, unquoted. */
  readonly filename: string;
  /** The part's Content-Type header — absent when the client sent none. */
  readonly contentType?: string;
  /** Landed byte count. */
  readonly size: number;
  /** The string the sink returned, if any. */
  readonly id?: string;
};

/**
 * The outcome of a completed upload: every file that passed the gates and
 * landed, plus the form's text fields.
 */
export type UploadResult = {
  readonly files: readonly UploadedFile[];
  readonly fields: QueryRecord;
};

/**
 * Prefix allowlist match — media types are case-insensitive (RFC 9110
 * §8.3.1), so both sides fold. A part that declared no Content-Type
 * matches no prefix; the callback form makes its own call.
 */
function accepted(part: FormPart, accept: UploadAccept): boolean {
  if (typeof accept === 'function') return accept(part);
  const type = part.contentType?.toLowerCase();
  return (
    type !== undefined && accept.some((prefix) => type.startsWith(prefix.toLowerCase()))
  );
}

/**
 * Collapses a client-controlled filename to a safe basename — the thing
 * to call before the name meets a path. `../../etc/passwd` → `passwd`,
 * `/etc/shadow` → `shadow`, `..\..\win.ini` → `win.ini`,
 * `C:\Users\me\report.pdf` → `report.pdf`.
 *
 * Pipeline: control characters (NUL, C0, DEL, C1) go first — before the
 * split, so one can't weld two path segments together; both separators
 * (`/` and `\` — Windows clients send backslashes) then split the rest
 * and only the last non-empty segment survives; leading/trailing runs
 * of dots and spaces are trimmed, so `..`, `.` and `report.` (a win32
 * alias of `report`) never land, and neither do dotfiles (`.env` →
 * `env`, `.htaccess` → `htaccess`). An empty result — an empty name,
 * `../..`, `///`, nothing but control characters — returns the
 * deterministic `'upload'` instead, so a sink always has a usable name.
 *
 * Everything else passes through untouched: unicode letters and digits,
 * `.-_`, spaces, parentheses — a normal filename never deforms.
 *
 * Deliberately NOT covered: Windows reserved device names (`CON`,
 * `NUL`, `COM1`, …) and NTFS alternate data streams (`file.txt:ads`
 * keeps its colon — a legal filename elsewhere) pass through as-is, and
 * there is no length cap. None of those traverse; enforce them in the
 * sink if the target platform cares.
 */
export function safeFilename(name: string): string {
  // Control characters (C0/C1) are stripped on purpose — the sanitizer's
  // job — so the lint rule that guards against accidental control chars
  // is disabled for this one pattern.
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  const segments = cleaned.split(/[/\\]+/).filter((s) => s !== '');
  const base = (segments[segments.length - 1] ?? '').replace(/^[ .]+|[ .]+$/g, '');
  return base !== '' ? base : 'upload';
}

/**
 * Collects a `multipart/form-data` upload: text fields into `fields`,
 * files through `sink` — one at a time, after the gates.
 *
 * Semantics:
 * - Field parts (no `filename`) decode as UTF-8 and collect into
 *   `fields` with `parseQuery`'s convention: a name seen once is a
 *   `string`, a repeated name a `string[]`.
 * - File parts pass the `accept`/`maxFiles`/`maxFileSize`/`sniff` gates in
 *   that order, then reach the sink. A sink-returned string is reported
 *   as that file's `id`; a sink rejection aborts everything and propagates.
 * - Errors, all bubbling for the error boundary: a 415 `HttpError` for a
 *   non-multipart content type, an allowlist rejection, or a failed
 *   content sniff; a 413 for the
 *   total `limit`, the part count `maxParts` (default 256), `maxFiles`,
 *   or `maxFileSize` (file parts only), a 400 for a malformed body.
 * - Terminal for the body: a later `readJson`/`readText`/`readForm`
 *   rejects with the 409.
 */
export async function uploadForm(
  ctx: Ctx,
  sink: UploadSink,
  options: UploadOptions = {}
): Promise<UploadResult> {
  const { accept, limit, maxFiles, maxFileSize, maxParts, sniff } = options;
  const sniffBytes = options.sniffBytes ?? DEFAULT_SNIFF_BYTES;
  if (!Number.isSafeInteger(sniffBytes) || sniffBytes < 0) {
    throw new Error(
      `Invalid upload sniffBytes ${String(sniffBytes)}: must be a non-negative integer`
    );
  }
  const files: UploadedFile[] = [];
  // Null prototype, same reason as `parseQuery`: `__proto__` must land as
  // a plain own key, `constructor` must not shadow inherited members.
  const fields = Object.create(null) as QueryRecord;
  await streamForm(
    ctx,
    async (part) => {
      if (part.filename === undefined) {
        const value = decoder.decode(part.data);
        const existing = fields[part.name];
        if (existing === undefined) {
          fields[part.name] = value;
        } else if (Array.isArray(existing)) {
          existing.push(value);
        } else {
          fields[part.name] = [existing, value];
        }
        return;
      }
      if (accept !== undefined && !accepted(part, accept)) {
        throw httpError(
          415,
          `Unsupported file content type "${part.contentType ?? 'none declared'}" for "${part.filename}"`
        );
      }
      if (maxFiles !== undefined && files.length >= maxFiles) {
        throw httpError(
          413,
          `Too many files: "${part.filename}" exceeds the limit of ${maxFiles}`
        );
      }
      if (maxFileSize !== undefined && part.data.length > maxFileSize) {
        throw httpError(
          413,
          `File "${part.filename}" is ${part.data.length} bytes; the per-file limit is ${maxFileSize}`
        );
      }
      // Content sniff, last gate before the sink: the caller's verdict on
      // the head bytes decides whether the declared Content-Type is
      // trustworthy. A `false` is a 415 like an allowlist miss — same
      // mid-stream abort semantics (later parts never parse, the source
      // is cancelled).
      if (sniff !== undefined && !(await sniff(part.data.subarray(0, sniffBytes), part))) {
        throw httpError(
          415,
          `File "${part.filename}" failed the content sniff — its bytes do not match the declared "${part.contentType ?? 'none'}"`
        );
      }
      const file: UploadFile = {
        name: part.name,
        filename: part.filename,
        ...(part.contentType !== undefined ? { contentType: part.contentType } : {}),
        data: part.data,
        size: part.data.length,
      };
      const id = await sink(file);
      files.push({
        name: file.name,
        filename: file.filename,
        ...(file.contentType !== undefined ? { contentType: file.contentType } : {}),
        size: file.size,
        ...(typeof id === 'string' ? { id } : {}),
      });
    },
    // `maxFileSize` cannot simply become `streamForm`'s per-part cap: that
    // cap applies to every part, so a small file cap would also reject
    // large text fields. The streaming bound is instead the larger of the
    // file cap and `streamForm`'s 8 MiB default (undefined = default); the
    // file cap itself is enforced in `onPart` above. Field parts stay
    // bounded by `limit` and that per-part default.
    {
      limit,
      maxParts,
      ...(maxFileSize === undefined
        ? {}
        : { maxPartSize: Math.max(maxFileSize, DEFAULT_PART_SIZE) }),
    }
  );
  return { files, fields };
}
