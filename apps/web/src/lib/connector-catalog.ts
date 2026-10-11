/**
 * Built-in connector catalog: remote MCP servers buildd offers one-click, so a
 * team admin picks "Vercel" instead of pasting a URL. Each entry is a preset for
 * POST /api/connectors — installing creates an ordinary team `connectors` row
 * (spec §1: connectors stay the single source of truth), so per-workspace
 * enablement, role opt-in and sharing all work unchanged.
 *
 * Inclusion bar: the URL must complete buildd's OAuth discovery + DCR
 * (`discoverOAuthMetadata` in lib/mcp-oauth.ts) or serve anonymously. The one
 * exception is an official server whose vendor admits only MCP clients it has
 * reviewed: it stays listed with `clientSupport` saying so, because hiding it
 * reads as "buildd doesn't know about Vercel" when the truth is "Vercel hasn't
 * approved buildd yet". Install still runs the real DCR and fails with
 * `needs_approved_client`; it never borrows another client's identity.
 *
 * These are the BUILT-IN entries. The live catalog a team sees is these merged
 * with platform and team rows from `connector_catalog_entries` and the team's
 * policies — see connector-catalog-store.ts (server) and GET
 * /api/connectors/catalog. Client-safe: no server imports.
 */

export type ConnectorCatalogCategory = 'deploy' | 'database' | 'observability' | 'project' | 'docs' | 'analytics' | 'other';

export interface ConnectorCatalogEntry {
  slug: string;
  name: string;
  url: string;
  authMode: 'oauth' | 'none' | 'header';
  headerName?: string | null;
  description: string;
  category: ConnectorCatalogCategory;
  iconUrl: string;
  /**
   * Set when the provider does not (yet) let buildd register as an OAuth
   * client. Verified against the live provider; see the entry's comment.
   */
  clientSupport?: ConnectorClientSupport;
}

export interface ConnectorClientSupport {
  status: 'needs_approved_client';
  /** One plain sentence for the admin: what is blocked and by whom. */
  detail: string;
  /** Where the owner goes to fix it (the vendor's client-approval process). */
  actionLabel: string;
  actionUrl: string;
}

export const CONNECTOR_CATALOG: readonly ConnectorCatalogEntry[] = [
  // Vercel admits only MCP clients it has reviewed: its DCR endpoint answers
  // buildd's web callback with `invalid_redirect_uri` ("not approved for use by
  // this authorization server"), probed 2026-10-08. Loopback callbacks are
  // accepted, which is how desktop clients connect; a server-side runner has
  // no loopback to offer.
  { slug: 'vercel', name: 'Vercel', url: 'https://mcp.vercel.com', authMode: 'oauth', category: 'deploy',
    description: 'Deployments, build logs, projects and domains.', iconUrl: 'https://vercel.com/favicon.ico',
    clientSupport: {
      status: 'needs_approved_client',
      detail: 'Vercel only lets MCP clients it has reviewed sign in, and buildd is not on its list yet, so agents cannot use Vercel through buildd.',
      actionLabel: 'Vercel client review',
      actionUrl: 'https://vercel.com/docs/agent-resources/vercel-mcp#connecting-to-vercel-mcp',
    } },
  { slug: 'neon', name: 'Neon', url: 'https://mcp.neon.tech/mcp', authMode: 'oauth', category: 'database',
    description: 'Serverless Postgres: projects, branches, SQL and migrations.', iconUrl: 'https://neon.com/favicon/favicon.ico' },
  { slug: 'supabase', name: 'Supabase', url: 'https://mcp.supabase.com/mcp', authMode: 'oauth', category: 'database',
    description: 'Postgres, auth, storage and edge functions.', iconUrl: 'https://supabase.com/favicon/favicon.ico' },
  { slug: 'axiom', name: 'Axiom', url: 'https://mcp.axiom.co/mcp', authMode: 'oauth', category: 'observability',
    description: 'Query logs, traces and events with APL.', iconUrl: 'https://axiom.co/favicon.ico' },
  { slug: 'sentry', name: 'Sentry', url: 'https://mcp.sentry.dev/mcp', authMode: 'oauth', category: 'observability',
    description: 'Issues, errors, stack traces and releases.', iconUrl: 'https://sentry.io/favicon.ico' },
  { slug: 'posthog', name: 'PostHog', url: 'https://mcp.posthog.com/mcp', authMode: 'oauth', category: 'analytics',
    description: 'Product analytics, feature flags and experiments.', iconUrl: 'https://posthog.com/favicon-32x32.png' },
  { slug: 'linear', name: 'Linear', url: 'https://mcp.linear.app/mcp', authMode: 'oauth', category: 'project',
    description: 'Issues, projects and cycles.', iconUrl: 'https://linear.app/favicon.ico' },
  { slug: 'notion', name: 'Notion', url: 'https://mcp.notion.com/mcp', authMode: 'oauth', category: 'docs',
    description: 'Search and edit pages and databases.', iconUrl: 'https://www.notion.so/images/favicon.ico' },
  { slug: 'context7', name: 'Context7', url: 'https://mcp.context7.com/mcp', authMode: 'none', category: 'docs',
    description: 'Up-to-date library docs and code examples. No sign-in.', iconUrl: 'https://context7.com/context7-icon-green.png' },
];

export const CATALOG_POLICIES = ['blocked', 'available', 'preinstalled'] as const;
export type CatalogPolicy = typeof CATALOG_POLICIES[number];
export type CatalogSource = 'builtin' | 'platform' | 'team';

/** One row of the merged catalog a team sees. */
export interface ResolvedCatalogEntry extends ConnectorCatalogEntry {
  /** Row id for platform/team entries; null for an un-overridden built-in. */
  id: string | null;
  source: CatalogSource;
  policy: CatalogPolicy;
}

export const CATALOG_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

export function normalizeConnectorUrl(url: string): string | null {
  return normalize(url);
}

function normalize(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/**
 * The server a connector URL points at, for catalog-policy matching: the
 * lowercased hostname, trailing dot dropped. Scheme, port, path, query and
 * case are ignored on purpose — `/mcp`, `/sse` and `/` on one host are the
 * same provider, so a block must not be side-stepped by respelling the URL.
 * Install/reuse matching stays on the exact `normalizeConnectorUrl` key.
 */
export function connectorHostKey(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
    return host || null;
  } catch {
    return null;
  }
}

const BY_URL =new Map(CONNECTOR_CATALOG.map(e => [normalize(e.url)!, e]));

export function catalogEntryForUrl(url: string): ConnectorCatalogEntry | null {
  const key = normalize(url);
  return (key && BY_URL.get(key)) || null;
}

export function catalogEntryBySlug(slug: string): ConnectorCatalogEntry | null {
  return CONNECTOR_CATALOG.find(e => e.slug === slug) ?? null;
}
