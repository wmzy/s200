# Static Files

All I/O is injected — the core never touches a filesystem. Adapters ship the pieces (`s200/node` or `s200/bun`), but any `read` works: memory, S3, embedded.

```ts
import { serveStatic } from 's200';
import { createFileReader, createFileStat, createFileRangeReader } from 's200/node';

use(app, serveStatic({
  read: createFileReader('public'),
  stat: createFileStat('public'),             // ETag/Last-Modified + 304s
  readRange: createFileRangeReader('public'),  // streamed ranges: no whole-file buffering
  prefix: '/static',   // mount point, stripped before lookup
  spa: true,           // html navigation misses fall back to index.html
  cacheControl: 'public, max-age=3600',        // stamped on 200/206/304
}));
```

Traversal (`..`) never escapes the root, `index` (default `index.html`) serves directory paths, and misses fall through to `next()` so other routes can answer. Hidden files are refused by default — a request path with a dotfile segment (`.env`, `.git/…`, including percent-encoded forms) falls through instead of being served (`dotfiles: 'allow'` opts out). When the served root can contain symlinks, inject the adapter's `createRealPathGuard` so a real path outside the root falls through like a miss.

`stat` additionally turns on conditional requests: responses carry `ETag`/`Last-Modified`, and `If-None-Match`/`If-Modified-Since` hits answer `304`. Byte readers support single byte ranges (`Range: bytes=…` → 206, or 416 when unsatisfiable), so video seeking works; for large media, `read` may return a `ReadableStream` and `readRange` streams slice reads.

Full reference: [Static files in the README](https://github.com/wmzy/s200#static-files).
