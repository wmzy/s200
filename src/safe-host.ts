/**
 * Internal Host(-like) header validation shared by the URL-building
 * adapters (`s200/node`'s toRequest, `s200/aws-lambda`'s requestUrl) so a
 * crafted Host cannot pollute the parsed request URL. NOT a public entry —
 * the barrel does not re-export this module; import it relatively from
 * within src (the module is runtime-free, so the Lambda bundle stays
 * clean of node-only code).
 *
 * @internal
 */

/** Host(-like) header characters that are legal inside an `http(s)://`
 * authority: alphanumerics, `.`, `-`, `:` (port), `[`/`]` (IPv6 literals).
 * A crafted Host — `evil.com/a`, `a b`, `u@h`, `x#y`, percent-escapes, or
 * an empty value — must not flow into the request URL: it could pollute
 * the parsed pathname or make the URL unparseable. */
const SAFE_HOST = /^[A-Za-z0-9.[\]:-]+$/;

/**
 * Whether a Host(-like) header is safe to interpolate into a URL
 * authority. {@link SAFE_HOST} keeps the path/query delimiters out, and
 * the URL parser rejects what the character set still admits but cannot
 * parse (`[`, a port above 65535, leading-zero IPv4 labels) — `new URL` /
 * `new Request` would throw on those and turn one crafted header into a
 * 500 (or a reset socket). An absent or unsafe host makes the caller fall
 * back to `localhost`.
 *
 * @internal
 */
export function isSafeHost(host: string | undefined): host is string {
  return (
    host !== undefined &&
    SAFE_HOST.test(host) &&
    URL.canParse(`https://${host}/`)
  );
}
