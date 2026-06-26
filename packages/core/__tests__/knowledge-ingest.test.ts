import { describe, it, expect } from 'bun:test';
import { fileToChunks, ingestFiles } from '../knowledge-store/ingest';
import type { KnowledgeStore, UpsertChunk, QueryResult } from '../knowledge-store/types';

// ── Mock store that records calls ────────────────────────────────────────────

function makeRecordingStore() {
  const chunks = new Map<string, UpsertChunk & { namespace: string }>();
  const deletedSources: Array<{ namespace: string; sourcePath?: string }> = [];
  const store: KnowledgeStore = {
    async upsert(namespace, cs) {
      for (const c of cs) chunks.set(`${namespace}:${c.id}`, { ...c, namespace });
    },
    async query(): Promise<QueryResult[]> {
      return [];
    },
    async delete(namespace, ids) {
      for (const id of ids) chunks.delete(`${namespace}:${id}`);
    },
    async deleteBySource(namespace, selector) {
      deletedSources.push({ namespace, sourcePath: selector.sourcePath });
      for (const [key, c] of chunks.entries()) {
        if (c.namespace === namespace && c.sourcePath === selector.sourcePath) chunks.delete(key);
      }
    },
    async listNamespaces() {
      return [];
    },
  };
  return { store, chunks, deletedSources };
}

// ── fileToChunks ─────────────────────────────────────────────────────────────

describe('fileToChunks', () => {
  it('produces one chunk for a small code file with a composite id', () => {
    const chunks = fileToChunks(
      { path: 'src/add.ts', content: 'export const add = (a, b) => a + b;' },
      'code',
      {},
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].id).toBe('src/add.ts#1');
    expect(chunks[0].sourcePath).toBe('src/add.ts');
    expect(chunks[0].sourceType).toBe('code');
    expect(chunks[0].metadata?.startLine).toBe(1);
  });

  it('splits a large doc into multiple chunks with distinct ids', () => {
    const big = Array.from({ length: 60 }, (_, i) => `paragraph line ${i}`).join('\n');
    const md = `# Guide\n${big}`;
    const chunks = fileToChunks({ path: 'docs/guide.md', content: md }, 'docs', { maxChars: 120, overlap: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    const ids = chunks.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length); // all unique
    expect(ids.every(id => id.startsWith('docs/guide.md#'))).toBe(true);
    // doc chunks carry the heading in lexicalText for better BM25 recall
    expect(chunks[0].lexicalText).toContain('Guide');
  });

  it('builds a line-anchored sourceUrl when a base url is given', () => {
    const chunks = fileToChunks(
      { path: 'src/x.ts', content: 'line1\nline2', sourceUrl: 'https://gh/x.ts' },
      'code',
      { maxChars: 5, overlap: 0 },
    );
    expect(chunks[0].sourceUrl).toBe('https://gh/x.ts#L1');
  });
});

// ── ingestFiles ──────────────────────────────────────────────────────────────

describe('ingestFiles', () => {
  it('upserts chunks for all files and returns counts', async () => {
    const { store, chunks } = makeRecordingStore();
    const result = await ingestFiles(store, 'ws-1', 'code', [
      { path: 'a.ts', content: 'const a = 1;' },
      { path: 'b.ts', content: 'const b = 2;' },
    ]);
    expect(result.files).toBe(2);
    expect(result.chunks).toBe(2);
    expect(chunks.size).toBe(2);
  });

  it('cleans up prior chunks for a file before re-ingesting (no orphans)', async () => {
    const { store, chunks, deletedSources } = makeRecordingStore();
    const ns = 'ws-1:code';

    // First ingest: a long file -> several chunks
    const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    await ingestFiles(store, 'ws-1', 'code', [{ path: 'f.ts', content: long }], { maxChars: 40, overlap: 0 });
    const firstCount = chunks.size;
    expect(firstCount).toBeGreaterThan(1);

    // Re-ingest the same path with a tiny file -> should not leave orphan tail chunks
    await ingestFiles(store, 'ws-1', 'code', [{ path: 'f.ts', content: 'line 0' }], { maxChars: 40, overlap: 0 });
    expect(deletedSources.some(d => d.namespace === ns && d.sourcePath === 'f.ts')).toBe(true);
    const remaining = [...chunks.values()].filter(c => c.sourcePath === 'f.ts');
    expect(remaining).toHaveLength(1);
  });

  it('skips empty files without error', async () => {
    const { store } = makeRecordingStore();
    const result = await ingestFiles(store, 'ws-1', 'docs', [{ path: 'empty.md', content: '   ' }]);
    expect(result.files).toBe(1);
    expect(result.chunks).toBe(0);
  });
});

// ── sourceTs propagation ──────────────────────────────────────────────────────

describe('fileToChunks sourceTs', () => {
  it('propagates sourceTs from SourceFile to all chunks', () => {
    const ts = new Date('2026-01-15T12:00:00Z');
    const chunks = fileToChunks({ path: 'src/foo.ts', content: 'export const x = 1;', sourceTs: ts }, 'code', {});
    expect(chunks).toHaveLength(1);
    expect(chunks[0].sourceTs).toEqual(ts);
  });

  it('leaves sourceTs undefined when not set on SourceFile', () => {
    const chunks = fileToChunks({ path: 'src/bar.ts', content: 'const y = 2;' }, 'code', {});
    expect(chunks[0].sourceTs).toBeNull();
  });

  it('propagates sourceTs to all chunks of a multi-chunk file', () => {
    const ts = new Date('2025-11-01T00:00:00Z');
    const big = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
    const chunks = fileToChunks({ path: 'big.ts', content: big, sourceTs: ts }, 'code', { maxChars: 100, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.sourceTs).toEqual(ts);
    }
  });
});

describe('ingestFiles sourceTs', () => {
  it('passes sourceTs through to the store chunks', async () => {
    const { store, chunks } = makeRecordingStore();
    const ts = new Date('2026-03-10T08:00:00Z');
    await ingestFiles(store, 'ws-ts', 'code', [{ path: 'x.ts', content: 'export const x = 1;', sourceTs: ts }]);
    const chunk = [...chunks.values()][0];
    expect(chunk.sourceTs).toEqual(ts);
  });
});
