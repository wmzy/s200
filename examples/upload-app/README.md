# upload-app — multipart upload landing + serving

An image dropbox in ~70 lines. Demonstrates the **`s200/upload`** battery
(`uploadForm`) and the **static layer** with the node adapter's file
injections, plus the contract between them:

- `uploadForm` gates and buffers each file part, then hands it to an
  injected **sink** — s200 stays zero-dependency, the sink is where a
  runtime belongs. Here it is `node:fs/promises` `writeFile` into
  `./uploads`, returning the id it minted (a uuid + the file's extension —
  never the client filename, so no request path is derived from input);
- gates, in order: `accept: ['image/']` (415 for anything else),
  `maxFileSize: 5 MB` (413 per file), `limit: 10 MB` enforced **while the
  body streams** (413 mid-receive, not after buffering);
- `serveStatic` serves `./uploads` back at `/files` with `createFileStat`
  (ETag/Last-Modified → 304 revalidations) and `createFileRangeReader`
  (streamed 206 ranges — seekable, no whole-file buffering) injected.

Routes:

| Route            | Behavior                                                    |
| ---------------- | ----------------------------------------------------------- |
| `POST /upload`   | multipart form → gates → sink; `{ files: [{ id, … }] }`     |
| `GET /files/:id` | the landed file (ETag/304, `Range` → 206)                    |
| `GET /`          | `{ files }` — what has landed (`readdir` of `./uploads`)      |

## Run

```sh
pnpm install
pnpm build          # workspace root once — app.ts imports the built s200 entries
pnpm --filter @s200-example/upload-app start
```

## Try it

```sh
curl -s localhost:3000/upload -F file=@photo.png
# {"files":[{"name":"file","filename":"photo.png","contentType":"image/png",
#            "size":8132,"id":"3f2c….png"}]}

ID=3f2c….png   # the id from above
curl -s localhost:3000/files/$ID -o out.png        # byte-identical
curl -si localhost:3000/files/$ID -H 'Range: bytes=0-7'   # 206
curl -s localhost:3000/                           # listing
```

## Smoke

```sh
pnpm --filter @s200-example/upload-app smoke
# or: cd examples/upload-app && node smoke.ts
```

`smoke.ts` drives the real `app.ts` against the workspace `src/` (via
`../ts-resolve.mjs`, which redirects the public `s200*` entry names) on an
ephemeral port: upload a fake PNG (magic + payload) → byte-exact read-back
→ ETag/304 → `Range`/206 → text part 415 → over-`maxFileSize` 413 →
listing, then closes the server, deletes the `uploads/` directory it
created, and exits 0.
