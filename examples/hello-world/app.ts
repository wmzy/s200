/** hello-world — the smallest s200 app: one middleware, one route. */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { createApp, get, json, use } from 's200';
import { serve } from 's200/node';

export const app = createApp();
use(app, async (ctx, next) => {
  await next();                     // ctx.res exists here, always — 500s included
  ctx.res?.headers.set('x-powered-by', 's200');
});
get(app, '/', (ctx) => json(ctx, { hello: 'world' }));

export async function main(): Promise<void> {
  const server = await serve(app, { port: Number(process.env.PORT ?? 3000) });
  console.log(`hello-world listening on ${server.url}`);
}
const entry = process.argv[1]; // serve only when executed directly (`node app.ts`)
if (entry !== undefined && pathToFileURL(realpathSync(entry)).href === import.meta.url) await main();
