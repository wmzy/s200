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
  'AbortController',
  'AbortSignal',
  'Blob',
  'File',
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'EvalError',
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
const violations = [];
for (const file of files) {
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
