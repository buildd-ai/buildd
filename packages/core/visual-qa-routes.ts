/**
 * Pure mapping from changed files to the routes a visual audit must capture.
 *
 * Follows the Next.js app-router file-system rule (see
 * docs/design/visual-qa-auditor.md, "Required routes, set by code"):
 *
 *   - Only `page` / `layout` / `template` files under `appDir` name a route.
 *     `app/api/**` is route handlers (server-only), and components, loading /
 *     error states and tests name nothing. The auditor may ADD routes for a
 *     changed shared component; it cannot drop a required one.
 *   - `(group)` and `@slot` segments are dropped; `[id]` → `:id`;
 *     `[...x]` / `[[...x]]` → `:x*`. Param names are kept as written so the
 *     result compares by string equality with visual-qa-routes.json paths.
 *   - A `layout` / `template` affects its whole subtree, so it also requires
 *     every manifest route at or under it. A `page` requires only itself.
 *
 * No DB, no fs: the caller passes the manifest in (core must not import
 * apps/web JSON).
 */

/** Default Next app dir for buildd's web app. */
export const DEFAULT_APP_DIR = 'apps/web/src/app/';

export interface VisualQaRouteManifest {
  routes: Array<{ id?: string; path: string }>;
}

type RouteFileKind = 'page' | 'layout';

const ROUTE_FILE_RE = /^(page|layout|template)\.(tsx|ts|jsx|js)$/;

function parseAppFile(
  path: string,
  appDir: string,
): { route: string; kind: RouteFileKind } | null {
  if (typeof path !== 'string') return null;
  const normalized = path.replace(/^\/+/, '');
  if (!normalized.startsWith(appDir)) return null;
  const rel = normalized.slice(appDir.length);
  if (rel === 'api' || rel.startsWith('api/')) return null;

  const segments = rel.split('/');
  const file = segments.pop() ?? '';
  const match = ROUTE_FILE_RE.exec(file);
  if (!match) return null;

  const parts: string[] = [];
  for (const seg of segments) {
    if (!seg) continue;
    // Globs are declared scope, not a file.
    if (seg.includes('*')) return null;
    if (/^\(.*\)$/.test(seg) || seg.startsWith('@')) continue;
    const catchAll = /^\[\[?\.\.\.(.+?)\]\]?$/.exec(seg);
    if (catchAll) { parts.push(`:${catchAll[1]}*`); continue; }
    const dynamic = /^\[(.+)\]$/.exec(seg);
    if (dynamic) { parts.push(`:${dynamic[1]}`); continue; }
    parts.push(seg);
  }

  return {
    route: `/${parts.join('/')}`,
    kind: match[1] === 'page' ? 'page' : 'layout',
  };
}

/** The route a single changed file names, or null when it names none. */
export function routeForAppFile(path: string, appDir = DEFAULT_APP_DIR): string | null {
  return parseAppFile(path, appDir)?.route ?? null;
}

/** Routes named directly by changed files. Sorted, deduped. */
export function routesForChangedFiles(
  paths: readonly string[],
  appDir = DEFAULT_APP_DIR,
): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const r = routeForAppFile(p, appDir);
    if (r) out.add(r);
  }
  return [...out].sort();
}

function isUnder(route: string, prefix: string): boolean {
  if (prefix === '/') return true;
  return route === prefix || route.startsWith(`${prefix}/`);
}

/**
 * Every route the audit must capture: the routes changed files name, plus the
 * manifest routes under any changed layout. Sorted, deduped.
 *
 * Deliberately unbounded: the caller decides what to do with a list longer
 * than one run can capture. It must never be truncated silently.
 */
export function requiredRoutes(
  paths: readonly string[],
  manifest?: VisualQaRouteManifest | null,
  appDir = DEFAULT_APP_DIR,
): string[] {
  const manifestPaths = (Array.isArray(manifest?.routes) ? manifest!.routes : [])
    .map((r) => (r && typeof r.path === 'string' ? r.path : null))
    .filter((p): p is string => !!p);

  const out = new Set<string>();
  for (const p of paths) {
    const parsed = parseAppFile(p, appDir);
    if (!parsed) continue;
    out.add(parsed.route);
    if (parsed.kind === 'layout') {
      for (const m of manifestPaths) if (isUnder(m, parsed.route)) out.add(m);
    }
  }
  return [...out].sort();
}
