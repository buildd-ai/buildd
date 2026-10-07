import {
  CONNECTOR_CATALOG,
  type CatalogPolicy,
  type ConnectorCatalogCategory,
  type ConnectorCatalogEntry,
  type ResolvedCatalogEntry,
} from './connector-catalog';

/** Shape of a `connector_catalog_entries` row this module needs. */
export interface CatalogRow {
  id: string;
  teamId: string | null;
  slug: string;
  name: string;
  url: string;
  authMode: 'none' | 'header' | 'oauth' | 'assertion';
  headerName: string | null;
  description: string;
  category: string;
  iconUrl: string | null;
  enabled: boolean;
}

const CATEGORIES = new Set<ConnectorCatalogCategory>(['deploy', 'database', 'observability', 'project', 'docs', 'analytics', 'other']);

function fromRow(r: CatalogRow, source: 'platform' | 'team', policy: CatalogPolicy): ResolvedCatalogEntry | null {
  // Assertion connectors need per-deployment config; never offered one-click.
  if (r.authMode === 'assertion') return null;
  return {
    id: r.id,
    source,
    policy,
    slug: r.slug,
    name: r.name,
    url: r.url,
    authMode: r.authMode,
    headerName: r.headerName,
    description: r.description,
    category: CATEGORIES.has(r.category as ConnectorCatalogCategory) ? (r.category as ConnectorCatalogCategory) : 'other',
    iconUrl: r.iconUrl ?? '',
  };
}

/**
 * The catalog one team sees, in display order. Pure, so the precedence is
 * testable without a DB:
 *   built-in  <  platform row (same slug overrides it; enabled=false removes it)
 *             <  team row (same slug overrides both, for that team only).
 * Each entry carries the team's policy for its slug (no row = 'available').
 * Blocked entries are kept so an admin can unblock them; callers that render
 * the add-flow filter them out.
 */
export function mergeCatalog(opts: {
  builtins?: readonly ConnectorCatalogEntry[];
  platformRows: CatalogRow[];
  teamRows: CatalogRow[];
  policies: Map<string, CatalogPolicy>;
}): ResolvedCatalogEntry[] {
  const policy = (slug: string) => opts.policies.get(slug) ?? 'available';
  const bySlug = new Map<string, ResolvedCatalogEntry | null>();
  for (const b of opts.builtins ?? CONNECTOR_CATALOG) {
    bySlug.set(b.slug, { ...b, id: null, source: 'builtin', policy: policy(b.slug) });
  }
  for (const r of opts.platformRows) {
    bySlug.set(r.slug, r.enabled ? fromRow(r, 'platform', policy(r.slug)) : null);
  }
  // A disabled team row is simply ignored: a team hides a platform entry with
  // policy 'blocked', not by disabling a row it does not own.
  for (const r of opts.teamRows) {
    if (r.enabled) bySlug.set(r.slug, fromRow(r, 'team', policy(r.slug)));
  }
  return [...bySlug.values()].filter((e): e is ResolvedCatalogEntry => !!e);
}
