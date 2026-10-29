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
 * stamps). NOT a public entry — the barrel does not re-export
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
