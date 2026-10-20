// Post-build step: make dist/cli.mjs a runnable bin.
//
// vite's lib build emits it without a shebang, and package.json "bin" points
// here — npm runs bin files through the kernel, so without the interpreter
// line `s200 dev` fails with an exec-format error. Idempotent: skips when the
// banner is already present, chmods +x for direct execution.
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file = resolve(process.cwd(), 'dist/cli.mjs');
const shebang = '#!/usr/bin/env node\n';
const source = readFileSync(file, 'utf8');
if (!source.startsWith('#!/usr/bin/env node')) {
  writeFileSync(file, shebang + source);
}
chmodSync(file, 0o755);
