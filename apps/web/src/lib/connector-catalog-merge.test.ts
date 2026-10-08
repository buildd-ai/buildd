import { describe, it, expect } from 'bun:test';
import { mergeCatalog, type CatalogRow } from './connector-catalog-merge';
import type { ConnectorCatalogEntry } from './connector-catalog';

const builtin = (slug: string): ConnectorCatalogEntry => ({
  slug, name: slug.toUpperCase(), url: `https://mcp.${slug}.dev/mcp`, authMode: 'oauth',
  description: `${slug} builtin`, category: 'docs', iconUrl: `https://${slug}.dev/i.png`,
});
const row = (over: Partial<CatalogRow> & { slug: string }): CatalogRow => ({
  id: `row-${over.slug}-${over.teamId ?? 'p'}`, teamId: null, name: over.slug, url: `https://mcp.${over.slug}.example/mcp`,
  authMode: 'oauth', headerName: null, description: '', category: 'other', iconUrl: null, enabled: true, ...over,
});
const slugs = (xs: { slug: string }[]) => xs.map(x => x.slug);

describe('mergeCatalog', () => {
  const builtins = [builtin('vercel'), builtin('neon')];

  it('returns built-ins as available when nothing else exists', () => {
    const out = mergeCatalog({ builtins, platformRows: [], teamRows: [], policies: new Map() });
    expect(slugs(out)).toEqual(['vercel', 'neon']);
    expect(out.every(e => e.source === 'builtin' && e.policy === 'available' && e.id === null)).toBe(true);
  });

  it('adds platform rows for every team and lets one override a built-in by slug', () => {
    const out = mergeCatalog({
      builtins,
      platformRows: [row({ slug: 'neon', name: 'Neon (EU)', url: 'https://eu.neon.example/mcp' }), row({ slug: 'grafana' })],
      teamRows: [], policies: new Map(),
    });
    expect(slugs(out)).toEqual(['vercel', 'neon', 'grafana']);
    const neon = out.find(e => e.slug === 'neon')!;
    expect(neon.source).toBe('platform');
    expect(neon.name).toBe('Neon (EU)');
  });

  it('a disabled platform row removes the built-in it shadows', () => {
    const out = mergeCatalog({ builtins, platformRows: [row({ slug: 'vercel', enabled: false })], teamRows: [], policies: new Map() });
    expect(slugs(out)).toEqual(['neon']);
  });

  it('team rows add private entries and override platform/built-ins for that team', () => {
    const out = mergeCatalog({
      builtins,
      platformRows: [row({ slug: 'grafana' })],
      teamRows: [row({ slug: 'grafana', teamId: 't1', name: 'Our Grafana' }), row({ slug: 'internal', teamId: 't1' })],
      policies: new Map(),
    });
    expect(out.find(e => e.slug === 'grafana')).toMatchObject({ source: 'team', name: 'Our Grafana' });
    expect(out.find(e => e.slug === 'internal')?.source).toBe('team');
  });

  it('ignores a disabled team row instead of hiding the platform entry', () => {
    const out = mergeCatalog({ builtins, platformRows: [], teamRows: [row({ slug: 'vercel', teamId: 't1', enabled: false })], policies: new Map() });
    expect(out.find(e => e.slug === 'vercel')?.source).toBe('builtin');
  });

  it('attaches the team policy per slug and keeps blocked entries for admins', () => {
    const out = mergeCatalog({
      builtins, platformRows: [], teamRows: [],
      policies: new Map([['vercel', 'preinstalled'], ['neon', 'blocked']]),
    });
    expect(out.find(e => e.slug === 'vercel')?.policy).toBe('preinstalled');
    expect(out.find(e => e.slug === 'neon')?.policy).toBe('blocked');
  });

  it('never offers assertion-mode rows and maps unknown categories to other', () => {
    const out = mergeCatalog({
      builtins: [],
      platformRows: [row({ slug: 'cue', authMode: 'assertion' }), row({ slug: 'x', category: 'weird' })],
      teamRows: [], policies: new Map(),
    });
    expect(slugs(out)).toEqual(['x']);
    expect(out[0].category).toBe('other');
  });
});
