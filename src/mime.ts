/**
 * Extension → Content-Type table for static file serving.
 *
 * Not re-exported from the index barrel: it is an implementation detail of
 * serveStatic, and keeping it out lets minimal consumers bundle without the
 * table (verified by scripts/verify-tree-shaking.mjs).
 */
const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  map: 'application/json; charset=utf-8',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  xml: 'application/xml; charset=utf-8',
  pdf: 'application/pdf',
  wasm: 'application/wasm',
  webmanifest: 'application/manifest+json; charset=utf-8',
  mp4: 'video/mp4',
};

export function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot < 0 || dot === path.length - 1) return 'application/octet-stream';
  return CONTENT_TYPES[path.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream';
}
