/**
 * Light-weight Request/Response for the opt-in fast path of the node
 * adapter (`serve(app, { light: true })`). NOT a public entry and never
 * patches globals: the adapter constructs these where it would otherwise
 * construct the platform's `Request`/`Response`, and `handle` plus the
 * respond helpers detect the marker on the request and stay light.
 *
 * The platform constructors carry per-request state-machine costs (see
 * `docs/benchmarks.md` — that cost is the whole gap between the real-Web-
 * Standard class and the patched one). These classes implement exactly the
 * surface s200 reads: `method`/`url`/`headers`/`body` on the request,
 * `status`/`statusText`/`headers`/`body`/`arrayBuffer`/`clone` on the
 * response — plus `text`/`json`/`formData` so handler code that reads its
 * own request keeps working.
 *
 * The Web Standard contract stays the default: `handle(app, request)` and
 * every adapter not named `light` deal in real platform objects.
 *
 * @internal
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Marker carried by light requests — `handle` and respond helpers detect
 * it and build light responses instead of platform ones. */
export const kLight: symbol = Symbol.for('s200.light');

/** True when the request came from the adapter's light path. */
export function isLightRequest(req: Request): boolean {
  return (req as unknown as Record<symbol, unknown>)[kLight] === true;
}

// Request URL parsed once per request: the adapter already holds the URL
// string when it builds the request, so the parse happens exactly once —
// `handle`'s `new URL(request.url)` re-parse is the savings.
const kUrl: symbol = Symbol.for('s200.url');

/** Stashes the parsed URL on a request for {@link cachedUrl}. */
export function setCachedUrl(req: Request, url: URL): void {
  (req as unknown as Record<symbol, unknown>)[kUrl] = url;
}

/** The adapter-parsed URL, when the adapter set one. */
export function cachedUrl(req: Request): URL | undefined {
  return (req as unknown as Record<symbol, unknown>)[kUrl] as URL | undefined;
}

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Normalizes a body to bytes (copied — mutation must not alias), a stream,
 * `null`, or a lazy promise for exotic `BodyInit` shapes the light class
 * does not special-case (Blob/FormData/URLSearchParams go through one real
 * platform `Response` — rare, correctness over speed there).
 */
function normalizeBody(
  body: BodyInit | Uint8Array | null
): Uint8Array | ReadableStream<Uint8Array> | Promise<Uint8Array> | null {
  if (body === null) return null;
  if (typeof body === 'string') return encoder.encode(body);
  if (body instanceof ReadableStream) return body;
  if (body instanceof Uint8Array) return body.slice();
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
    );
  }
  return new Response(body as BodyInit)
    .arrayBuffer()
    .then((buffer) => new Uint8Array(buffer));
}

/** The light request: exactly the surface s200 reads, plus the read
 * conveniences handler code uses (`text`/`json`/`formData`). */
export class LightRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array> | null;

  private _bytes: Uint8Array | undefined;

  constructor(input: {
    readonly method: string;
    readonly url: string;
    readonly headers: Headers | readonly [string, string][];
    readonly body?: ReadableStream<Uint8Array> | null;
  }) {
    (this as unknown as Record<symbol, unknown>)[kLight] = true;
    this.method = input.method;
    this.url = input.url;
    this.headers =
      input.headers instanceof Headers
        ? input.headers
        : new Headers(input.headers as [string, string][]);
    this.body = input.body ?? null;
  }

  /** Whole body as bytes (empty for bodyless); consumes and caches a
   * stream on first call so later reads replay. */
  async arrayBuffer(): Promise<ArrayBuffer> {
    if (this._bytes === undefined) {
      this._bytes =
        this.body === null ? new Uint8Array(0) : await collect(this.body);
    }
    return this._bytes.slice().buffer as ArrayBuffer;
  }

  async text(): Promise<string> {
    return decoder.decode(await this.arrayBuffer());
  }

  async json(): Promise<unknown> {
    return JSON.parse(await this.text());
  }

  /** Replays the cached bytes through the platform parser (the same trick
   * `s200`'s own `readForm` uses) so urlencoded/multipart bodies work. */
  async formData(): Promise<FormData> {
    const bytes = new Uint8Array(await this.arrayBuffer());
    return new Request('http://s200.invalid/', {
      method: 'POST',
      body: bytes,
      headers: this.headers,
    }).formData();
  }
}

