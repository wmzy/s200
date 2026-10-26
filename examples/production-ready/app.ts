/**
 * Production-ready service — the operations layer a real deployment wraps
 * around even a tiny API.
 *
 * Batteries on show:
 *   - `parseEnv` + `createConfig` (s200/config): an optional `.env` file
 *     merged UNDER process env, validated once at import — a bad deploy
 *     dies with the FULL issue list, not the first
 *   - `health`/`readiness`/`createGate` (s200/health): liveness has zero
 *     dependencies; readiness reports the drain gate, so probes answer
 *     503 from the first drain step — before any socket closes
 *   - `createScheduler` (s200/schedule): an interval sweep pruning the
 *     last-seen registry; `stop()` awaits any in-flight run via the
 *     shutdown hooks
 *   - `lifecycle` (s200/lifecycle): SIGTERM/SIGINT → gate first, then
 *     drain in-flight requests within the budget, then `onShutdown`
 *     hooks in registration order
 *   - `requestId` + `logger`: one correlated line per request
 *
 * Env (all optional, validated at boot): PORT (default 3000, 1-65535),
 * TITLE (default 'production-ready', non-blank), SLOW_MS (default 750),
 * SWEEP_MS (default 30000), DRAIN_MS (default 10000).
 */
import type { App, Middleware } from 's200';
import type { StandardIssue, StandardSchema } from 's200/validate';

import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { createApp, get, json, use } from 's200';
import { createConfig, parseEnv } from 's200/config';
import { createGate, health, readiness } from 's200/health';
import { lifecycle } from 's200/lifecycle';
import { logger } from 's200/logger';
import { serve } from 's200/node';
import { requestId } from 's200/request-id';
import { createScheduler } from 's200/schedule';

