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
import { longestFirst, matchShard } from './shard';
import { jsonFallback } from './respond';

/**
 * The no-shard 404 shares the core fallback's envelope
 * ({@link jsonFallback}): same `{ error }` JSON body, same
 * `application/json`, same honest byte length. A request no shard
 * claimed never entered any app's chain, so no `Ctx` exists — the
 * `undefined` form hands back the bare platform Response as the whole
 * answer.
 */
function noShardResponse(): Response {
  return jsonFallback(undefined, 404, 'no shard');
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
  // The spec→app mapping is static at creation (the docblock's fixed
  // artifact), so the join is built once instead of re-scanned per request.
  // matchShard returns one of `specs` by identity, and Map keys compare by
  // identity too — the honest join key back to the paired app.
  const appOfSpec = new Map(
    entries.map((entry) => [entry.spec, entry.app] as const)
  );
  return (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    const spec = matchShard(specs, pathname);
    if (spec !== undefined) {
      const app = appOfSpec.get(spec);
      if (app !== undefined) {
        return handle(app, request);
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
 * longest-prefix-first via {@link longestFirst} (from `s200/shard`, the
 * contract owner), the priority the gateway config and
 * {@link matchShard} both follow. Exists for tests and docs: render it
 * next to the generated nginx map and the two must tell the same story.
 * Equal-length prefixes keep input order; they can never compete for the
 * same pathname, so the order between them is presentation only.
 */
export function dispatchPlan(
  specs: readonly ShardSpec[]
): readonly { readonly prefix: string; readonly id: string }[] {
  return longestFirst(specs).map((spec) => ({
    prefix: spec.prefix,
    id: spec.id,
  }));
}
