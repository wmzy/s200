/**
 * Config battery: typed, fail-fast configuration in the spirit of NestJS's
 * `@nestjs/config`, zero-dependency. Any Standard Schema vendor (zod,
 * valibot, typebox, a hand-rolled check) supplies both the compile-time
 * shape and the runtime gate through the same `~standard` channel
 * `s200/validate` already speaks — no second protocol.
 *
 * - {@link parseEnv} turns `.env` file text into a plain string record;
 * - {@link createConfig} validates raw input once, at construction:
 *   misconfiguration fails the boot with a single aggregated `Error`,
 *   not the first request. On success the returned `valid` carries the
 *   schema's OUTPUT type, which is where env-string coercion pays off —
 *   see {@link createConfig}'s input/output example.
 *
 * @module
 */

import type { OutputOf, StandardIssue, StandardSchema } from './validate';

import { formatIssuePath } from './validate';

/** The product of {@link createConfig}: `valid` is the schema's parsed,
 * typed output — the only handle callers get, and only after the
 * fail-fast gate has passed. */
export type Config<S extends StandardSchema> = { readonly valid: OutputOf<S> };

/** Double-quote escapes a `.env` file honors: control chars plus the two
 * characters that would otherwise end the value. Any other `\x` pair is
 * kept verbatim (backslash included) so Windows paths stay intact. */
const DOUBLE_ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  r: '\r',
  t: '\t',
  '"': '"',
  '\\': '\\',
};

/**
 * Reads a quoted value starting at `text[0]` (the opening quote) and
 * returns its content; whatever follows the closing quote on that line is
 * ignored. Double quotes honor {@link DOUBLE_ESCAPES}; single quotes are
 * literal (a backslash is just a backslash). A quote that never closes on
 * its own line is malformed — multi-line values are unsupported: strict
 * mode (the default) throws, lenient mode returns `undefined` so the
 * caller skips the line.
 */
function readQuoted(
  text: string,
  quote: '"' | "'",
  lineNo: number,
  rawLine: string,
  lenient: boolean
): string | undefined {
  let value = '';
  for (let i = 1; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === quote) {
      return value;
    }
    if (quote === '"' && ch === '\\') {
      const next = text.charAt(i + 1);
      const mapped = DOUBLE_ESCAPES[next];
      if (mapped !== undefined) {
        value += mapped;
        i++;
      } else if (next !== '') {
        value += ch + next;
        i++;
      } else {
        value += ch; // lone trailing backslash: falls through to unterminated
      }
      continue;
    }
    value += ch;
  }
  if (lenient) {
    return undefined; // caller drops the line, dotenv-style
  }
  throw new Error(
    `unterminated ${quote === '"' ? 'double' : 'single'} quote on .env line ${String(lineNo + 1)}: ${rawLine}`
  );
}

/**
 * Index of the `#` that starts a trailing comment on an unquoted value:
 * only one at the very start of the value or preceded by whitespace
 * counts (`a#b` is a value, `a # b` has a comment). `-1` when none.
 */
function commentIndex(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text.charAt(i) === '#' && (i === 0 || /\s/.test(text.charAt(i - 1)))) {
      return i;
    }
  }
  return -1;
}

/**
 * Minimal `.env` parser: `KEY=value` per line, values as strings.
 *
 * Supported:
 * - blank lines and `#` comments, whole-line or trailing an unquoted
 *   value (a `#` inside quotes is data, and `a#b` stays `a#b`);
 * - an `export ` prefix (stripped; `export=1` is still the key `export`);
 * - double-quoted values with `\n` `\r` `\t` `\"` `\\` escapes (unknown
 *   escapes keep their backslash) and single-quoted values, fully
 *   literal; unquoted values are trimmed of surrounding whitespace;
 * - CRLF and LF line endings; a duplicate key wins with its last value.
 *
 * NOT supported: multi-line values — a quote must close on its own line,
 * and the whole of anything after a closing quote on the same line is
 * ignored (`K="v" # note` is just `v`).
 *
 * Malformed input is a programmer error, so by default it throws one
 * `Error` (with a 1-based line number and the offending line) instead of
 * silently skipping: a line without `=`, an empty key, whitespace inside
 * a key, or an unterminated quote. Pass `{ lenient: true }` to skip those
 * lines instead — dotenv leniency for files the program didn't author
 * (the mode `s200 dev --env-file` reads user dotenv files in): the
 * malformed line is dropped and every well-formed line around it still
 * parses.
 */
