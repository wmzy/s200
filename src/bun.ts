import type { App } from './app';

import { join } from 'node:path';

import { handle } from './app';

// Module-scoped ambient surface of the global Bun runtime — exactly the
// members used, so tsc needs no @types/bun dependency (the real Bun global
// provides them at runtime).
declare const Bun: {
  serve(options: {
    port?: number;
    hostname?: string;
    fetch: (request: Request) => Response | Promise<Response>;
  }): { port: number; stop: (closeActiveConnections?: boolean) => void | Promise<void> };
  file(path: string): { exists(): Promise<boolean>; arrayBuffer(): Promise<ArrayBuffer> };
};

export type BunServer = { url: string; port: number; close(): Promise<void> };

export function serve(app: App, options?: { port?: number; hostname?: string }): BunServer {
  const server = Bun.serve({
    port: options?.port ?? 0,
    hostname: options?.hostname,
    fetch: (request: Request): Promise<Response> => handle(app, request),
  });
  return {
    url: `http://localhost:${server.port}`,
    port: server.port,
    close: async (): Promise<void> => {
      // stop(true) also drops in-flight connections, so close resolves now
      // instead of after every open response finishes.
      await server.stop(true);
    },
  };
}

export function createFileReader(root: string): (path: string) => Promise<Uint8Array | null> {
  return async (path: string): Promise<Uint8Array | null> => {
    const file = Bun.file(join(root, path));
    if (!(await file.exists())) return null;
    return new Uint8Array(await file.arrayBuffer());
  };
}
