/**
 * Deno adapter: `handle` is already a Deno-shaped handler, so this is the
 * thinnest possible layer — type it against a minimal ambient `Deno`
 * surface instead of pulling `@types/deno`.
 *
 * ```ts
 * const server = serve(app, { port: 8000 });
 * await server.finished;
 * ```
 *
 * @module
 */

import type { App } from './app';

import { handle } from './app';
import { signalInit } from './signal';

// Module-scoped ambient surface of the global Deno runtime — exactly the
// members used, so tsc needs no @types/deno dependency (the real Deno
// global provides them at runtime). Same pattern as s200/bun's `Bun`.
declare const Deno: {
  serve(
    options: {
      readonly port?: number;
      readonly hostname?: string;
      readonly onListen?: (addr: { readonly port: number; readonly hostname: string }) => void;
    },
    handler: (request: Request) => Promise<Response> | Response
  ): { readonly finished: Promise<void>; readonly shutdown: () => Promise<void> };
};

export type DenoServer = {
  /** The `Deno.serve` instance — `finished` resolves when the server stops. */
  server: { readonly finished: Promise<void>; readonly shutdown: () => Promise<void> };
  url: string;
  port: number;
  close(): Promise<void>;
};

export type DenoServeOptions = {
  port?: number;
  hostname?: string;
  onListen?: (addr: { readonly port: number; readonly hostname: string }) => void;
};

/** Serves the app on Deno. The port is fixed at construction — pass `0`?
 * Deno does not report an ephemeral port, so pick one explicitly. */
export function serve(app: App, options: DenoServeOptions = {}): DenoServer {
  const port = options.port ?? 8000;
  const hostname = options.hostname ?? '0.0.0.0';
  const server = Deno.serve(
    { port, hostname, onListen: options.onListen },
    // Deno aborts the fetch-handler request's signal on client disconnect —
    // feature-detect it, since older builds hand out signal-less requests.
    (request) => handle(app, request, signalInit(request))
  );
  return {
    server,
    url: `http://${hostname === '0.0.0.0' ? '127.0.0.1' : hostname}:${port}`,
    port,
    close: () => server.shutdown(),
  };
}
