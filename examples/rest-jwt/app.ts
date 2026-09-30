/**
 * JWT-protected mini API — a slice of `s200/jwt` + `s200/validate`.
 *
 * Batteries on show:
 *   - `signJwt` (HS256 over WebCrypto) minting a bearer token on /login
 *   - `jwtAuth` as a route-scoped gate on /me and /articles
 *   - `jsonBody` (s200/validate) wrapping a hand-rolled parse fn — the
 *     parsed article lands on `ctx.state.validated`
 *   - error responses are materialized inside the chain, so a middleware
 *     listed ahead of the gate can stamp `WWW-Authenticate` on the unwind
 *
 * Users: ada/lovelace, alan/turing.
 */
import type { App, Middleware } from 's200';

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { createApp, get, httpError, json, post, readJson, use } from 's200';
import { jwtAuth, signJwt } from 's200/jwt';
import { jsonBody } from 's200/validate';
import { serve } from 's200/node';

const JWT_SECRET = 'demo-secret-do-not-ship';
const USERS: Readonly<Record<string, string>> = {
  ada: 'lovelace',
  alan: 'turing',
};

declare module 's200' {
  type State = {
    /** The verified payload, set by `jwtAuth` before the chain below runs. */
    jwt: { sub?: string } & Record<string, unknown>;
  }
}

/** The resource behind the gate. */
export type Article = { id: string; title: string; body: string };

/** Hand-rolled parse fn for `jsonBody` — s200 stays schema-library-free and
 * just calls it; throwing an HttpError maps to that status. */
const parseArticle = (data: unknown): Omit<Article, 'id'> => {
  if (typeof data !== 'object' || data === null) {
    throw httpError(422, 'body must be a JSON object');
  }
  const { title, body } = data as { title?: unknown; body?: unknown };
  if (typeof title !== 'string' || title.trim() === '') {
    throw httpError(422, 'title must be a non-empty string');
  }
  if (typeof body !== 'string') {
    throw httpError(422, 'body must be a string');
  }
  return { title: title.trim(), body };
};

/** `jwtAuth` answers 401 in place but sends no challenge header of its own.
 * Registered as an app-level (prefix-scoped) middleware, this runs ABOVE
 * the route error boundary — by the time `await next()` settles, the 401
 * is already materialized on `ctx.res` and can be stamped per RFC 7235. */
const bearerChallenge: Middleware = async (ctx, next) => {
  await next();
  if (ctx.res?.status === 401) {
    ctx.res.headers.set('www-authenticate', 'Bearer');
  }
};

/** The gate every protected route shares. */
const requireJwt = jwtAuth({ secret: JWT_SECRET });

export const app: App = createApp();

use(app, '/me', bearerChallenge);
use(app, '/articles', bearerChallenge);

let nextId = 1;
const articles = new Map<string, Article>();

post(app, '/login', async (ctx) => {
  const body = await readJson<{ user?: unknown; password?: unknown }>(ctx);
  const user = typeof body.user === 'string' ? body.user : undefined;
  const password = typeof body.password === 'string' ? body.password : undefined;
  if (user === undefined || password === undefined || USERS[user] !== password) {
    throw httpError(401, 'Wrong user or password');
  }
  const token = await signJwt({ sub: user }, JWT_SECRET, { expiresIn: 3600 });
  return json(ctx, { token });
});

get(app, '/me', requireJwt, (ctx) => json(ctx, ctx.state.jwt));

get(app, '/articles', requireJwt, (ctx) =>
  json(ctx, [...articles.values()])
);

post(
  app,
  '/articles',
  requireJwt,
  jsonBody(parseArticle),
  (ctx) => {
    const article: Article = { ...(ctx.state.validated as Omit<Article, 'id'>), id: `a${nextId}` };
    nextId += 1;
    articles.set(article.id, article);
    return json(ctx, article, { status: 201 });
  }
);

get(app, '/articles/:id', requireJwt, (ctx) => {
  const article = articles.get(ctx.params.id);
  if (article === undefined) {
    throw httpError(404, `No article ${ctx.params.id}`);
  }
  return json(ctx, article);
});

export async function main(): Promise<void> {
  const server = await serve(app, { port: Number(process.env.PORT ?? 3000) });
  console.log(`rest-jwt listening on ${server.url} — login with ada/lovelace`);
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
