/**
 * The schedulable-unit contract: one route table, annotated with routing
 * policies, projected into many scheduling views — gateway config, dev
 * dispatcher, executor supervision. `s200/shard` owns only the data plane:
 * pure data ({@link ShardSpec}) plus pure functions over it. Scheduling
 * decisions belong to the consumers; this module never starts, stops, or
 * routes anything itself.
 *
 * The flow is one-directional. An {@link App} stays the single source of
 * truth (routes + {@link policy} annotations), and every view derives from
 * it: nginx locations, dev-mode multiplexing, and worker supervision all
 * read the same {@link ShardSpec} values, so the views cannot drift apart.
 *
 * @module
 */

import type { App } from './app';
import type { RouteTableEntry } from './route-table';
import type { Route, State } from './types';

/**
 * Scheduling hints one route carries into its shard's views. Every field is
 * optional and advisory — core dispatch in `handle` ignores them; consumers
 * translate them into their own runtime knobs: `timeoutMs` becomes gateway
 * proxy timeouts and watchdog prompts, `memoryMb` an executor's resource
 * limit, `maxConcurrency` a scheduler cap, `streaming` the reason to turn
 * proxy buffering off in generated config.
 */
export type RoutePolicy = {
  /** Response deadline hint: gateway proxy timeout / watchdog prompt. */
  readonly timeoutMs?: number;
  /** Memory budget hint for thread/process executors (resourceLimits). */
  readonly memoryMb?: number;
  /** Concurrency cap hint; a group's merged policy takes the max. */
  readonly maxConcurrency?: number;
  /** Streaming responses: generated proxy config disables buffering. */
  readonly streaming?: boolean;
  /** Explicit shard id override — claims the route regardless of prefix. */
  readonly shard?: string;
};

// Stored beside the app, never on it (the s200/meta pattern): importing
// s200/shard is the only way policies exist, and tree-shaking keeps the
// WeakMap out of every non-sharding consumer.
const routePolicies = new WeakMap<Route, RoutePolicy>();

/**
 * Annotates every route registered for `method` (normalized uppercase) and
 * `pattern` with a {@link RoutePolicy}. No-op when nothing matches —
 * annotate after registration; a second call replaces the first.
 */
export function policy(app: App, method: string, pattern: string, p: RoutePolicy): void {
  const normalized = method.toUpperCase();
  for (const route of app.routes) {
    if (route.method === normalized && route.pattern === pattern) {
      routePolicies.set(route, p);
    }
  }
}

/** The policy attached to a route, when `policy` set one. */
export function getPolicy(route: Route): RoutePolicy | undefined {
  return routePolicies.get(route);
}

/**
 * One declared scheduling unit: the routes under `prefix`, plus any route
 * whose policy names this group's id explicitly. Pure declaration —
 * {@link shardSpecs} resolves it against a real route table.
 */
export type ShardGroup = {
  /** DNS-safe label — becomes upstream and worker names in generated config. */
  readonly id: string;
  /** Grouping prefix, '/'-rooted; '/' declares the catch-all group. */
  readonly prefix: string;
  /** Group-level base policy; route policies fill or override it. */
  readonly policy?: RoutePolicy;
  /** Executor module path/URL for thread/process supervision. */
  readonly entry?: string;
};

/**
 * A scheduling view of one group: the declaration resolved against an
 * actual route table. Pure, JSON-ready data — gateway generators, dev
 * dispatchers, and executor supervisors all consume this shape and nothing
 * else, which is what keeps their outputs consistent with each other.
 */
export type ShardSpec = {
  readonly id: string;
  /** Dispatch prefix: this shard serves `prefix` and everything below it. */
  readonly prefix: string;
  /** The group's routes as plain data — s200/route-table's entry shape. */
  readonly routes: readonly RouteTableEntry[];
  /** Group + route policies merged; always stamped `shard: id`. */
  readonly policy: RoutePolicy;
  /** Executor module path/URL, carried from the group untouched. */
  readonly entry?: string;
};

/**
 * Membership test shared by grouping and dispatch: a pattern belongs under
 * `prefix` when it equals it or nests one segment deeper; the root prefix
 * '/' matches everything (the fallback). Comparison is on pattern strings
 * — a param prefix such as '/users/:id' groups patterns, not paths.
 */
function underPrefix(pattern: string, prefix: string): boolean {
  if (prefix === '/') {
    return true;
  }
  return pattern === prefix || pattern.startsWith(`${prefix}/`);
}

const DNS_LABEL = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

/**
 * Validates one group and normalizes its prefix (trailing slashes off; the
 * root keeps its '/'), so every consumer compares clean prefixes — the
 * same normalization `mount` applies to its prefixes.
 */
