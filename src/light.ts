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
 * own request keeps working. Headers ride {@link LightHeaders}, a duck
 * `Headers` covering the same structural API.
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

/** True when the value is a {@link LightResponse} — duck-shaped, because
 * `instanceof Response` misses it and handlers may return one directly. */
export function isLightResponse(value: unknown): value is LightResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { status?: unknown }).status === 'number' &&
    typeof (value as { bytesSync?: unknown }).bytesSync === 'function'
  );
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

/** One name's slot in {@link LightHeaders}: the lowercase name and every
 * value appended under it, in arrival order. */
type HeaderSlot = { readonly name: string; values: string[] };

/** True when the value iterates `[name, value]` pairs — the platform
 * `Headers` and {@link LightHeaders} both qualify, so the fill paths branch
 * iterator-vs-record without `instanceof` chains. */
function isHeadersLike(
  value: unknown
): value is Iterable<[string, string]> | Iterable<readonly [string, string]> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] ===
      'function'
  );
}

/**
 * The light headers: a duck-typed `Headers` for the light path only —
 * case-insensitive by lowercase keying, insertion-ordered, and built from
 * plain array/`Map` primitives instead of the platform constructor's
 * per-instance normalization machinery. Implements the whole structural
 * surface s200 and its batteries call (`get`/`set`/`has`/`append`/
 * `delete`/`getSetCookie`/`forEach`/`entries`/`keys`/`values`/iteration),
 * which also makes it a legal `HeadersInit` everywhere: platform
 * constructors fill from anything with a pair iterator, and batteries that
 * copy (`new Headers(res.headers)` in compress/etag) consume it unchanged.
 *
 * Semantics follow the fetch spec's observable contract: iteration yields
 * lowercase names, combines repeated non-cookie values with `", "`, and
 * keeps each `set-cookie` value a separate pair.
 *
 * Construction is lazy when it can be: a {@link LightHeaders.fromRaw} wrap
 * only stores the flat array reference — the slot/index store is built on
 * the first structural access (`get`/`has`/`set`/`append`/`delete`/
 * `getSetCookie`/`fillRecord`/iteration), so a request whose headers are
 * never read pays nothing for them. Every method funnels through the same
 * `ensure()`, which also drains and drops http2 pseudo-headers.
 */
export class LightHeaders {
  /** Pending flat `[name, value, ...]` view (the adapter's rawHeaders) —
   * consumed into the store on first structural access. */
  private raw: readonly string[] | null = null;
  /** Slots + index — null until a structural access materializes it, so
   * headers nobody reads cost nothing to carry. */
  private store: { slots: HeaderSlot[]; index: Map<string, HeaderSlot> } | null =
    null;

  constructor(
    init?: HeadersInit | readonly [string, string][] | null
  ) {
    if (init === null || init === undefined) return;
    if (isHeadersLike(init)) {
      for (const [name, value] of init) {
        if (name !== undefined && value !== undefined) {
          this.append(name, value);
        }
      }
      return;
    }
    const record = init as Record<string, string>;
    for (const name of Object.keys(record)) {
      const value = record[name];
      if (value !== undefined) this.set(name, value);
    }
  }

  /** Wraps a flat `[name, value, name, value, ...]` array (node's
   * rawHeaders) by reference: no pairs are copied and no index is built
   * until the first structural access, so requests whose headers are
   * never read pay nothing for them. http2 pseudo-headers (`:method`,
   * ...) are dropped when the store is built. */
  static fromRaw(raw: readonly string[]): LightHeaders {
    const headers = new LightHeaders(null);
    headers.raw = raw;
    return headers;
  }

  /** The one construction funnel: builds the slot/index store exactly
   * once, draining the pending raw view (if any) into it first. */
  private ensure(): { slots: HeaderSlot[]; index: Map<string, HeaderSlot> } {
    const existing = this.store;
    if (existing !== null) return existing;
    const store = { slots: [] as HeaderSlot[], index: new Map<string, HeaderSlot>() };
    this.store = store;
    const raw = this.raw;
    this.raw = null;
    if (raw !== null) {
      for (let i = 0; i + 1 < raw.length; i += 2) {
        const name = raw[i];
        const value = raw[i + 1];
        if (name === undefined || value === undefined || name.startsWith(':')) {
          continue;
        }
        const key = name.toLowerCase();
        const slot = store.index.get(key);
        if (slot !== undefined) {
          slot.values.push(value);
        } else {
          const created: HeaderSlot = { name: key, values: [value] };
          store.slots.push(created);
          store.index.set(key, created);
        }
      }
    }
    return store;
  }

  get(name: string): string | null {
    const slot = this.ensure().index.get(name.toLowerCase());
    return slot === undefined ? null : slot.values.join(', ');
  }

  has(name: string): boolean {
    return this.ensure().index.has(name.toLowerCase());
  }

