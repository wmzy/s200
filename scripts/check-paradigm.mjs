#!/usr/bin/env node
/**
 * Paradigm gate for src/**: data-and-functions only — no `class`, `this`,
 * `extends`, or `new` of anything but platform/builtin constructors.
 *
 * Strips comments and blanks string-literal contents with a small state
 * machine first: a `//` inside a string is not a comment, and the word
 * "class" inside a literal is prose, not the CLASS syntax.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Web-standard and builtin constructors the framework legitimately
// instantiates. Everything else capitalized after `new` is OUR type —
// forbidden (our data is created by `create*` functions, never `new`).
const PLATFORM_CTORS = new Set([
  'Request',
  'Response',
  'Headers',
  'URL',
  'URLSearchParams',
  'FormData',
  'ReadableStream',
  'WritableStream',
  'TransformStream',
  'CompressionStream',
  'DecompressionStream',
  'AbortController',
  'AbortSignal',
  'Blob',
  'File',
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'EvalError',
  'DOMException',
  'Promise',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Date',
  'RegExp',
  'Array',
  'Object',
  'Uint8Array',
  'Int8Array',
  'Uint16Array',
  'Int16Array',
  'Uint32Array',
  'Int32Array',
  'BigUint64Array',
  'BigInt64Array',
  'Float32Array',
  'Float64Array',
  'ArrayBuffer',
  'SharedArrayBuffer',
  'DataView',
  'TextEncoder',
  'TextDecoder',
  // Language builtin used by src/serialize.ts for startup-time codegen —
  // a schema compiled once is a platform constructor, not an OOP pattern.
  'Function',
  // node:worker_threads builtin (src/executor.ts): the thread executor
  // spawns isolation units with it — a platform facility, same class as
  // Request/Response above, not an OOP pattern in our data surface.
  'Worker',
  // Light-mode platform stand-ins (src/light.ts): class mimics of the
  // platform Request/Response, constructed exactly where the platform
  // constructors would be — the opt-in fast path, not an OOP pattern.
  'LightRequest',
  'LightResponse',
  'LightHeaders',
]);

const RULES = [
  { re: /\bclass\b/, what: 'class' },
  { re: /\bthis\s*\./, what: 'this.' },
  {
    // Generic constraints (`<P extends string>`) and conditional types are
    // part of the frozen API surface — only class/interface INHERITANCE is
    // the paradigm violation.
    re: /\b(?:class|interface)\s+\w+[^{;]*\bextends\b/,
    what: 'extends (inheritance)',
  },
  {
    re: /\bnew\s+([A-Z]\w*)/,
    what: 'new (non-platform constructor)',
    allow: (match) => PLATFORM_CTORS.has(match[1]),
  },
];

/**
 * Blanks comment text and string-literal contents (keeping newlines and
 * non-string code) so violation regexes only ever see real code.
 */
function stripCommentsAndStrings(source) {
  const out = [];
  // Open brace counts per `${` we are inside of, innermost last.
  const templateDepth = [];
  let state = 'code'; // code | line | block | single | double | template
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (state === 'code') {
      if (c === '/' && next === '/') {
        state = 'line';
        out.push('  ');
        i += 2;
      } else if (c === '/' && next === '*') {
        state = 'block';
        out.push('  ');
        i += 2;
      } else if (c === "'") {
        state = 'single';
        out.push(' ');
        i += 1;
      } else if (c === '"') {
        state = 'double';
        out.push(' ');
        i += 1;
      } else if (c === '`') {
        state = 'template';
        out.push(' ');
        i += 1;
      } else if (c === '{' && templateDepth.length > 0) {
        templateDepth[templateDepth.length - 1] += 1;
        out.push(c);
        i += 1;
      } else if (c === '}' && templateDepth.length > 0) {
        if (templateDepth[templateDepth.length - 1] === 0) {
          // Closes the `${` — back inside the template literal text.
          templateDepth.pop();
          state = 'template';
          out.push(' ');
        } else {
          templateDepth[templateDepth.length - 1] -= 1;
          out.push(c);
        }
        i += 1;
      } else {
        out.push(c);
        i += 1;
      }
    } else if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        out.push('\n');
      } else {
        out.push(' ');
      }
      i += 1;
    } else if (state === 'block') {
      if (c === '*' && next === '/') {
        state = 'code';
        out.push('  ');
        i += 2;
      } else {
        out.push(c === '\n' ? '\n' : ' ');
        i += 1;
      }
    } else if (state === 'single' || state === 'double') {
      const quote = state === 'single' ? "'" : '"';
      if (c === '\\') {
        out.push('  ');
        i += 2;
      } else if (c === quote) {
        state = 'code';
        out.push(' ');
        i += 1;
      } else {
        out.push(c === '\n' ? '\n' : ' ');
        i += 1;
      }
    } else {
      // template literal text
      if (c === '\\') {
        out.push('  ');
        i += 2;
      } else if (c === '`') {
        state = 'code';
        out.push(' ');
        i += 1;
      } else if (c === '$' && next === '{') {
        // Interpolation is code — scan it with the code rules.
        state = 'code';
        templateDepth.push(0);
        out.push('  ');
        i += 2;
      } else {
        out.push(c === '\n' ? '\n' : ' ');
        i += 1;
      }
    }
  }
  return out.join('');
}

function listTsFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

const srcDir = new URL('../src', import.meta.url).pathname;
const files = listTsFiles(srcDir).sort();
// The light-mode stand-ins (src/light.ts) are deliberate class mimics of
// the platform's Request/Response — they exist to duck-type the Web
// Standard surface on the opt-in fast path, not to introduce an OOP
// pattern into the framework's data surface. Everything else stays gated.
const PLATFORM_STANDINS = new Set(['light.ts']);
const violations = [];
for (const file of files) {
  if (PLATFORM_STANDINS.has(file.split('/').pop() ?? '')) {
    continue;
  }
  const stripped = stripCommentsAndStrings(readFileSync(file, 'utf8'));
  stripped.split('\n').forEach((line, index) => {
    for (const rule of RULES) {
      const match = rule.re.exec(line);
      if (match && !(rule.allow && rule.allow(match))) {
        violations.push(
          `${file}:${index + 1}: [${rule.what}] ${line.trim()}`
        );
        return;
      }
    }
  });
}

if (violations.length > 0) {
  for (const violation of violations) {
    console.error(violation);
  }
  console.error(`\nparadigm FAILED: ${violations.length} violation(s) in ${files.length} file(s)`);
  process.exit(1);
}

console.log(`paradigm OK: ${files.length} files checked`);
