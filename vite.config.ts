import { resolve } from 'path';

import { defineConfig } from 'vite';

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
        index: resolve(__dirname, 'src/index.ts'),
        node: resolve(__dirname, 'src/node.ts'),
        bun: resolve(__dirname, 'src/bun.ts'),
        cors: resolve(__dirname, 'src/cors.ts'),
        logger: resolve(__dirname, 'src/logger.ts'),
        'route-table': resolve(__dirname, 'src/route-table.ts'),
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
      '@': resolve(__dirname, 'src'),
    },
  },
});
