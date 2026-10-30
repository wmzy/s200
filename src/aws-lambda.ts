/**
 * AWS Lambda adapter for API Gateway HTTP APIs and function URLs (payload
 * format v2): the event becomes a Web Standard `Request`, the response is
 * buffered back into the v2 result — no @types/aws-lambda dependency, the
 * shapes are structural.
 *
 * ```ts
 * export const handler = createLambdaHandler(app);
 * ```
 *
 * @module
 */

import type { App } from './app';

import { handle } from './app';
import { finishGuarded } from './finish';
import { headerRecordOf, isJsonMedia, mediaTypeOf } from './raw-headers';
import { isSafeHost } from './safe-host';

/** An API Gateway HTTP API (payload v2) event — the structural subset the
 * adapter reads. Real events carry more (`routeKey`, `requestContext`
 * neighbors, …); they pass through unused. */
export type LambdaEventV2 = {
  readonly version: string;
  readonly routeKey: string;
  readonly rawPath: string;
  readonly rawQueryString: string;
  /** v2 lowercases every name. */
  readonly headers: Readonly<Record<string, string>>;
  readonly cookies?: readonly string[];
  readonly isBase64Encoded: boolean;
  /** Absent, `null` and `''` all mean "no body" — v2 sends `null` for
   * bodyless GETs. */
  readonly body?: string | null;
  readonly requestContext: {
    readonly http: { readonly method: string; readonly sourceIp: string };
  };
};

/** The payload v2 result: `cookies` carries each `Set-Cookie` separately
 * (never merged into `headers`), `body` is base64 exactly when
 * `isBase64Encoded` is `true`, and null-body responses (204/304, …) carry
 * no `body` at all. */
export type LambdaResultV2 = {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly cookies?: readonly string[];
  readonly isBase64Encoded: boolean;
  readonly body?: string;
};

/** The handler Lambda invokes. `context` is part of the platform's call
 * shape — the adapter accepts and ignores it (the v2 result wants nothing
 * from it). */
export type LambdaHandler = (
  event: LambdaEventV2,
  context?: unknown
) => Promise<LambdaResultV2>;

/** The request URL: `https://` plus the validated host and the raw
 * path/query, both passed through un-re-encoded. Host validation is the
 * shared `isSafeHost` (safe-host.ts) — the same allowlist-plus-URL-parse
 * gate `src/node.ts`'s toRequest uses, without dragging node-only code
 * into the Lambda bundle. */
function requestUrl(event: LambdaEventV2): string {
  const suffix =
    event.rawQueryString === ''
      ? event.rawPath
      : `${event.rawPath}?${event.rawQueryString}`;
  const host = event.headers['host'];
  return isSafeHost(host)
    ? `https://${host}${suffix}`
    : `https://localhost${suffix}`;
}

/** The request body: `undefined` for an absent, `null` or empty payload,
 * and for GET/HEAD whatever the platform delivered — a `Request` rejects
 * a body on either method. Real payloads keep the base64 decoding. */
function requestBody(
  event: LambdaEventV2,
  method: string
): BodyInit | undefined {
  const body = event.body;
  if (body === undefined || body === null || body === '') return undefined;
  const upper = method.toUpperCase();
  if (upper === 'GET' || upper === 'HEAD') return undefined;
  return event.isBase64Encoded ? Buffer.from(body, 'base64') : body;
}

/** Builds the v2 `Request`: method from the http context, URL from the
 * validated `host` header (falling back to `localhost`) plus the raw
 * path/query, and the split `cookies` array recomposed into the single
 * `Cookie` header the Web Standard side expects. Bodies are fully
 * buffered here (string or bytes), so the `Request` never wraps a stream
 * — no duplex hop; a body on GET/HEAD (or an empty one) is dropped
 * rather than rejected. */
function toRequest(event: LambdaEventV2): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers)) {
    headers.set(name, value);
  }
  if (event.cookies !== undefined && event.cookies.length > 0) {
    headers.set('cookie', event.cookies.join('; '));
  }
  const method = event.requestContext.http.method;
  return new Request(requestUrl(event), {
    method,
    headers,
    body: requestBody(event, method),
  });
}

/** Whether the body can travel the JSON result as UTF-8 text: the types
 * API Gateway round-trips untouched, and no content-encoding — the
 * compress battery's gzip turns text types binary. An absent
 * content-type reads as text. */
function isTextual(headers: Record<string, string>): boolean {
  const encoding = (headers['content-encoding'] ?? '').trim().toLowerCase();
  if (encoding !== '' && encoding !== 'identity') {
    return false;
  }
  const media = mediaTypeOf(headers['content-type']);
  return (
    media === '' ||
    media.startsWith('text/') ||
    isJsonMedia(headers['content-type']) ||
    media === 'application/javascript' ||
    media === 'application/xml' ||
    media.endsWith('+xml') ||
    media === 'application/x-www-form-urlencoded'
  );
}

/** Buffers the `Response` into the v2 result. The shared `headerRecordOf`
 * already produces the exact split the v2 result wants — every name as
 * the combined flat string except `set-cookie`, kept as the array and
 * lifted into `cookies` (never comma-merged into the record). */
async function toResult(response: Response): Promise<LambdaResultV2> {
  const record = headerRecordOf(response.headers);
  const cookies = record['set-cookie'] as string[] | undefined;
  delete record['set-cookie'];
  // Only `set-cookie` was ever the array, and it just left the record —
  // every surviving value is a combined string.
  const headers = record as Record<string, string>;
  const head = {
    statusCode: response.status,
    headers,
    ...(cookies !== undefined ? { cookies } : {}),
  };
  if (response.body === null) {
    return { ...head, isBase64Encoded: false };
  }
  const textual = isTextual(headers);
  return {
    ...head,
    isBase64Encoded: !textual,
    body: textual
      ? await response.text()
      : Buffer.from(await response.arrayBuffer()).toString('base64'),
  };
}

/** Builds the Lambda handler for an app — export it as `handler` and point
 * the function (function URL or HTTP API integration) at `file.handler`.
 * Payload format v2 only; the v1 REST API event shape is not supported. */
export function createLambdaHandler(app: App): LambdaHandler {
  return async (event) => {
    const request = toRequest(event);
    const response = await handle(app, request);
    // The result fully buffers the response before Lambda sees it — finish
    // callbacks run at buffer time, completed unless the body itself
    // failed mid-read.
    return finishGuarded(request, app.logError, () => toResult(response));
  };
}
