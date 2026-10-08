/**
 * buildd's own MCP `serverInfo` (spec 2025-11-25 `Implementation`). `icons` and
 * `websiteUrl` let clients that render connector logos show buildd's mark
 * instead of a letter. Both icon files are Next app-dir metadata images
 * (apps/web/src/app/icon.png, apple-icon.png).
 */
export function builddServerInfo(appBaseUrl: string) {
  const base = appBaseUrl.replace(/\/+$/, '');
  return {
    name: 'buildd',
    version: '0.1.0',
    websiteUrl: base,
    icons: [
      { src: `${base}/icon.png`, mimeType: 'image/png', sizes: ['192x192'] },
      { src: `${base}/apple-icon.png`, mimeType: 'image/png', sizes: ['180x180'] },
    ],
  };
}
