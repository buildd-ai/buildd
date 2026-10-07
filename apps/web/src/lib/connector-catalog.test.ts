import { describe, it, expect } from 'bun:test';
import { CONNECTOR_CATALOG, catalogEntryForUrl, catalogEntryBySlug } from './connector-catalog';

describe('CONNECTOR_CATALOG', () => {
  it('ships the starter connectors', () => {
    const slugs = CONNECTOR_CATALOG.map(e => e.slug);
    for (const s of ['vercel', 'neon', 'axiom']) expect(slugs).toContain(s);
  });

  it('has unique slugs, names and urls', () => {
    for (const key of ['slug', 'name', 'url'] as const) {
      const values = CONNECTOR_CATALOG.map(e => e[key]);
      expect(new Set(values).size).toBe(values.length);
    }
  });

  it('every entry is https with an https icon', () => {
    for (const e of CONNECTOR_CATALOG) {
      expect(new URL(e.url).protocol).toBe('https:');
      expect(new URL(e.iconUrl).protocol).toBe('https:');
    }
  });
});

describe('catalogEntryForUrl', () => {
  it('matches ignoring trailing slash and case', () => {
    expect(catalogEntryForUrl('https://MCP.vercel.com/')?.slug).toBe('vercel');
    expect(catalogEntryForUrl('https://mcp.neon.tech/mcp')?.slug).toBe('neon');
  });

  it('returns null for custom or unparsable urls', () => {
    expect(catalogEntryForUrl('https://mcp.example.com')).toBeNull();
    expect(catalogEntryForUrl('not a url')).toBeNull();
  });
});

describe('catalogEntryBySlug', () => {
  it('finds by slug', () => {
    expect(catalogEntryBySlug('axiom')?.url).toBe('https://mcp.axiom.co/mcp');
    expect(catalogEntryBySlug('nope')).toBeNull();
  });
});
