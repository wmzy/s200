/**
 * Vercel adapter: the Edge Runtime and Node.js (Fluid Compute) web handler
 * is the plain Web Standard shape — `(request) => Response` — so this is
 * `handle` under the platform's entry name, carrying the same signal and
 * finish wiring as the other edge adapters.
 *
 * ```ts
 * export default createVercelHandler(app);
 * ```
 *
 * @module
 */

import type { App } from './app';

import { handle } from './app';
import { hasFinishers, trackFinish } from './finish';
import { signalInit } from './signal';

/** The web-handler shape Vercel invokes — `export default` it from a file
 * under `api/`. */
export type VercelHandler = (request: Request) => Promise<Response>;

/** Builds the web handler for an app. */
export function createVercelHandler(app: App): VercelHandler {
  return (request) =>
    // The runtime's request signal (client disconnect on the Edge Runtime)
    // threads into ctx.signal — feature-detected, absent signals fall back
    // to the shared never-aborted default. No write-completion event
    // exists, so onFinish rides the response body when callbacks exist,
    // as on Cloudflare Workers: cancel → aborted, completion → finished.
    handle(app, request, signalInit(request)).then((response) =>
      hasFinishers(request)
        ? trackFinish(request, response, app.logError)
        : response
    );
}