/**
 * The light response. Byte-backed bodies skip the platform's stream
 * state machine entirely — the node adapter writes them straight to the
 * socket (`bytes()`), so the common `json`/`text`/`send` path never builds
 * a `ReadableStream`. Streamed bodies (SSE, compressed) read back through
 * the reader loop exactly like a real `Response`.
 */
export class LightResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;

  private _source: Uint8Array | ReadableStream<Uint8Array> | null;
  private _lazy: Promise<Uint8Array> | undefined;
  private _stream: ReadableStream<Uint8Array> | null | undefined;

  constructor(body: BodyInit | Uint8Array | null, init: ResponseInit = {}) {
    this.status = init.status ?? 200;
    this.statusText = init.statusText ?? '';
    this.headers = new Headers(init.headers);
    const normalized = normalizeBody(body);
    if (normalized instanceof Promise) {
      this._lazy = normalized;
      this._source = null;
    } else {
      this._source = normalized;
    }
    this._stream = undefined;
  }

  get body(): ReadableStream<Uint8Array> | null {
    if (this._stream !== undefined) return this._stream;
    if (this._source === null && this._lazy === undefined) return null;
    if (this._source instanceof ReadableStream) {
      this._stream = this._source;
      return this._stream;
    }
    if (this._lazy !== undefined) {
      const lazy = this._lazy;
      this._stream = new ReadableStream<Uint8Array>({
        // Arrow property: `this` stays the response instance (a method
        // shorthand would bind the source object).
        start: (controller) => {
          lazy.then(
            (bytes) => {
              this._source = bytes;
              this._lazy = undefined;
              controller.enqueue(bytes);
              controller.close();
            },
            (error: unknown) => controller.error(error)
          );
        },
      });
      return this._stream;
    }
    this._stream = streamFromBytes(this._source as Uint8Array);
    return this._stream;
  }

  /**
   * Synchronous whole-body bytes — the fast path the node adapter writes
   * directly to the socket. `null` for bodyless and streamed responses
   * (the caller falls back to the reader loop). (`bytesSync`, not `bytes`:
   * undici's Body mixin declares an async `bytes()`, and the intersection
   * on the adapter side must not resolve to it.)
   */
  bytesSync(): Uint8Array | null {
    if (this._lazy !== undefined) return null;
    return this._source instanceof ReadableStream ? null : this._source;
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    if (this._lazy !== undefined) {
      this._source = await this._lazy;
      this._lazy = undefined;
      this._stream = undefined;
    }
    if (this._source instanceof ReadableStream) {
      this._source = await collect(this._source);
      this._stream = undefined;
    }
    return this._source === null
      ? new ArrayBuffer(0)
      : (this._source.slice().buffer as ArrayBuffer);
  }

  async text(): Promise<string> {
    return decoder.decode(await this.arrayBuffer());
  }

  async json(): Promise<unknown> {
    return JSON.parse(await this.text());
  }

  /** Streamed bodies cannot be cloned — `s200/cache` never clones them
   * anyway (no content-length → never stored). */
  clone(): Response {
    if (this._lazy !== undefined || this._source instanceof ReadableStream) {
      throw new TypeError('Cannot clone a streamed light response body');
    }
    return new LightResponse(this._source === null ? null : this._source.slice(), {
      status: this.status,
      statusText: this.statusText,
      headers: new Headers(this.headers),
    }) as unknown as Response;
  }
}
