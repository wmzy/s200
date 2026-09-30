/**
 * Cloudflare Workers adapter: the module-worker `fetch` handler shape, one
 * line over `handle`. No platform types needed — the shape is structural.
 *
 * ```ts
 * export default createHandler(app);
 * ```
 *
 * @module
 */

import type { App } from './app';

import { handle } from './app';
import { signalInit } from './signal';

/** The default export shape of a Cloudflare module worker. */
export type WorkerHandler = {
  readonly fetch: (
    request: Request,
    env: Record<string, unknown>,
    ctx: { readonly waitUntil: (promise: Promise<unknown>) => void }
  ) => Promise<Response> | Response;
};

/** Builds the worker's default export for an app. */
export function createHandler(app: App): WorkerHandler {
  return {
    // Workers abort the fetch-handler request's signal on client
    // disconnect — feature-detect it for runtimes whose Request lacks it.
    fetch: (request) => handle(app, request, signalInit(request)),
  };
}