declare module 's200' {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- must be an interface: declaration merging (koa's DefaultState pattern) only extends interfaces
  interface State {
    /** Stamped by `requestId` ahead of every handler below. */
    requestId: string;
  }
}

/** The typed config every route and `main()` close over. */
type Env = {
  readonly PORT: number;
  readonly TITLE: string;
  readonly SLOW_MS: number;
  readonly SWEEP_MS: number;
  readonly DRAIN_MS: number;
};

const DEFAULTS: Readonly<Record<keyof Env, string>> = {
  PORT: '3000',
  TITLE: 'production-ready',
  SLOW_MS: '750',
  SWEEP_MS: '30000',
  DRAIN_MS: '10000',
};

/**
 * Hand-rolled Standard Schema for the env reality: strings in (what
 * `parseEnv` and `process.env` hand you), coerced values out — s200 only
 * calls `~standard.validate`, so the example stays dependency-free.
 */
const envSchema: StandardSchema<Env> = {
  '~standard': {
    version: 1,
    vendor: 's200-example',
    validate: (value) => {
      const record = (
        typeof value === 'object' && value !== null ? value : {}
      ) as Record<string, unknown>;
      const issues: StandardIssue[] = [];
      const digits = (key: keyof Env, min: number, max: number): number => {
        const raw = record[key];
        const text = raw === undefined || raw === '' ? DEFAULTS[key] : String(raw);
        if (!/^\d+$/.test(text)) {
          issues.push({ message: `expected digits, got ${JSON.stringify(text)}`, path: [key] });
          return 0;
        }
        const parsed = Number(text);
        if (parsed < min || parsed > max) {
          issues.push({ message: `expected ${String(min)}-${String(max)}, got ${text}`, path: [key] });
        }
        return parsed;
      };
      const rawTitle = record['TITLE'];
      const title = rawTitle === undefined || rawTitle === '' ? DEFAULTS.TITLE : String(rawTitle);
      if (title.trim() === '') {
        issues.push({ message: 'expected a non-blank title', path: ['TITLE'] });
      }
      const coerced: Env = {
        PORT: digits('PORT', 1, 65535),
        TITLE: title,
        SLOW_MS: digits('SLOW_MS', 1, 60_000),
        SWEEP_MS: digits('SWEEP_MS', 1, 3_600_000),
        DRAIN_MS: digits('DRAIN_MS', 1, 120_000),
      };
      if (issues.length > 0) {
        return { issues };
      }
      return { value: coerced };
    },
  },
};

/** Optional `.env` layer: present → parsed and merged under process env;
 * absent (ENOENT) → empty. Anything else (permissions, …) still throws. */
const readEnvFile = async (): Promise<string> => {
  try {
    return await readFile('.env', 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return '';
    }
    throw error;
  }
};

// Fail fast: a bad deploy dies here, at import time, with every issue.
const envText = await readEnvFile();
const { valid: config } = createConfig(envSchema, {
  ...parseEnv(envText),
  ...process.env,
});

/** The readiness half of the drain — `lifecycle` flips it closed with
 * 'draining' before touching a single socket. Exported so smoke.ts can
 * trip it deterministically in-process. */
export const gate = createGate();

/** Last-seen stamps per request id — what the scheduler's sweep prunes. */
const lastSeen = new Map<string, number>();

let sweeps = 0;

/** Feeds the registry: one stamp per request, after `requestId` set it. */
const trackLastSeen: Middleware = (ctx, next) => {
  lastSeen.set(ctx.state.requestId, Date.now());
  return next();
};

/** Background jobs — armed in `main()`, stopped by the drain's hooks. */
const scheduler = createScheduler({
  onError: (error, label) => console.error(`[scheduler] ${label} failed`, error),
});

scheduler.interval(config.SWEEP_MS, () => {
  const cutoff = Date.now() - 5 * 60_000;
  for (const [id, seen] of lastSeen) {
    if (seen < cutoff) {
      lastSeen.delete(id);
    }
  }
  sweeps += 1;
  console.log(`[scheduler] sweep ${String(sweeps)}: ${String(lastSeen.size)} live request ids`);
});

export const app: App = createApp();

use(app, requestId());
use(app, trackLastSeen);
use(app, logger());

/** The one honest endpoint: the configured title, correlated. */
get(app, '/', (ctx) => json(ctx, { title: config.TITLE, requestId: ctx.state.requestId }));

// Probes: liveness has zero dependencies (a process that answers is
// alive); readiness reports the drain gate — the signal a load balancer
// needs before connections start dropping.
get(app, '/healthz', health());
get(app, '/readyz', readiness({ drain: gate.check }));

/** Deliberately slow: the smoke holds one of these in flight across a
 * SIGTERM and expects it to complete inside the drain budget. */
get(app, '/slow', async (ctx) => {
  const started = performance.now();
  await new Promise((resolve) => setTimeout(resolve, config.SLOW_MS));
  return json(ctx, {
    tookMs: Math.round(performance.now() - started),
    requestId: ctx.state.requestId,
  });
});

export async function main(): Promise<void> {
  // Jobs armed before the socket opens; a sweep that is mid-run when the
  // drain lands is awaited by scheduler.stop() in the hooks below.
  scheduler.start();
  const server = await serve(app, { port: config.PORT });

  // One drain shared by SIGTERM/SIGINT/stop(): gate → sockets → in-flight
  // finishers → these hooks, in registration order.
  const drain = lifecycle(server, {
    timeout: config.DRAIN_MS,
    readiness: gate,
    onShutdown: [
      async () => {
        await scheduler.stop();
        console.error(`[shutdown] scheduler stopped after ${String(sweeps)} sweeps`);
      },
      () => {
        lastSeen.clear();
        console.error('[shutdown] lastSeen registry cleared — goodbye');
      },
    ],
  });
  console.log(`production-ready listening on ${server.url} (title: ${config.TITLE})`);
  await drain.stopped;
}

// Serve only when executed directly (`node app.ts`), not when smoke.ts
// imports the app to drive it in-process.
const entry =
  process.argv[1] === undefined
    ? undefined
    : pathToFileURL(realpathSync(process.argv[1])).href;
if (entry === import.meta.url) {
  await main();
}
