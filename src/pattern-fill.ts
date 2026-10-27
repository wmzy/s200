/**
 * The one route-pattern fill shared by the typed client (`s200`) and the
 * MCP bridge (`s200/mcp`) — previously two hand-rolled copies that had
 * already diverged on wildcard encoding (the client encoded piecewise,
 * MCP packed the whole value into one segment). Internal module: not
 * part of any package export entry.
 *
 * @internal
 */

import type { Segment } from './types';

/**
 * Fills route segments into a path — pieces joined with one leading `'/'`
 * each, so the root pattern (`[]`) fills to `''` and callers prefix their
 * own base. `valueOf` returns the encoded-ready string for a capture
 * name, or `undefined` when absent: a required capture that is absent
 * makes the whole fill `undefined`; an optional one drops out (no empty
 * piece — `/users/:id?` with no id fills `/users`, not `/users/`).
 */
export function fillSegments(
  segments: readonly Segment[],
  valueOf: (name: string) => string | undefined
): string | undefined {
  const pieces: string[] = [];
  for (const segment of segments) {
    if (segment._tag === 'static') {
      pieces.push(segment.value);
      continue;
    }
    const value = valueOf(segment.name);
    if (value === undefined) {
      if (segment._tag === 'param' && segment.optional) {
        continue;
      }
      return undefined;
    }
    pieces.push(
      // A wildcard value may span segments ('a/b c'): encoding each piece
      // and rejoining on '/' keeps the value's slashes as URL separators —
      // the shape browsers and URL builders produce, and the router decodes
      // it back to the same capture ('a/b%20c' → 'a/b c'). A packed
      // whole-value encode ('a%2Fb%20c') decodes identically but is not
      // the canonical spelling, so both callers share this one policy.
      segment._tag === 'wildcard'
        ? value.split('/').map((piece) => encodeURIComponent(piece)).join('/')
        : encodeURIComponent(value)
    );
  }
  return pieces.map((piece) => `/${piece}`).join('');
}

/**
 * Appends query entries onto a `URLSearchParams`: `undefined` entries are
 * skipped, arrays repeat the key, everything else stringifies. `null` is
 * a caller policy rather than a shared one — the client's loose `query`
 * sugar stringifies it (`String(null)` → `'null'`, like any plain value),
 * while MCP skips it alongside `undefined`; `skipNull: true` adopts the
 * skip.
 */
export function appendQuery(
  search: URLSearchParams,
  entries: Iterable<readonly [string, unknown]>,
  options?: { readonly skipNull?: boolean }
): void {
  const skipNull = options?.skipNull ?? false;
  for (const [name, value] of entries) {
    if (value === undefined || (skipNull && value === null)) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        search.append(name, String(item));
      }
    } else {
      search.append(name, String(value));
    }
  }
}
