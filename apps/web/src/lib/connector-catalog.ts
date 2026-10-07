/**
 * Built-in connector catalog: remote MCP servers buildd offers one-click, so a
 * team admin picks "Vercel" instead of pasting a URL. Each entry is a preset for
 * POST /api/connectors — installing creates an ordinary team `connectors` row
 * (spec §1: connectors stay the single source of truth), so per-workspace
 * enablement, role opt-in and sharing all work unchanged.
 *
 * Inclusion bar: the URL must complete buildd's OAuth discovery + DCR
 * (`discoverOAuthMetadata` in lib/mcp-oauth.ts) or serve anonymously. Servers
 * that fail discovery today (e.g. needing a pre-registered client) stay out
 * until the connect flow supports them.
 *
 * Client-safe: no server imports.
 */

export type ConnectorCatalogCategory = 'deploy' | 'database' | 'observability' | 'project' | 'docs' | 'analytics';

export interface ConnectorCatalogEntry {
  slug: string;
  name: string;
  url: string;
  authMode: 'oauth' | 'none';
  description: string;
  category: ConnectorCatalogCategory;
  iconUrl: string;
}

export const CONNECTOR_CATALOG: readonly ConnectorCatalogEntry[] = [
  { slug: 'vercel', name: 'Vercel', url: 'https://mcp.vercel.com', authMode: 'oauth', category: 'deploy',
    description: 'Deployments, build logs, projects and domains.', iconUrl: 'https://vercel.com/favicon.ico' },
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

function normalize(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

const BY_URL = new Map(CONNECTOR_CATALOG.map(e => [normalize(e.url)!, e]));

export function catalogEntryForUrl(url: string): ConnectorCatalogEntry | null {
  const key = normalize(url);
  return (key && BY_URL.get(key)) || null;
}

export function catalogEntryBySlug(slug: string): ConnectorCatalogEntry | null {
  return CONNECTOR_CATALOG.find(e => e.slug === slug) ?? null;
}
