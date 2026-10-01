import { fileURLToPath } from 'node:url';

import { resolve } from 'node:path';

import { defineConfig } from 'vite';

const dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  build: {
    reportCompressedSize: true,
    lib: {
      // All entries share one build so rollup emits the shared core
      // (router/compose/app/...) as a single chunk: s200 and s200/node then
      // reference the SAME module-level symbols — self-contained per-entry
      // bundles would duplicate the core and split identities across
      // entries (same rationale as fetch-fun's index/openapi pairing).
      entry: {
        index: resolve(dirname, 'src/index.ts'),
        node: resolve(dirname, 'src/node.ts'),
        bun: resolve(dirname, 'src/bun.ts'),
        cors: resolve(dirname, 'src/cors.ts'),
        logger: resolve(dirname, 'src/logger.ts'),
        'route-table': resolve(dirname, 'src/route-table.ts'),
        cookies: resolve(dirname, 'src/cookies.ts'),
        validate: resolve(dirname, 'src/validate.ts'),
        'rate-limit': resolve(dirname, 'src/rate-limit.ts'),
        compress: resolve(dirname, 'src/compress.ts'),
        streaming: resolve(dirname, 'src/streaming.ts'),
        'request-id': resolve(dirname, 'src/request-id.ts'),
        timeout: resolve(dirname, 'src/timeout.ts'),
        query: resolve(dirname, 'src/query.ts'),
        websocket: resolve(dirname, 'src/websocket.ts'),
        'websocket-node': resolve(dirname, 'src/websocket-node.ts'),
        'websocket-bun': resolve(dirname, 'src/websocket-bun.ts'),
        etag: resolve(dirname, 'src/etag.ts'),
        'secure-headers': resolve(dirname, 'src/secure-headers.ts'),
        auth: resolve(dirname, 'src/auth.ts'),
        accepts: resolve(dirname, 'src/accepts.ts'),
        serialize: resolve(dirname, 'src/serialize.ts'),
        client: resolve(dirname, 'src/client.ts'),
        csrf: resolve(dirname, 'src/csrf.ts'),
        jwt: resolve(dirname, 'src/jwt.ts'),
        cache: resolve(dirname, 'src/cache.ts'),
        'trust-proxy': resolve(dirname, 'src/trust-proxy.ts'),
        meta: resolve(dirname, 'src/meta.ts'),
        openapi: resolve(dirname, 'src/openapi.ts'),
        deno: resolve(dirname, 'src/deno.ts'),
        cloudflare: resolve(dirname, 'src/cloudflare.ts'),
        otel: resolve(dirname, 'src/otel.ts'),
        codegen: resolve(dirname, 'src/codegen.ts'),
        test: resolve(dirname, 'src/test.ts'),
        multipart: resolve(dirname, 'src/multipart.ts'),
        session: resolve(dirname, 'src/session.ts'),
        swagger: resolve(dirname, 'src/swagger.ts'),
        upload: resolve(dirname, 'src/upload.ts'),
        dev: resolve(dirname, 'src/dev.ts'),
        lifecycle: resolve(dirname, 'src/lifecycle.ts'),
        health: resolve(dirname, 'src/health.ts'),
        config: resolve(dirname, 'src/config.ts'),
        schedule: resolve(dirname, 'src/schedule.ts'),
        events: resolve(dirname, 'src/events.ts'),
        version: resolve(dirname, 'src/version.ts'),
      },
      name: 's200',
      formats: ['es', 'cjs'],
      // Use real ESM/CJS extensions so Node resolves each bundle with the
      // correct module kind (a ".js" ESM file would masquerade as CJS).
      fileName: (format, entryName) =>
        `${entryName}.${format === 'es' ? 'mjs' : 'cjs'}`,
    },
    rollupOptions: {
      // node: builtins stay external in the node adapter entry; the core
      // and bun entries import nothing runtime-specific. The events
      // battery's @for-fun/event-emitter stays external too — a real
      // dependency is never bundled into a library build.
      external: [/^node:/, /^@for-fun\//],
    },
    sourcemap: true,
  },
  resolve: {
    alias: {
      '@': resolve(dirname, 'src'),
    },
  },
});
