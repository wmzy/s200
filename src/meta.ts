/**
 * Route metadata for `s200/openapi`: pure annotations stored off-app in a
 * `WeakMap` keyed by the route objects themselves, so the core `App` shape
 * stays untouched and tree-shaking keeps the metadata out of every
 * non-OpenAPI consumer. `describeRoute`/`describeApp` fill it;
 * `openapiSpec` (in `s200/openapi`) reads it back.
 *
 * Schemas reuse {@link SerializeSchema} (`s200/serialize`) — the same
 * declarative shape that already compiles serializers and infers input
 * types, now also documents the API surface.
 *
 * @module
 */

import type { App } from './app';
import type { SerializeSchema } from './serialize';
import type { Route } from './types';

export type RouteMeta = {
  /** Short operation summary (the `summary` field of the path item). */
  readonly summary?: string;
  readonly description?: string;
  /** OpenAPI tags — group operations in the rendered docs. */
  readonly tags?: readonly string[];
  readonly deprecated?: boolean;
  /** Query-string parameter schemas, keyed by parameter name. */
  readonly query?: Record<string, SerializeSchema>;
  /** JSON request-body schema (`content: application/json`). */
  readonly body?: SerializeSchema;
  /** Responses by status code; a missing schema = no content declared. */
  readonly responses?: Record<
    number,
    { readonly description: string; readonly schema?: SerializeSchema }
  >;
};

export type AppMeta = {
  readonly title?: string;
  readonly version?: string;
  readonly description?: string;
};

// Stored beside the app, never on it: importing s200/meta is the only way
// metadata exists (same pattern as s200/websocket's registry).
const routeMeta = new WeakMap<Route, RouteMeta>();
const appMeta = new WeakMap<App, AppMeta>();

/**
 * Annotates every route registered for `method` (normalized uppercase) and
 * `pattern` on this app. No-op when nothing matches — describe after
 * registration, or re-describe after re-registration.
 */
export function describeRoute(
  app: App,
  method: string,
  pattern: string,
  meta: RouteMeta
): void {
  const normalized = method.toUpperCase();
  for (const route of app.routes) {
    if (route.method === normalized && route.pattern === pattern) {
      routeMeta.set(route, meta);
    }
  }
}

/** Annotates the app itself (the OpenAPI `info` block). */
export function describeApp(app: App, meta: AppMeta): void {
  appMeta.set(app, meta);
}

/** The metadata attached to a route, when `describeRoute` set any. */
export function getRouteMeta(route: Route): RouteMeta | undefined {
  return routeMeta.get(route);
}

/** The app-level annotation, when `describeApp` set one. */
export function getAppMeta(app: App): AppMeta | undefined {
  return appMeta.get(app);
}
