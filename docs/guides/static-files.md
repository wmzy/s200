# Static files

## serveStatic

All I/O is injected — the core never touches a filesystem. Adapters ship the pieces, but any `read` works (memory, S3, embedded):

```ts
import { serveStatic } from 's200';
import { createFileReader, createFileStat, createFileRangeReader } from 's200/node';

use(app, serveStatic({
  read: createFileReader('public'),
  stat: createFileStat('public'),            // ETag/Last-Modified + 304s
  readRange: createFileRangeReader('public'), // streamed ranges: no whole-file buffering
  prefix: '/static',  // mount point, stripped before lookup
  spa: true,          // html navigation misses fall back to index.html
  cacheControl: 'public, max-age=3600',      // stamped on 200/206/304
}));
```

## Roots and traversal

`root` is embedded into the lookup path handed to `read` — leave it unset (as above) when the injected readers are already rooted at a directory. Pass it (e.g. `root: 'assets'`) when the `read` function expects root-prefixed keys, like an in-memory map.

Traversal (`..`) never escapes the root, `index` (default `index.html`) serves directory paths, and misses fall through to `next()` so other routes can answer. Hidden files are refused by default — a request path with a dotfile segment (`.env`, `.git/…`, including percent-encoded forms) falls through instead of being served; opt out with `dotfiles: 'allow'`.

## Symlinks

Lexical checks can't see through symlinks: a symlink inside the root can point anywhere. The adapters' `createFileReader` therefore wires the realpath guard **by default** — every lookup is resolved, and a real path outside the root falls through like a miss. Bring your own `read` function and you own the guard (inject the adapter's `createRealPathGuard` the same way); it costs one realpath per request, and `createFileReader(root, { realPath: false })` opts out when the served tree is known symlink-free:

```ts
import { createRealPathGuard } from 's200/node';   // or 's200/bun'

use(app, serveStatic({ …, realPath: createRealPathGuard('public') }));
```

## Ranges and conditionals

Byte readers support single byte ranges (`Range: bytes=…` → 206, or 416 when unsatisfiable), so video seeking works — but a buffered read holds the file in memory. The adapters' `createFileReader` bounds that: files larger than `streamThreshold` (default 16 MiB) are served through the streamed path (`{ stream: true }` still forces it for everything), and with `readRange` injected, ranges on large files stream slice reads. `stat` additionally turns on conditional requests: responses carry `ETag`/`Last-Modified`, and `If-None-Match`/`If-Modified-Since` hits answer 304. A directory path missing its trailing slash gets a 301 to the slash form when the directory index exists (opt out: `redirectToSlash: false`).

