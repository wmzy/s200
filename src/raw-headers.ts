/**
 * Internal header utilities shared across modules so no second copy
 * grows: `rawHeaderPairs` maps node rawHeaders → Web Standard
 * header-init pairs (`s200/node`'s toRequest and the node websocket
 * handshake); `splitList` splits a comma-separated header value into
 * case-preserving tokens (websocket subprotocol negotiation and the
 * trust-proxy forwarding hops), with `splitTokens` as its lowercased
 * variant for token matching (the hop-by-hop `connection` parsing in
 * `s200/proxy` and the websocket handshake's upgrade check);
 * `headerRecordOf` maps a `Headers` object onto the record node's
 * `writeHead` takes (`s200/node`'s plain write path and the shard
 * executor's bridge); `withVary` appends a cache-varying header name
 * without duplicating it (compress, cors, and the version gate's Vary
 * stamps); `unquoteParam` unfolds one quoted header parameter value
 * (accepts' and multipart's shared escape semantics, previously two
 * drifting copies); `splitParams` splits a parameter list on `;`
 * quote-aware so a quoted separator stays data (the same two consumers'
 * shared split); `mediaTypeOf` reads the lowercase media token before
 * the `;` of a content-type-ish header (response-check's JSON test,
 * multipart's boundary dispatch, the lambda adapter's textual test).
 * NOT a public entry — the barrel does not re-export
 * this module; import it relatively from within src.
 *
 * @internal
 */

/**
 * node rawHeaders → `[name, value]` pairs in wire order, pseudo-headers
 * dropped (the Request constructor rejects ':' names). rawHeaders keeps
 * the wire order, so duplicated headers survive as pairs instead of being
 * pre-merged by node's parsed view; http2 compat requests surface
 * ':method'/':path'/… pseudo-headers in it, which must not reach the
 * Headers/Request constructors.
 *
 * @internal
 */
export function rawHeaderPairs(raw: readonly string[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i];
    const value = raw[i + 1];
    if (name === undefined || value === undefined || name.startsWith(':')) {
      continue;
    }
    pairs.push([name, value]);
  }
  return pairs;
}

/**
 * Case-preserving, trimmed, non-empty segments of a comma-separated
 * header value. Subprotocol negotiation needs the original casing (the
 * winning name is echoed back on the 101) and the trust-proxy hop picker
 * must not mangle forwarded values; token matching instead uses
 * {@link splitTokens}, the lowercased variant. Empty segments (a trailing
 * comma) drop out.
 *
 * @internal
 */
export function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/**
 * Lowercased, trimmed, non-empty tokens of a comma-separated header
 * value — the `connection` header's token list (`'keep-alive, Upgrade'` →
 * both names, lowercased), built on {@link splitList}. Empty segments (a
 * trailing comma) drop out.
 *
 * @internal
 */
export function splitTokens(value: string): string[] {
  return splitList(value).map((token) => token.toLowerCase());
}

/**
 * `Headers` → the record node's `writeHead` takes: one entry per name,
 * filling `into` when the caller already owns the record (`s200/node`'s
 * write path) or a fresh one otherwise (the shard executor's bridge).
 * Repeated `set-cookie` stays the array — forEach would collapse it into
 * one comma-joined value, which is not a legal cookie list.
 *
 * @internal
 */
export function headerRecordOf(
  headers: Headers,
  into: Record<string, string | string[]> = {}
): Record<string, string | string[]> {
  headers.forEach((value, key) => {
    into[key] = value;
  });
  const setCookies = headers.getSetCookie();
  if (setCookies.length > 0) {
    into['set-cookie'] = setCookies;
  }
  return into;
}

/**
 * Appends `value` to the Vary header without duplicating it. The
 * comparison lowercases both sides — the entry already in Vary may be
 * any case (`Vary: X-Api-Version` vs the appended `x-api-version`), and
 * a cache-varying header listed twice is still just one key. Shared by
 * compress (`accept-encoding`), cors (`origin`), and the version gate's
 * negotiated header.
 *
 * @internal
 */
export function withVary(headers: Headers, value: string): void {
  const vary = headers.get('vary');
  if (vary === null) {
    headers.set('vary', value);
    return;
  }
  const lowered = value.toLowerCase();
  if (
    !vary.split(',').some((entry) => entry.trim().toLowerCase() === lowered)
  ) {
    headers.set('vary', `${vary}, ${value}`);
  }
}

/**
 * Unfolds one header parameter value: a quoted-string drops its quotes
 * and unfolds backslash escapes (`\"` → `"`, `\<LF>` → LF — the escape
 * character is always consumed, whatever byte follows it); a bare token
 * is returned as-is (trimmed). A trailing lone backslash has nothing left
 * escape and is kept. The k=v loops around it stay per-module: accepts
 * special-cases `q=`; the quote-aware split ({@link splitParams}) and
 * this unfold are shared, so the two cannot drift again.
 *
 * @internal
 */
export function unquoteParam(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    const inner = t.slice(1, -1);
    let out = '';
    for (let i = 0; i < inner.length; i += 1) {
      const c = inner[i] ?? '';
      if (c === '\\' && i + 1 < inner.length) {
        out += inner[i + 1] ?? '';
        i += 1;
      } else {
        out += c;
      }
    }
    return out;
  }
  return t;
}

/**
 * Splits a header parameter list on `;` while honoring quoted strings (a
 * `;` inside quotes is data, not a separator). Backslash escapes inside
 * quotes are carried through verbatim for {@link unquoteParam} to unfold.
 * Accepts' range parsing and multipart's part-header parameters share this
 * one grammar — previously two drifting copies.
 *
 * @internal
 */
export function splitParams(s: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i] ?? '';
    if (quoted) {
      if (c === '\\') {
        current += c + (s[i + 1] ?? '');
        i += 1;
      } else {
        if (c === '"') quoted = false;
        current += c;
      }
    } else if (c === '"') {
      quoted = true;
      current += c;
    } else if (c === ';') {
      out.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  out.push(current);
  return out;
}

/**
 * The lowercase media token of a content-type-ish header value: the bytes
 * before the first `;`, trimmed. null/undefined (an absent header) or an
 * empty/parameters-only value reads as `''` — each caller's absent-header
 * case, kept out of three per-site spellings.
 *
 * @internal
 */
export function mediaTypeOf(header: string | null | undefined): string {
  if (header === null || header === undefined) return '';
  const semi = header.indexOf(';');
  return (semi < 0 ? header : header.slice(0, semi)).trim().toLowerCase();
}