  set(name: string, value: string): void {
    const { slots, index } = this.ensure();
    const key = name.toLowerCase();
    const slot = index.get(key);
    if (slot !== undefined) {
      slot.values = [value];
      return;
    }
    const created: HeaderSlot = { name: key, values: [value] };
    slots.push(created);
    index.set(key, created);
  }

  append(name: string, value: string): void {
    const { slots, index } = this.ensure();
    const key = name.toLowerCase();
    const slot = index.get(key);
    if (slot !== undefined) {
      slot.values.push(value);
      return;
    }
    const created: HeaderSlot = { name: key, values: [value] };
    slots.push(created);
    index.set(key, created);
  }

  delete(name: string): void {
    const { slots, index } = this.ensure();
    const key = name.toLowerCase();
    const slot = index.get(key);
    if (slot === undefined) return;
    index.delete(key);
    slots.splice(slots.indexOf(slot), 1);
  }

  getSetCookie(): string[] {
    const slot = this.ensure().index.get('set-cookie');
    return slot === undefined ? [] : slot.values.slice();
  }

  /** Writes every header into `record` in one direct slot loop — merged
   * values per name (same as iteration), with `set-cookie` kept as the
   * values array (same as {@link getSetCookie}) — skipping the generator
   * and callback machinery of `forEach`. The node adapter's write path. */
  fillRecord(record: Record<string, string | string[]>): void {
    for (const slot of this.ensure().slots) {
      record[slot.name] =
        slot.name === 'set-cookie' ? slot.values.slice() : slot.values.join(', ');
    }
  }

  forEach(
    callback: (value: string, key: string, parent: LightHeaders) => void,
    thisArg?: unknown
  ): void {
    for (const [key, value] of this) {
      if (thisArg === undefined) {
        callback(value, key, this);
      } else {
        callback.call(thisArg, value, key, this);
      }
    }
  }

  *entries(): IterableIterator<[string, string]> {
    const slots = this.ensure().slots;
    for (const slot of slots) {
      if (slot.name === 'set-cookie') {
        for (const value of slot.values) {
          yield [slot.name, value];
        }
      } else {
        yield [slot.name, slot.values.join(', ')];
      }
    }
  }

  *keys(): IterableIterator<string> {
    for (const [key] of this) {
      yield key;
    }
  }

  *values(): IterableIterator<string> {
    for (const [, value] of this) {
      yield value;
    }
  }

  *[Symbol.iterator](): IterableIterator<[string, string]> {
    yield* this.entries();
  }
}

/**
 * Types the duck headers as the platform interface it replaces. The only
 * structural gap is undici's `HeadersIterator.[Symbol.dispose]` (Node's
 * iterator-disposal typing) — nothing in s200 or its batteries reads it,
 * and the runtime surface is identical everywhere it is consumed.
 */
function asPlatformHeaders(headers: LightHeaders): Headers {
  return headers as unknown as Headers;
}

/** The light request: exactly the surface s200 reads, plus the read
 * conveniences handler code uses (`text`/`json`/`formData`). */
export class LightRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array> | null;
  /** `Request.signal` parity: the disconnect signal the adapter passed
   * with `abortOnDisconnect`, `null` otherwise — `ctx.signal` remains the
   * primary read surface either way. */
  readonly signal: AbortSignal | null;

  private _bytes: Uint8Array | undefined;

  constructor(input: {
    readonly method: string;
    readonly url: string;
    readonly headers: Headers | LightHeaders | readonly [string, string][];
    readonly body?: ReadableStream<Uint8Array> | null;
    readonly signal?: AbortSignal | null;
  }) {
    (this as unknown as Record<symbol, unknown>)[kLight] = true;
    this.method = input.method;
    this.url = input.url;
    this.headers =
      input.headers instanceof Headers
        ? input.headers
        : input.headers instanceof LightHeaders
          ? asPlatformHeaders(input.headers)
          : asPlatformHeaders(new LightHeaders(input.headers));
    this.body = input.body ?? null;
    this.signal = input.signal ?? null;
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
    // A Headers-like (platform Headers from a battery's copy, or a light
    // one from the respond helpers) is kept by reference — every internal
    // caller builds it fresh for this response, so the copy the platform
    // constructor would make is pure overhead. Records and pair lists wrap
    // into a LightHeaders.
    const provided = init.headers as
      | Headers
      | LightHeaders
      | readonly [string, string][]
      | Record<string, string>
      | undefined;
    this.headers =
      provided instanceof Headers
        ? provided
        : asPlatformHeaders(
            provided instanceof LightHeaders
              ? provided
              : new LightHeaders(provided)
          );
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
      // Iterated copy (works for a platform Headers source and a light one
      // alike) — the clone must not alias the original's mutable headers.
      headers: asPlatformHeaders(new LightHeaders(this.headers)),
    }) as unknown as Response;
  }
}
