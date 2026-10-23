/**
 * What the spec corpus asks of the store (Living Specs "Related specs" R-101,
 * "Duplicates" R-104, R-106): drafts are left out unless a query asks for
 * them, a probe can rank by a stored chunk's own embedding (no embedding
 * call), a batch of probes is embedded in one call, and a spec's own chunks
 * can be left out of its own results.
 *
 * Run: bun run scripts/run-unit-tests.ts packages/core/__tests__/knowledge-spec-corpus-query.test.ts
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';

// Same sql mock shape as knowledge-hybrid-parallel-query.test.ts (mock.module is process-global).
mock.module('drizzle-orm', () => ({
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ _sql: true, strings, values }),
    { join: (parts: unknown[]) => ({ _sql: true, parts }) },
  ),
}));

function flattenSql(q: any): string {
  if (q === null || q === undefined) return '';
  if (typeof q !== 'object') return JSON.stringify(q);
  if (Array.isArray(q.parts)) return q.parts.map(flattenSql).join(', ');
  if (q.strings) {
    let out = '';
    const strings: string[] = Array.from(q.strings);
    const values: unknown[] = q.values ?? [];
    strings.forEach((s, i) => {
      out += s;
      if (i < values.length) {
        const v: any = values[i];
        out += v && typeof v === 'object' && (v.strings || v.parts) ? flattenSql(v) : JSON.stringify(v);
      }
    });
    return out;
  }
  return '';
}

let calls: string[] = [];
const mockDb = {
  execute: async (q: unknown) => {
    const text = flattenSql(q);
    calls.push(text);
    if (text.includes('embedding::text')) return { rows: [{ embedding: '[0.5,0.5,0.5,0.5]' }] };
    if (text.includes('embedding <=>')) return { rows: [{ id: 'b', score: 0.9 }] };
    if (text.includes('lexical_tsv')) return { rows: [{ id: 'b', score: 0.3 }] };
    if (text.includes('source_id IN')) return { rows: [{ source_id: 'b', namespace: 'w:spec', corpus: 'spec', source_type: 'living_spec', source_path: null, source_url: null, content: 'b', metadata: { specId: 'B' } }] };
    return { rows: [] };
  },
};
mock.module('../db/index', () => ({ db: mockDb }));

const { PgVectorStore } = await import('../knowledge-store/pg-vector-store');

let embedCalls: string[][] = [];
const embedder = {
  model: 'mock', dimensions: 4,
  async embed(texts: string[]) { embedCalls.push(texts); return texts.map(() => [0.1, 0.2, 0.3, 0.4]); },
};
const base = { useGraph: false, trackHits: false, recencyAuthority: false } as const;
const searches = () => calls.filter(c => c.includes('embedding <=>') || c.includes('lexical_tsv'));

beforeEach(() => { calls = []; embedCalls = []; });

describe('drafts (R-106)', () => {
  it('a query leaves draft chunks out by default, so recall never shows one', async () => {
    await new PgVectorStore(embedder as any).query('w:spec', { text: 'cart', ...base });
    expect(searches().length).toBe(2);
    for (const s of searches()) expect(s).toContain(`source_type <> "living_spec_draft"`);
  });
  it('a query that asks for drafts gets them', async () => {
    await new PgVectorStore(embedder as any).query('w:spec', { text: 'cart', includeDrafts: true, ...base });
    for (const s of searches()) expect(s).not.toContain('living_spec_draft');
  });
});

describe('probing with a stored chunk (R-101: no embedding call of its own)', () => {
  it('ranks by the chunk\'s stored embedding and never calls the embedder', async () => {
    const r = await new PgVectorStore(embedder as any).query('w:spec', { text: 'R-1: totals', nearChunkId: 'living-spec:A@1#R-1', ...base });
    expect(embedCalls).toEqual([]);
    const vector = calls.find(c => c.includes('embedding <=>'))!;
    expect(vector).toContain('[0.5,0.5,0.5,0.5]');
    expect(r[0]!.scoreBreakdown?.dense).toBe(0.9);
  });
  it('a precomputed embedding is used as given', async () => {
    await new PgVectorStore(embedder as any).query('w:spec', { text: 'x', embedding: [1, 0, 0, 0], ...base });
    expect(embedCalls).toEqual([]);
    expect(calls.find(c => c.includes('embedding <=>'))).toContain('[1,0,0,0]');
  });
  it('with no embedder a probe is lexical only', async () => {
    await new PgVectorStore(null).query('w:spec', { text: 'x', nearChunkId: 'living-spec:A@1#R-1', ...base });
    expect(calls.some(c => c.includes('embedding <=>'))).toBe(false);
    expect(calls.some(c => c.includes('lexical_tsv'))).toBe(true);
  });
});

describe('a spec\'s own chunks', () => {
  it('can be left out of its own results', async () => {
    await new PgVectorStore(embedder as any).query('w:spec', { text: 'x', excludeSourceIdPrefixes: ['living-spec:A', 'living-spec-draft:A'], ...base });
    for (const s of searches()) {
      expect(s).toContain('NOT starts_with(source_id, "living-spec:A")');
      expect(s).toContain('NOT starts_with(source_id, "living-spec-draft:A")');
    }
  });
});

describe('embedQueries', () => {
  it('embeds every probe in one call, as queries; null without an embedder', async () => {
    const store = new PgVectorStore(embedder as any);
    const v = await store.embedQueries('w:spec', ['a', 'b', 'c']);
    expect(embedCalls).toEqual([['a', 'b', 'c']]);
    expect(v).toHaveLength(3);
    expect(await new PgVectorStore(null).embedQueries('w:spec', ['a'])).toBeNull();
  });
});
