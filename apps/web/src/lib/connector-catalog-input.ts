import { discoverOAuthMetadata } from '@/lib/mcp-oauth';
import { resolveConnectorIcon } from '@/lib/connector-icon';
import { CATALOG_SLUG_RE } from '@/lib/connector-catalog';

const CATEGORIES = ['deploy', 'database', 'observability', 'project', 'docs', 'analytics', 'other'] as const;

export interface CatalogEntryInput {
  slug: string;
  name: string;
  url: string;
  authMode: 'oauth' | 'none' | 'header';
  headerName: string | null;
  description: string;
  category: string;
  iconUrl: string | null;
}

export type ParseResult = { ok: true; value: CatalogEntryInput } | { ok: false; error: string; message: string };

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

/** Validate a create body. `partial` (PATCH) allows any subset of fields. */
export function parseCatalogEntryInput(body: unknown, partial = false): ParseResult | { ok: true; value: Partial<CatalogEntryInput> } {
  const b = (body ?? {}) as Record<string, unknown>;
  const out: Partial<CatalogEntryInput> = {};
  const str = (k: string) => (typeof b[k] === 'string' ? (b[k] as string).trim() : undefined);
  const fail = (error: string, message: string) => ({ ok: false as const, error, message });

  const name = str('name');
  if (name !== undefined) { if (!name || name.length > 80) return fail('invalid_name', 'Name is required (max 80 characters).'); out.name = name; }
  else if (!partial) return fail('invalid_name', 'Name is required (max 80 characters).');

  const url = str('url');
  if (url !== undefined) {
    let protocol: string | null = null;
    try { protocol = new URL(url).protocol; } catch { /* unparsable */ }
    if (protocol !== 'https:') return fail('invalid_url', 'Catalog URLs must start with https://.');
    out.url = url;
  } else if (!partial) return fail('invalid_url', 'Catalog URLs must start with https://.');

  const slug = str('slug') ?? (!partial && out.name ? slugify(out.name) : undefined);
  if (slug !== undefined) { if (!CATALOG_SLUG_RE.test(slug)) return fail('invalid_slug', 'Slug must be lowercase letters, digits and dashes.'); out.slug = slug; }

  const authMode = str('authMode');
  if (authMode !== undefined) {
    if (authMode !== 'oauth' && authMode !== 'none' && authMode !== 'header') return fail('invalid_auth_mode', 'authMode must be oauth, none or header.');
    out.authMode = authMode;
  } else if (!partial) out.authMode = 'oauth';

  const headerName = str('headerName');
  if (headerName !== undefined) out.headerName = headerName || null;
  if (out.authMode === 'header' && !out.headerName) return fail('header_name_required', 'Header auth needs a header name.');

  const description = str('description');
  if (description !== undefined) out.description = description.slice(0, 200);
  else if (!partial) out.description = '';

  const category = str('category');
  if (category !== undefined) {
    if (!(CATEGORIES as readonly string[]).includes(category)) return fail('invalid_category', `category must be one of ${CATEGORIES.join(', ')}.`);
    out.category = category;
  } else if (!partial) out.category = 'other';

  const iconUrl = str('iconUrl');
  if (iconUrl !== undefined) {
    if (iconUrl && !/^https:\/\//.test(iconUrl)) return fail('invalid_icon_url', 'iconUrl must be https.');
    out.iconUrl = iconUrl || null;
  } else if (!partial) out.iconUrl = null;

  return { ok: true, value: out as CatalogEntryInput };
}

/**
 * The catalog's inclusion bar: an entry must actually connect. An oauth entry
 * must complete discovery (a server that answers anonymously is stored as
 * 'none'); header/none entries just need to be reachable. Also fills the icon.
 */
export async function verifyCatalogServer(input: Pick<CatalogEntryInput, 'url' | 'authMode' | 'iconUrl'>): Promise<
  { ok: true; authMode: CatalogEntryInput['authMode']; iconUrl: string | null } | { ok: false; error: string; message: string }
> {
  let authMode = input.authMode;
  if (authMode === 'oauth') {
    try {
      const discovered = await discoverOAuthMetadata(input.url);
      if (discovered.authMode !== 'oauth') authMode = 'none';
    } catch (err) {
      return { ok: false, error: 'discovery_failed', message: `This server did not complete OAuth discovery: ${(err as Error).message}` };
    }
  }
  const iconUrl = input.iconUrl ?? await resolveConnectorIcon(input.url).catch(() => null);
  return { ok: true, authMode, iconUrl };
}
