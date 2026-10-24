/**
 * Smoke test for hello-world — drives the real app.ts against the
 * workspace `src/` (via ../ts-resolve.mjs) on an ephemeral port.
 *
 * Run: node smoke.ts — exits 0 when every check passes.
 */
import '../ts-resolve.mjs';

const { app } = await import('./app.ts');
const { serve } = await import('s200/node');

let failures = 0;
const check = (name: string, ok: boolean, detail?: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${detail ?? ''}`}`);
  if (!ok) failures += 1;
};

const server = await serve(app, { port: 0 });
try {
  const res = await fetch(server.url);
  check('GET / → 200', res.status === 200);
  check('body is the JSON payload', ((await res.json()) as { hello?: string }).hello === 'world');
  check('middleware stamped x-powered-by', res.headers.get('x-powered-by') === 's200');
} finally {
  await server.close();
  check('server closed (no longer listening)', server.server.listening === false);
}

process.exit(failures === 0 ? 0 : 1);
