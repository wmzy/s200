# Response Batteries (`s200/serialize`, `s200/etag`, `s200/compress`, `s200/streaming`)

Schema-driven serialization, entity tags, compression, and streaming responses.

## Serialize (`s200/serialize`)

Schema-driven JSON serialization: `serialize(schema)` compiles a serializer for a JSON-Schema-shaped subset, and `jsonRaw` writes the result as a response with an exact `content-length`.

```ts
const toUser = serialize({
  type: 'object',
  properties: { id: { type: 'integer' }, name: { type: 'string' } },
  required: ['id', 'name'] as const,   // as const: the array literal drives optionality
});
get(app, '/users/:id', (ctx) => jsonRaw(ctx, toUser({ id: 1, name: 'ada' })));
```

| Function | Meaning |
| --- | --- |
| `serialize<S>(schema)` | Compiles `(value: InferSchema<S>) => string` — emits the declared keys in schema order, drops undeclared ones |
| `jsonRaw(ctx, json, init?)` | Writes an already-serialized JSON string: `content-type: application/json`, exact `content-length` |
| `compileValidator(schema)` | The read-side twin: `(data) => readonly ValidationIssue[]` — an empty list means conforming; never throws or rewrites |
| `checkSchema(schema, value)` | The closed-shape twin: `(schema, value) => readonly SchemaIssue[]` — same subset, but undeclared keys ARE violations; `path` is the key walk (`['items', 1, 'name']`, `[]` at the root), not a string |

`SerializeSchema` (the subset):

```ts
type SerializeSchema =
  | { type: 'object'; properties: { [key: string]: SerializeSchema }; required?: readonly string[] }
  | { type: 'array'; items: SerializeSchema }
  | { readonly type: PrimitiveType; readonly nullable?: boolean };
```

`PrimitiveType` names the leaf alternatives: `'string' | 'number' | 'integer' | 'boolean' | 'null'`.

- `InferSchema<S>` derives the compile-time input type (`required` keys non-optional, `nullable: true` widens to `T | null`).
- The payoff is the declared shape, not raw speed: an internal field can never leak through serialization. Modern engines' `JSON.stringify` stays competitive on typical payloads — use it when the shape contract matters, not as a speed hack.
- It is a serialization shape, not a validator: type mismatches are not checked, and `NaN`/`Infinity` serialize as `null` (JSON semantics).
- `compileValidator` mirrors the subset one-for-one: type mismatches report at the offending node, `nullable` admits `null` first, missing `required` keys report at their own path, extra keys are ignored. This is the validator `s200/openapi`'s `withRouteValidation` uses.
- `checkSchema` is its closed-shape twin (`additionalProperties: false`, matching what `serialize` emits on output — undeclared keys are violations), reporting `SchemaIssue` (`{ path: readonly PropertyKey[]; message }`). This is the checker `s200/response-check` runs against response bodies.

`ValidationIssue`: `{ path: string; message: string }` — `path` dot-joins the schema-relative location (`'items.2.name'`; the root is `''`).

## ETag (`s200/etag`)

Stamps a SHA-1 entity tag (weak by default) on byte-backed responses and answers `If-None-Match` hits with `304`. Byte-backed means an explicit `content-length` — s200's respond helpers set it, a bare `new Response('…')` does not. Chunked/streamed responses (SSE, `s200/streaming`) and range responses (206) are skipped, not buffered. Only `2xx` responses are stamped, and a response that already carries an `etag` passes through untouched — set your own and it wins. The `304` drops the copied `content-length` (RFC 9110 §15.4.5: omitted, not the would-be size) and keeps the tagged headers.

```ts
use(app, etag());                    // W/"…" by default
use(app, etag({ strong: true }));    // "…"
```

`EtagOptions`: `{ strong?: boolean }`. Comparison is weak per RFC 9110 §8.8.3 (the `W/` prefix is insignificant); `*` matches anything.

## Compress (`s200/compress`)

Response compression over the Web Standard `CompressionStream` — every supported runtime provides it. gzip/deflate stream the body; brotli is opt-in via an injected encoder (Node's `CompressionStream` has no brotli — the node adapter ships `brotliCompress`):

```ts
import { compress } from 's200/compress';
import { brotliCompress } from 's200/node';
use(app, compress({ brotli: { compress: brotliCompress } }));
```

`CompressOptions`:

| Field | Default | Meaning |
| --- | --- | --- |
| `minBytes` | `1024` | Minimum uncompressed size before a response is compressed; only consulted when the response carries a content-length (streamed responses compress regardless, like a proxy would) |
| `brotli` | — | `{ compress: (bytes) => Promise<Uint8Array> }` — `br` is only negotiated when injected; brotli is a buffered path (byte-backed responses only; streamed responses fall back to gzip/deflate) |

Encoding choice follows RFC 9110 §12.5.3: the highest-q coding wins; an explicit coding's q beats the `*` catch-all regardless of list order; an explicit `q=0` bans that coding even when `*` is acceptable. Ties break by server preference br > gzip > deflate (brotli is the densest); `*` alone picks `br` when a brotli encoder is injected, else `gzip`; nothing acceptable → uncompressed. q is clamped to [0, 1]; an unparseable q parameter is ignored (q stays 1).

Skips: responses that already carry a `content-encoding`, range responses (`content-range`), `cache-control: no-transform` (the RFC's do-not-transform directive), and bodyless responses. Everything it compresses gets `Vary: Accept-Encoding` stamped. Register it after the logger/cors slot in `use` order — it rewrites the response on the unwind.

## Streaming (`s200/streaming`)

Push-driven streaming responses over a `ReadableStream` — zero dependencies, every Web Standard runtime serves the resulting `Response` natively. Call inside a handler or middleware: the helper writes `ctx.res` in place and returns it; the pump runs detached from the middleware chain.

```ts
import { stream, streamSSE } from 's200/streaming';

get(app, '/log', (ctx) => stream(ctx, async (w) => {
  for (const line of lines) { await w.write(line); }   // write awaits backpressure
  w.close();
}));

get(app, '/events', (ctx) => streamSSE(ctx, async (sse) => {
  await sse.writeSSE({ id: '1', event: 'tick', data: { t: Date.now() } });
  sse.heartbeat();                                     // keep-alive comment
}));
```

| Function | Meaning |
| --- | --- |
| `stream(ctx, pump, init?)` | Chunked plain output (`application/octet-stream`); `pump(writer)` drives a `StreamWriter`; `init` overrides status/headers |
| `streamSSE(ctx, pump, init?)` | Server-Sent Events (`text/event-stream`, `cache-control: no-cache`); `pump(writer)` drives an `SseWriter`; `init` overrides status/headers |

| Type | Meaning |
| --- | --- |
| `StreamWriter` | `{ write(chunk): Promise<void>; close(): void; abort(error?): void }` — `write` resolves when buffered and waits under backpressure (await it inside the pump) |
| `SseWriter` | `StreamWriter & { writeSSE(event): Promise<void>; heartbeat(message?): Promise<void> }` |
| `SseEvent` | `{ id?, event?, data: string \| unknown, retry? }` — `data` objects are JSON-stringified |

The pump's completion closes the stream; its failure aborts it.
