import pkg from '../../package.json';

/**
 * buildd's own MCP `serverInfo` (spec 2025-11-25 `Implementation`). `icons` and
 * `websiteUrl` let clients that render connector logos show buildd's mark
 * instead of a letter. Both icon files are Next app-dir metadata images
 * (apps/web/src/app/icon.png, apple-icon.png). `version` is the release
 * (apps/web/package.json, bumped by every release), a static import so the
 * serverless trace keeps it: a client compares it to tell a stale tool schema.
 */
export function builddServerInfo(appBaseUrl: string) {
  const base = appBaseUrl.replace(/\/+$/, '');
  return {
    name: 'buildd',
    version: pkg.version,
    websiteUrl: base,
    icons: [
      { src: `${base}/icon.png`, mimeType: 'image/png', sizes: ['192x192'] },
      { src: `${base}/apple-icon.png`, mimeType: 'image/png', sizes: ['180x180'] },
    ],
  };
}