function normalizeGroup(group: ShardGroup): ShardGroup {
  if (group.id === '' || group.id.length > 63 || !DNS_LABEL.test(group.id)) {
    throw new Error(
      `Invalid shard id '${group.id}': expected a dns-safe label (letters, digits, '-', 1-63 chars)`
    );
  }
  if (!group.prefix.startsWith('/')) {
    throw new Error(`Invalid shard prefix '${group.prefix}': must start with '/'`);
  }
  const prefix = group.prefix === '/' ? '/' : group.prefix.replace(/\/+$/, '');
  return prefix === group.prefix ? group : { ...group, prefix };
}

/** The route-table entry view of one route: params and middleware counts
 * ride along, functions never do (same shape `createRouteTable` emits). */
function entryOf(route: Route): RouteTableEntry {
  const params: string[] = [];
  for (const segment of route.segments) {
    if (segment._tag !== 'static') {
      params.push(segment.name);
    }
  }
  return {
    method: route.method,
    pattern: route.pattern,
    params,
    middlewareCount: route.middlewares.length,
  };
}

/**
 * Group + route policies merged into one effective policy. The group
 * policy is the base; the FIRST route definition (registration order —
 * deterministic) overrides it per key, and `maxConcurrency` alone widens
 * to the maximum across group and routes: a shard's cap may exceed any
 * single route's ask, never undercut it. The merged result is stamped
 * `shard: id` — which shard owns this policy is data, not a guess.
 */
function mergePolicies(group: ShardGroup, routes: readonly Route[]): RoutePolicy {
  let timeoutMs: number | undefined;
  let memoryMb: number | undefined;
  let streaming: boolean | undefined;
  let maxConcurrency: number | undefined;
  for (const route of routes) {
    const p = getPolicy(route);
    if (p === undefined) {
      continue;
    }
    if (timeoutMs === undefined) {
      timeoutMs = p.timeoutMs;
    }
    if (memoryMb === undefined) {
      memoryMb = p.memoryMb;
    }
    if (streaming === undefined) {
      streaming = p.streaming;
    }
    if (p.maxConcurrency !== undefined && (maxConcurrency === undefined || p.maxConcurrency > maxConcurrency)) {
      maxConcurrency = p.maxConcurrency;
    }
  }
  const base = group.policy;
  if (timeoutMs === undefined) {
    timeoutMs = base?.timeoutMs;
  }
  if (memoryMb === undefined) {
    memoryMb = base?.memoryMb;
  }
  if (streaming === undefined) {
    streaming = base?.streaming;
  }
  if (base?.maxConcurrency !== undefined && (maxConcurrency === undefined || base.maxConcurrency > maxConcurrency)) {
    maxConcurrency = base.maxConcurrency;
  }
  const merged: {
    timeoutMs?: number;
    memoryMb?: number;
    maxConcurrency?: number;
    streaming?: boolean;
    shard: string;
  } = { shard: group.id };
  if (timeoutMs !== undefined) {
    merged.timeoutMs = timeoutMs;
  }
  if (memoryMb !== undefined) {
    merged.memoryMb = memoryMb;
  }
  if (maxConcurrency !== undefined) {
    merged.maxConcurrency = maxConcurrency;
  }
  if (streaming !== undefined) {
    merged.streaming = streaming;
  }
  return merged;
}

/** The declared group with the longest matching prefix for `pattern`
 * (earlier declaration wins ties) — '/a/b/x' prefers '/a/b' over '/a'. */
function longestPrefixGroup(
  groups: readonly ShardGroup[],
  pattern: string
): ShardGroup | undefined {
  let best: ShardGroup | undefined;
  for (const group of groups) {
    if (
      underPrefix(pattern, group.prefix) &&
      (best === undefined || group.prefix.length > best.prefix.length)
    ) {
      best = group;
    }
  }
  return best;
}

/**
 * Resolves the declared groups against `app`'s route table — the one call
 * every scheduling view starts from.
 *
 * Membership: a route belongs to the group whose prefix it equals or nests
 * under, longest prefix winning; the root prefix '/' groups everything,
 * which is how a fallback group is declared. A route-level
 * `policy.shard: id` claims the route for that group explicitly, prefix or
 * no prefix — and an explicit id that names no declared group is an error,
 * not something a prefix fallback can paper over (the claim said where the
 * route belongs; it just pointed nowhere). A route that lands in no group
 * is an orphan: orphans are never silently dropped — `shardSpecs` throws
 * listing them, so the caller decides (fix the groups, or declare the '/'
 * fallback to adopt the rest). Groups with zero routes produce no spec: a
 * shard with no data-plane presence is a declaration, not a schedulable
 * unit.
 *
 * Specs keep the groups' declaration order and routes keep registration
 * order, so downstream generation (gateway config, worker manifests) is
 * deterministic across runs.
 */
