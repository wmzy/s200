/**
 * Route table export: the `data + functions` paradigm's payoff — an app is
 * inspectable as plain data, JSON-ready, without executing anything.
 *
 * @module
 */

import type { App } from './app';
import type { Route } from './types';

/** One serializable route summary: pure data, no functions. */
export type RouteTableEntry = {
  readonly method: string;
  readonly pattern: string;
  /** Param names in capture order (`:id`, then `*rest`). */
  readonly params: readonly string[];
  /**
   * Route-scoped middleware count — the functions themselves are not
   * serializable, so only the count travels.
   */
  readonly middlewareCount: number;
};

export type RouteTable = { readonly routes: readonly RouteTableEntry[] };

function paramNames(route: Route): string[] {
  const names: string[] = [];
  for (const segment of route.segments) {
    if (segment._tag !== 'static') {
      names.push(segment.name);
    }
  }
  return names;
}

/**
 * Exports the route table as plain data: method, pattern, param names and
 * route-middleware count per registration. Useful for OpenAPI generation,
 * route listing, or cross-language translation — `stringify` it directly.
 */
export function createRouteTable(app: App): RouteTable {
  return {
    routes: app.routes.map((route) => ({
      method: route.method,
      pattern: route.pattern,
      params: paramNames(route),
      middlewareCount: route.middlewares.length,
    })),
  };
}

/**
 * Renders a route table as aligned ASCII — `METHOD  PATTERN`, one line per
 * registration, the method column padded to the longest method present.
 * The `s200 routes` command and the dev runner's startup report print
 * this; an empty table renders as an empty string.
 */
export function formatRouteTable(table: RouteTable): string {
  let width = 0;
  for (const route of table.routes) {
    if (route.method.length > width) {
      width = route.method.length;
    }
  }
  return table.routes
    .map((route) => `${route.method.padEnd(width)}  ${route.pattern}`)
    .join('\n');
}
