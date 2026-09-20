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
