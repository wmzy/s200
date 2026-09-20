// Prepares the dist tree for JSR publishing: JSR resolves types by
// adjacency (dist/index.mjs + dist/index.d.mts), while the npm package
// ships declarations under dist/types/. Copying the .d.mts tree next to
// the .mjs entries satisfies JSR without touching the npm layout.
import { readdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const from = 'dist/types';
const to = 'dist';
const files = readdirSync(from).filter((f) => f.endsWith('.d.mts'));
for (const file of files) {
  copyFileSync(join(from, file), join(to, file));
}
console.log(`Copied ${files.length} .d.mts files next to dist/*.mjs for JSR`);
