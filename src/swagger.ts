/**
 * Scalar API Reference page — the documentation front-end that pairs with
 * `s200/openapi`'s {@link openapiJson}. Stays zero-dependency by shipping
 * only an HTML shell: the Scalar bundle itself loads from a CDN (pinned by
 * default, overridable for mirrors). The shell is Scalar's standard
 * script-tag embed — a tagged element whose inline `data-*` attributes
 * carry the whole configuration, no inline JavaScript.
 *
 * ```ts
 * get(app, '/openapi.json', (ctx) => openapiJson(ctx, app));
 * get(app, '/docs', (ctx) => swaggerUi(ctx, { url: '/openapi.json' }));
 * ```
 *
 * @module
 */

import type { Ctx } from './types';

import { escapeHtml, html } from './respond';

/**
 * Default Scalar bundle location. The version is pinned so a page that
 * rendered yesterday renders the same tomorrow; override `cdn` for a
 * self-hosted mirror or to opt into newer builds deliberately.
 */
const SCALAR_CDN = 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.72.1';

/** Options for {@link swaggerUi}. */
export type SwaggerUiOptions = {
  /** URL of the OpenAPI document — typically the `openapiJson` route. */
  readonly url: string;
  /** Page `<title>`; defaults to `API Reference`. */
  readonly title?: string;
  /** Scalar theme name (`default`, `alternate`, `moon`, `kepler`, …). */
  readonly theme?: string;
  /** Scalar bundle URL; the pinned CDN build by default. */
  readonly cdn?: string;
};

/**
 * The Scalar documentation page as a response helper — point it at the
 * app's OpenAPI spec URL and mount it on a route (conventionally `/docs`).
 * Every interpolated value runs through {@link escapeHtml}, so a hostile
 * `url`/`title`/`theme` cannot break out of an attribute or the document.
 */
export function swaggerUi(ctx: Ctx, options: SwaggerUiOptions): Response {
  const url = escapeHtml(options.url);
  const title = escapeHtml(options.title ?? 'API Reference');
  const cdn = escapeHtml(options.cdn ?? SCALAR_CDN);
  const configuration =
    options.theme === undefined
      ? ''
      : ` data-configuration="${escapeHtml(JSON.stringify({ theme: options.theme }))}"`;
  return html(
    ctx,
    `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
  </head>
  <body>
    <script id="api-reference" data-url="${url}"${configuration}></script>
    <script src="${cdn}"></script>
  </body>
</html>
`
  );
}
