/**
 * Internal node rawHeaders → Web Standard header-init mapping shared by
 * the node adapter (`s200/node`'s toRequest) and the node websocket
 * handshake (`s200/websocket/node`). NOT a public entry — the barrel does
 * not re-export this module; import it relatively from within src.
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
