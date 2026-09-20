/**
 * Content negotiation: `accepts(ctx)` exposes RFC 9110-style matching for
 * `Accept`, `Accept-Encoding`, and `Accept-Language` — q-values,
 * wildcards, prefix ranges, and the §12.4.2 precedence rule (a more
 * specific range overrides a wildcard, including a specific q=0 ban).
 *
 * @module
 */

import type { Ctx } from './types';

type Range = {
  readonly value: string;
  readonly q: number;
};

/**
 * Parses an Accept-family header into `{ value, q }` ranges in header
 * order (order matters: at equal specificity, the earlier range wins).
 * q is clamped to [0, 1]; q=0 ranges stay — they ban candidates.
 */
function parseRanges(header: string | null): Range[] {
  if (header === null) return [];
  const ranges: Range[] = [];
  for (const part of header.split(',')) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const pieces = trimmed.split(';');
    const value = (pieces[0] ?? '').trim().toLowerCase();
    if (value === '') continue;
    let q = 1;
    for (const param of pieces.slice(1)) {
      const kv = param.trim();
      if (kv.toLowerCase().startsWith('q=')) {
        const parsed = Number(kv.slice(2));
        q = Number.isNaN(parsed) ? 1 : Math.min(1, Math.max(0, parsed));
      }
    }
    ranges.push({ value, q });
  }
  return ranges;
}

/** Media-range match: exact, a type followed by slash-star (prefix
 * match), or the two wildcard forms (any-type/any-subtype and bare). */
function mediaMatches(range: string, candidate: string): boolean {
  if (range === '*' || range === '*/*') return true;
  if (range === candidate) return true;
  const slash = range.indexOf('/');
  return (
    slash >= 0 &&
    range.endsWith('/*') &&
    candidate.startsWith(range.slice(0, slash + 1))
  );
}

/** Media specificity: exact (2) > type-prefix (1) > wildcard (0). */
function mediaSpecificity(range: string): number {
  if (range === '*' || range === '*/*') return 0;
  return range.endsWith('/*') ? 1 : 2;
}

/** Language-range match (RFC 4647 basic filtering): exact or a prefix
 * with a `-` subtag boundary — `en` matches `en-US`, never `english`. */
function languageMatches(range: string, candidate: string): boolean {
  if (range === '*') return true;
  if (range === candidate) return true;
  return candidate.startsWith(`${range}-`);
}

/** Language specificity: exact (2) > subtag prefix (1) > `*` (0). */
function languageSpecificity(range: string): number {
  if (range === '*') return 0;
  return range.includes('-') ? 1 : 2;
}

/**
 * The negotiation core: for each provided candidate, the matching range
 * with the highest specificity decides its q (RFC 9110 §12.4.2 — a
 * specific `q=0` ban beats a permissive wildcard). The candidate with the
 * highest q wins; equal q keeps the server's own preference order.
 */
function pick(
  header: string | null,
  provided: readonly string[],
  matches: (range: string, candidate: string) => boolean,
  specificityOf: (range: string) => number
): string | undefined {
  const ranges = parseRanges(header);
  let best: { candidate: string; q: number } | undefined;
  for (const candidate of provided) {
    let decision: { q: number; spec: number } | undefined;
    for (const range of ranges) {
      if (!matches(range.value, candidate.toLowerCase())) continue;
      const spec = specificityOf(range.value);
      if (decision === undefined || spec > decision.spec) {
        decision = { q: range.q, spec };
      }
    }
    if (decision === undefined || decision.q <= 0) continue;
    if (best === undefined || decision.q > best.q) {
      best = { candidate, q: decision.q };
    }
  }
  return best?.candidate;
}

/** Negotiation surface over one request's Accept-family headers. */
export type Accepts = {
  /** Best of `provided` media types; `undefined` when nothing matches. */
  type(provided: readonly string[]): string | undefined;
  /** Best of `provided` content codings per `Accept-Encoding`. */
  encoding(provided: readonly string[]): string | undefined;
  /** Best of `provided` language tags per `Accept-Language`. */
  language(provided: readonly string[]): string | undefined;
};

/**
 * Builds the negotiation helpers for a request. A missing Accept header
 * yields no match — callers pick the default themselves.
 */
export function accepts(ctx: Ctx): Accepts {
  return {
    type(provided) {
      return pick(
        ctx.req.headers.get('accept'),
        provided,
        mediaMatches,
        mediaSpecificity
      );
    },
    encoding(provided) {
      return pick(
        ctx.req.headers.get('accept-encoding'),
        provided,
        mediaMatches,
        mediaSpecificity
      );
    },
    language(provided) {
      return pick(
        ctx.req.headers.get('accept-language'),
        provided,
        languageMatches,
        languageSpecificity
      );
    },
  };
}
