import { describe, it, expect } from 'bun:test';
import { CONNECTOR_CATALOG, catalogEntryForUrl, catalogEntryBySlug, catalogReadOnlyTool } from './connector-catalog';

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

describe('vetted read tools (readOnlyTools / readOnlyUnlessArgs)', () => {
  const NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
  // A vetted read never starts with a verb that changes or exposes something.
  const NOT_A_READ = /^(create|update|delete|remove|replace|manage|set|send|run|deploy|rotate|reset|prepare|call|execute|drop|write|post|put|patch|insert|upsert)(?=[_\-.A-Z0-9]|$)/i;
  const names = (e: (typeof CONNECTOR_CATALOG)[number]) => [...(e.readOnlyTools ?? []), ...Object.keys(e.readOnlyUnlessArgs ?? {})];

  it('are exact tool names, unique per entry, and none is a write verb', () => {
    for (const e of CONNECTOR_CATALOG) {
      const n = names(e);
      expect(new Set(n).size).toBe(n.length);
      for (const t of n) {
        expect(t).toMatch(NAME);
        expect(t).not.toContain('*');
        // the part after a provider namespace prefix (otel-, genai-, services-)
        expect(t.replace(/^[a-z]+-/, '')).not.toMatch(NOT_A_READ);
      }
    }
  });

  it("covers Axiom's documented trace and query reads, and none of its writes", () => {
    for (const t of ['otel-getTraceSpans', 'otel-findTraces', 'listDatasets', 'getDatasetFields', 'queryMetrics']) expect(catalogReadOnlyTool('axiom', t)).toBe(true);
    for (const t of ['createMonitor', 'manageAnnotations', 'setLabels', 'sendFeedback', 'prepareApiToken', 'queryDataset']) expect(catalogReadOnlyTool('axiom', t)).toBe(false);
  });

  it('never covers an arbitrary-SQL tool, and only for its own provider', () => {
    expect(catalogReadOnlyTool('neon', 'run_sql')).toBe(false);
    expect(catalogReadOnlyTool('neon', 'run_sql_transaction')).toBe(false);
    expect(catalogReadOnlyTool('vercel', 'otel-getTraceSpans')).toBe(false);
    expect(catalogReadOnlyTool('nope', 'listDatasets')).toBe(false);
    expect(catalogReadOnlyTool(null, 'listDatasets')).toBe(false);
  });
});
