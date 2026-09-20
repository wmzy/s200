import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.ts'],
    exclude: ['test/setup.ts'],
    setupFiles: ['./test/setup.ts'],
  },
});