export function shardSpecs(app: App, groups: readonly ShardGroup[]): readonly ShardSpec[] {
  const declared: ShardGroup[] = [];
  const byId = new Map<string, ShardGroup>();
  for (const group of groups) {
    const normalized = normalizeGroup(group);
    if (byId.has(normalized.id)) {
      throw new Error(`Duplicate shard id '${normalized.id}': group ids must be unique`);
    }
    byId.set(normalized.id, normalized);
    declared.push(normalized);
  }

  const members = new Map<string, Route[]>();
  const orphans: string[] = [];
  for (const route of app.routes) {
    const explicit = getPolicy(route)?.shard;
    const group =
      explicit !== undefined
        ? byId.get(explicit)
        : longestPrefixGroup(declared, route.pattern);
    if (group === undefined) {
      // An unresolvable explicit claim says where the route meant to live;
      // a missing prefix group says the declarations have a hole. Either
      // way the route is listed, never silently dropped.
      orphans.push(
        explicit === undefined
          ? `${route.method} ${route.pattern}`
          : `${route.method} ${route.pattern} (policy.shard: '${explicit}')`
      );
      continue;
    }
    const bucket = members.get(group.id);
    if (bucket === undefined) {
      members.set(group.id, [route]);
    } else {
      bucket.push(route);
    }
  }
  if (orphans.length > 0) {
    throw new Error(
      `shardSpecs: routes match no group — ${orphans.join(
        ', '
      )}. Give every prefix a group, or declare a '/' fallback group to adopt the rest.`
    );
  }

  const specs: ShardSpec[] = [];
  for (const group of declared) {
    const routes = members.get(group.id);
    if (routes === undefined) {
      continue;
    }
    specs.push({
      id: group.id,
      prefix: group.prefix,
      routes: Object.freeze(routes.map(entryOf)),
      policy: mergePolicies(group, routes),
      ...(group.entry !== undefined ? { entry: group.entry } : {}),
    });
  }
  return Object.freeze(specs);
}

/**
 * The inverse of `mount`: extracts one group's routes as a standalone app —
 * the executor view. Patterns keep their absolute paths (the shard serves
 * the same URLs it always did), and route objects are reused, not rebuilt,
 * so WeakMap-keyed `policy` annotations survive the extraction. App
 * `middlewares` carry over wholesale: `use(app, prefix, …)` guards scope
 * themselves by path, so a scoped group stays scoped with no copying
 * logic, and `match`/`onError`/`onNotFound`/`logError` ride along — the
 * shard dispatches exactly as its slice of the parent did, which is what
 * `mount(parent, '', shardApp(parent, group))` reproduces the original
 * routing behavior with.
 *
 * Membership follows the shared grouping rule for this one group: an
 * explicit `policy.shard: id` claim decides (claimed-elsewhere routes stay
 * behind), otherwise the prefix subtree. Other groups are not consulted —
 * a parent shard may carry routes a nested shard also serves; longest
 * prefix dispatch ({@link matchShard}) keeps their traffic separated.
 */
export function shardApp<S extends State = State>(app: App<S>, group: ShardGroup): App<S> {
  const { id, prefix } = normalizeGroup(group);
  const routes = app.routes.filter((route) => {
    const explicit = getPolicy(route)?.shard;
    return explicit !== undefined ? explicit === id : underPrefix(route.pattern, prefix);
  });
  return {
    routes: Object.freeze(routes),
    middlewares: app.middlewares,
    match: app.match,
    onError: app.onError,
    onNotFound: app.onNotFound,
    logError: app.logError,
  };
}

/**
 * Longest-prefix dispatch over specs — the seam gateway config, the dev
 * dispatcher, and any custom router share. A spec matches when its prefix
 * equals the pathname or is a path-segment prefix of it; the '/' spec
 * matches everything. Returns the winning spec, or undefined when nothing
 * matches — callers decide what an unrouted pathname means.
 */
export function matchShard(
  specs: readonly ShardSpec[],
  pathname: string
): ShardSpec | undefined {
  let best: ShardSpec | undefined;
  for (const spec of specs) {
    if (
      underPrefix(pathname, spec.prefix) &&
      (best === undefined || spec.prefix.length > best.prefix.length)
    ) {
      best = spec;
    }
  }
  return best;
}
