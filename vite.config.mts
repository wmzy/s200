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
      // and bun entries import nothing runtime-specific.
      external: [/^node:/],
    },
    sourcemap: true,
  },
  resolve: {
    alias: {
      '@': resolve(dirname, 'src'),
    },
  },
});
