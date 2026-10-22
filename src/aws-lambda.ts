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
import { hasFinishers, runFinish } from './finish';

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
  readonly body?: string;
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

/** Builds the v2 `Request`: method from the http context, URL from the
 * `host` header (falling back to `localhost`) plus the raw path/query, and
 * the split `cookies` array recomposed into the single `Cookie` header the
 * Web Standard side expects. Bodies are fully buffered here (string or
 * bytes), so the `Request` never wraps a stream — no duplex hop. */
function toRequest(event: LambdaEventV2): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers)) {
    headers.set(name, value);
  }
  if (event.cookies !== undefined && event.cookies.length > 0) {
    headers.set('cookie', event.cookies.join('; '));
  }
  const host = event.headers['host'] ?? 'localhost';
  const url =
    event.rawQueryString === ''
      ? `https://${host}${event.rawPath}`
      : `https://${host}${event.rawPath}?${event.rawQueryString}`;
  const body =
    event.body === undefined
      ? undefined
      : event.isBase64Encoded
        ? Buffer.from(event.body, 'base64')
        : event.body;
  return new Request(url, {
    method: event.requestContext.http.method,
    headers,
    body,
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
  const media = ((headers['content-type'] ?? '').split(';', 1)[0] ?? '')
    .trim()
    .toLowerCase();
  return (
    media === '' ||
    media.startsWith('text/') ||
    media === 'application/json' ||
    media.endsWith('+json') ||
    media === 'application/javascript' ||
    media === 'application/xml' ||
    media.endsWith('+xml') ||
    media === 'application/x-www-form-urlencoded'
  );
}

/** Buffers the `Response` into the v2 result. Spec header iteration merges
 * duplicates with `", "` but yields each `set-cookie` separately — exactly
 * the split the v2 result wants (`cookies` array vs flat record). */
async function toResult(response: Response): Promise<LambdaResultV2> {
  const headers: Record<string, string> = {};
  const cookies: string[] = [];
  for (const [name, value] of response.headers) {
    if (name === 'set-cookie') {
      cookies.push(value);
    } else {
      headers[name] = value;
    }
  }
  const head = {
    statusCode: response.status,
    headers,
    ...(cookies.length > 0 ? { cookies } : {}),
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
    try {
      const result = await toResult(response);
      if (hasFinishers(request)) {
        runFinish(request, { aborted: false }, app.logError);
      }
      return result;
    } catch (error) {
      if (hasFinishers(request)) {
        runFinish(request, { aborted: true }, app.logError);
      }
      throw error;
    }
  };
}