export function parseEnv(
  text: string,
  options?: { readonly lenient?: boolean }
): Record<string, string> {
  const lenient = options?.lenient === true;
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] as string;
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    // Only a real `export ` prefix (whitespace after); `export=1` is the
    // key named export, and a bare `export` falls through to "no =".
    const body =
      line.startsWith('export') && /\s/.test(line.charAt(6))
        ? line.slice(6).trimStart()
        : line;
    const eq = body.indexOf('=');
    const key = eq < 1 ? undefined : body.slice(0, eq).trim();
    // -1: no separator; 0: nothing before it; empty or whitespace key.
    if (key === undefined || key === '' || /\s/.test(key)) {
      if (lenient) {
        continue; // dotenv-style: skip the malformed line, keep the rest
      }
      throw new Error(`invalid .env line ${String(i + 1)}: ${rawLine}`);
    }
    const value = body.slice(eq + 1).trimStart();
    const quote = value.charAt(0);
    if (quote === '"' || quote === "'") {
      const quoted = readQuoted(value, quote, i, rawLine, lenient);
      // `undefined` only in lenient mode (unterminated quote): the line
      // is skipped rather than stored with a half-read value.
      if (quoted !== undefined) {
        out[key] = quoted;
      }
      continue;
    }
    const hash = commentIndex(value);
    out[key] = (hash === -1 ? value : value.slice(0, hash)).trim();
  }
  return out;
}

/** Formats every issue into the single message {@link createConfig}
 * throws: one line each, {@link formatIssuePath}-formatted path first
 * when the issue carries one (object keys dotted, array indices
 * bracketed). */
function formatIssues(issues: readonly StandardIssue[]): string {
  const lines = issues.map((issue) => {
    const path = formatIssuePath(issue.path);
    return path === '' ? issue.message : `${path}: ${issue.message}`;
  });
  return `config invalid:\n  ${lines.join('\n  ')}`;
}

/**
 * Validates `input` against a Standard Schema once, at construction — the
 * equivalent of NestJS's `validate(config)` bootstrap gate. This is the
 * same `~standard.validate` call `standardValidate` makes, but for CLI
 * eyes it aggregates ALL issues into one thrown multi-line `Error`
 * instead of a 422 `HttpError` body:
 *
 * ```text
 * config invalid:
 *   PORT: expected number, got "abc"
 *   db.url: required
 * ```
 *
 * On success the returned `valid` is the schema's parsed output, typed by
 * the schema's phantom `types` prop. Env sources hand you strings, so the
 * shape that pays off declares an input of strings and an output of the
 * coerced values:
 *
 * ```ts
 * const envSchema = v.object({
 *   PORT: v.pipe(v.string(), v.transform(Number)),   // string in, number out
 *   VERBOSE: v.pipe(v.string(), v.transform((s) => s === 'true')),
 * });
 * const { valid } = createConfig(envSchema, parseEnv(envText));
 * valid.PORT; // number at compile time, coerced once at boot
 * ```
 *
 * An empty `issues` array counts as success, exactly as in
 * `s200/validate`.
 */
export function createConfig<S extends StandardSchema>(
  schema: S,
  input: Record<string, unknown>
): Config<S> {
  const result = schema['~standard'].validate(input);
  const issues = result.issues ?? [];
  if (issues.length > 0) {
    throw new Error(formatIssues(issues));
  }
  return { valid: result.value as OutputOf<S> };
}
