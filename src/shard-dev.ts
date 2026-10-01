/**
 * Dev-time shard dispatcher: reproduces the production gateway's
 * prefix-to-shard routing inside one process, so a developer running a
 * single `node` entry observes the SAME dispatch decisions nginx would
 * make from `s200/gateway`'s generated config — same specs, same
 * longest-prefix winner, same per-shard route resolution afterwards.
 *
 * The dispatcher deliberately makes no scheduling decision of its own:
 * {@link matchShard} (from `s200/shard`, the contract owner) picks the
 * shard by pathname alone, then the shard's own app resolves method and
 * pattern exactly as it would behind the gateway. That makes a routing
 * mismatch (dev vs prod) visible as a dev-only surprise, which is the
 * whole point of this module.
 *
 * No HTTP server is started — the returned function takes a `Request` and
 * answers a `Response`, so the caller can wire it to any runtime adapter
 * (node, bun, edge, test harness).
 *
 * @module
 */

import type { App } from './app';
import type { ShardSpec } from './shard';

import { handle } from './app';
import { matchShard } from './shard';
import { utf8Length } from './respond';

/**
 * The no-shard 404 mirrors the core fallback's shape (`{ error }` JSON,
 * `application/json`, explicit content-length) but cannot call
 * `respond.json` itself: that helper writes `ctx.res` for a request
 * already inside an app's chain, and a request no shard claimed never
 * entered any chain. `utf8Length` keeps the advertised size honest for
 * non-ASCII error payloads, exactly as `json` does in-chain.
 */
function noShardResponse(): Response {
  const body = JSON.stringify({ error: 'no shard' });
  return new Response(body, {
    status: 404,
    headers: {
      'content-type': 'application/json',
      'content-length': String(utf8Length(body)),
    },
  });
}

/**
 * Builds a single-process stand-in for the production gateway. `entries`
 * pairs each {@link ShardSpec} with the app that backs it (typically cut
 * out of the monolith app with `shardApp`); `fallback` is the app for
 * pathnames no shard prefix claims — in production that role is played by
 * the gateway's catch-all upstream, locally it is just another app.
 *
 * The specs snapshot is taken once at creation, mirroring how a generated
 * nginx config is a fixed artifact: re-registering routes on a shard app
 * still works (apps are live), but adding shards means building a new
 * dispatcher.
 */
export function createDispatcher(
  entries: readonly { readonly spec: ShardSpec; readonly app: App }[],
  fallback?: App
): (request: Request) => Promise<Response> {
  const specs = entries.map((entry) => entry.spec);
  return (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    const spec = matchShard(specs, pathname);
    if (spec !== undefined) {
      // matchShard returns one of `specs` by identity, so identity is the
      // honest join key back to the paired app.
      const entry = entries.find((candidate) => candidate.spec === spec);
      if (entry !== undefined) {
        return handle(entry.app, request);
      }
    }
    if (fallback !== undefined) {
      return handle(fallback, request);
    }
    return Promise.resolve(noShardResponse());
  };
}

/**
 * Pure data view of the dispatch decision table — shards ordered
 * longest-prefix-first, the priority the gateway config and
 * {@link matchShard} both follow. Exists for tests and docs: render it
 * next to the generated nginx map and the two must tell the same story.
 * Equal-length prefixes keep input order; they can never compete for the
 * same pathname, so the order between them is presentation only.
 */
export function dispatchPlan(
  specs: readonly ShardSpec[]
): readonly { readonly prefix: string; readonly id: string }[] {
  return [...specs]
    .sort((a, b) => b.prefix.length - a.prefix.length)
    .map((spec) => ({ prefix: spec.prefix, id: spec.id }));
}
