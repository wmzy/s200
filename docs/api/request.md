# Request Intake (`s200/validate`, `s200/query`, `s200/accepts`, `s200/multipart`, `s200/upload`)

Validation gates, typed query parsing, content negotiation, and multipart handling.

## Validate (`s200/validate`)

Wraps any injected parse function as a **gate middleware**; the parsed value lands on `ctx.state.validated`. Zero-dependency: bring zod, valibot, typebox, or a hand-rolled check — s200 only calls it.

```ts
post(app, '/articles', jsonBody(ArticleSchema.parse), (ctx) => {
  json(ctx, { saved: ctx.state.validated });
});
```

| Function | Meaning |
| --- | --- |
| `validate(schema, options?)` | Gate over a plain parse function `(data) => T`; first thrown error → `422` `HttpError` with its message |
| `jsonBody<S>(schema)` | Gate over a JSON-body schema — a parse function **or** a Standard Schema value (anything with `~standard`) |
| `standardValidate(schema, data)` | The raw Standard Schema call: `validate()` → `{ value }` or `{ issues }`; empty `issues` counts as success |
| `isStandardSchema(value)` | Structural `~standard` predicate |

`ValidateOptions`: `{ key?: string }` — `ctx.state` slot for the parsed value, default `'validated'`.

### The Standard Schema channel

```ts
type StandardSchemaV1 = { '~standard': { version: 1; vendor: string; validate(value: unknown): StandardResult } };
type StandardSchema<T = unknown> = StandardSchemaV1 & { types?: { input: unknown; output: T } };
type StandardIssue = { message: string; path?: readonly PropertyKey[] };
type StandardResult = { value?: unknown; issues?: readonly StandardIssue[] };
type InputOf<S> = …;   // schema.types.input
type OutputOf<S> = …;  // schema.types.output
```

The phantom `types` prop types both sides for free: `jsonBody(schema)` demands and types the client's `init.body` (the input side, so transforming schemas are honest end to end), while `types.output` is what lands on `ctx.state.validated`. `jsonBody`'s first validation issue becomes a single `422` `HttpError` carrying its message.

## Query (`s200/query`)

The query-string twin of `validate`:

```ts
get(app, '/list', queryParams((q) => ({
  page: Number(q.page ?? 1),
  tags: q.tag ?? [],                    // repeated ?tag=a&tag=b → ['a','b']
})), (ctx) => json(ctx, ctx.state.validated));
```

| Function | Meaning |
| --- | --- |
| `parseQuery(ctx)` | Query string → `QueryRecord` (null-prototype object; repeated keys collect into `string[]`) |
| `queryParams<S>(schema)` | Gate over a Standard Schema — the query twin of `jsonBody` |
| `queryParams<Q, T>(read)` | Gate over a plain read function `(query: Q) => T` |

| Type | Meaning |
| --- | --- |
| `QueryRecord` | `Record<string, string \| string[]>` |
| `QueryInput` | The read shapes a `queryParams` callback may declare (values, numbers, booleans, arrays, optional keys) |
| `QueryParamsOptions` | `{ key?: string }` — `ctx.state` slot, default `'validated'` |

## Accepts (`s200/accepts`)

RFC 9110 content negotiation over `Accept` / `Accept-Encoding` / `Accept-Language` — q-values, wildcards, prefix ranges, and the §12.4.2 precedence (a more specific range overrides a wildcard, including a specific q=0 ban):

```ts
const want = accepts(ctx);
const type = want.type(['application/json', 'text/html']) ?? 'application/json';
```

`Accepts` (the return of `accepts(ctx)`):

| Method | Meaning |
| --- | --- |
| `type(candidates)` | Best media-type match, or `undefined` |
| `encoding(candidates)` | Best `Accept-Encoding` match |
| `language(candidates)` | Best `Accept-Language` match |

## Multipart (`s200/multipart`)

Incremental `multipart/form-data` parsing — the whole body is **never** buffered; each part is handed to `onPart` the moment its closing boundary is seen:

```ts
import { streamForm } from 's200/multipart';
await streamForm(ctx, (part) => { /* part.name, part.data, … */ });
// streamForm(ctx, onPart, options?) — options.limit budgets the whole body
```

`FormPart`: `{ name: string; filename?: string; contentType?: string; data: Uint8Array }` — binary-safe, byte-exact.

Memory is bounded per part, not per body: one part's bytes accumulate until its delimiter arrives, plus a scan window across chunk edges. A part's header block is capped at 16 KiB and transport padding at 256 bytes; a body crossing either is rejected as malformed. The `limit` budget rejects an oversized upload with a `413` `HttpError` while the platform body is cancelled mid-receive; an aborted `ctx.signal` surfaces as an `AbortError`; a second read of an already-streamed body rejects with a `409`.

## Upload (`s200/upload`)

`uploadForm` parses a multipart request over `streamForm` and walks every accepted file through an injected **sink** — s200 stays zero-dependency, the sink decides where the bytes land (disk, object storage, a hash):

```ts
import { uploadForm } from 's200/upload';
import { writeFile } from 'node:fs/promises';

const result = await uploadForm(
  ctx,
  (file) => writeFile(`/tmp/${file.filename}`, file.data),   // the sink
  {
    limit: 10 * 1024 * 1024,          // total body budget, enforced while streaming
    maxFileSize: 5 * 1024 * 1024,     // per-file cap (413)
    maxFiles: 8,                        // file-part cap (413)
    accept: ['image/'],                 // content-type allowlist (415)
  }
);
// result: { files: UploadedFile[], fields: QueryRecord }
```

| Function | Meaning |
| --- | --- |
| `uploadForm(ctx, sink, options?)` | Parses, gates, and lands an upload; fields come back as text, files as buffered `UploadFile`s plus whatever id the sink returned |

| Type | Meaning |
| --- | --- |
| `UploadFile` | `{ name, filename, contentType?, data: Uint8Array, size }` — one buffered file part |
| `UploadSink` | `(file: UploadFile) => Promise<string \| void> \| string \| void` — a returned string is reported as that file's `id`; a rejection aborts the whole upload |
| `UploadAccept` | `readonly string[]` (media-type prefixes) or `(part: FormPart) => boolean` |
| `UploadOptions` | `{ limit?, maxFileSize?, maxFiles?, accept? }` — all optional; the gates the example above shows |
| `UploadedFile` | `{ name, filename, contentType?, size, id? }` |
| `UploadResult` | `{ files: readonly UploadedFile[]; fields: QueryRecord }` |

Gates run in order — `accept` (415), `maxFiles` (413), `maxFileSize` (413) — before a file reaches the sink. Every rejection and any sink error aborts the upload: the parse stops, the platform source is cancelled, the error bubbles. A part is the unit of buffering: each file sits fully in memory by the time the sink sees it — for truly huge files, use `streamForm` directly.
