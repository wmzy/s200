/**
 * SSE ticker + static dashboard — a slice of `s200/streaming` +
 * `serveStatic` over the node adapter's injected file readers.
 *
 * Batteries on show:
 *   - `streamSSE` frames Server-Sent Events with backpressure-aware
 *     writes: one keep-alive heartbeat, five `tick` events ~30 ms apart,
 *     then a `done` event and a normal close (the stream is bounded, so
 *     clients and tests terminate)
 *   - `serveStatic` with the node adapter's `createFileReader`/
 *     `createFileStat` — ETag/Last-Modified + 304s for the dashboard page
 */
import type { App } from 's200';

import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createApp, get, json, use, serveStatic  } from 's200';
import { streamSSE } from 's200/streaming';
import { createFileReader, createFileStat, serve } from 's200/node';

const publicDir = fileURLToPath(new URL('./public', import.meta.url));

export const app: App = createApp();

// The dashboard page (index.html by default); misses fall through to
// next(), so /events and /health below still answer.
use(
  app,
  serveStatic({
    read: createFileReader(publicDir),
    stat: createFileStat(publicDir),
    cacheControl: 'no-cache',
  })
);

// The page pings this once on load — proves plain fetch round-trips too.
get(app, '/health', (ctx) => json(ctx, { ok: true }));

// Bounded SSE ticker: heartbeat → 5 ticks (~30 ms apart) → done → close.
get(app, '/events', (ctx) =>
  streamSSE(ctx, async (writer) => {
    await writer.heartbeat();
    for (let n = 1; n <= 5; n += 1) {
      await writer.writeSSE({ event: 'tick', data: { n, at: Date.now() } });
      if (n < 5) {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    }
    await writer.writeSSE({ event: 'done', data: 'stream complete' });
  })
);

export async function main(): Promise<void> {
  const server = await serve(app, { port: Number(process.env.PORT ?? 3000) });
  console.log(`sse-dashboard listening on ${server.url} — open ${server.url}/ for the dashboard`);
}

// Serve only when executed directly (`node app.ts`), not when smoke.ts
// imports the app to drive it on an ephemeral port.
const entry =
  process.argv[1] === undefined
    ? undefined
    : pathToFileURL(realpathSync(process.argv[1])).href;
if (entry === import.meta.url) {
  await main();
}
