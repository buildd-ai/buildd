import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { reciprocalRankFusion, buildNamespace } from '../knowledge-store/pg-vector-store';
import type { KnowledgeStore, UpsertChunk, QueryResult, Embedder } from '../knowledge-store/types';

// ── Mock embedder ────────────────────────────────────────────────────────────

function mockEmbedder(vectorsByText: Record<string, number[]>): Embedder {
  return {
    model: 'mock-model',
    dimensions: 4,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map(t => vectorsByText[t] ?? [0, 0, 0, 0]);
    },
  };
}

// ── reciprocalRankFusion ─────────────────────────────────────────────────────

describe('reciprocalRankFusion', () => {
  it('returns empty array for empty inputs', () => {
    expect(reciprocalRankFusion([], [])).toEqual([]);
  });

  it('combines results with scores when both lists match', () => {
    const vectorResults = [
      { id: 'a', score: 0.9 },
      { id: 'b', score: 0.7 },
    ];
    const lexicalResults = [
      { id: 'b', score: 0.8 },
      { id: 'a', score: 0.5 },
    ];
    const fused = reciprocalRankFusion(vectorResults, lexicalResults);
    // 'a' rank 1 in vector, rank 2 in lexical -> 1/(60+1) + 1/(60+2) = 0.01639 + 0.01613 = 0.03252
    // 'b' rank 2 in vector, rank 1 in lexical -> 1/(60+2) + 1/(60+1) = 0.01613 + 0.01639 = 0.03252
    expect(fused).toHaveLength(2);
    // Scores should be equal (same positions, just swapped)
    expect(Math.abs(fused[0].score - fused[1].score)).toBeLessThan(0.001);
  });

  it('boosts items appearing in both lists', () => {
    const vectorResults = [{ id: 'a', score: 0.9 }, { id: 'b', score: 0.8 }];
    const lexicalResults = [{ id: 'a', score: 0.7 }]; // only 'a' in lexical
    const fused = reciprocalRankFusion(vectorResults, lexicalResults);
    // 'a' appears in both, 'b' only in vector — 'a' should score higher
    const aEntry = fused.find(r => r.id === 'a')!;
    const bEntry = fused.find(r => r.id === 'b')!;
    expect(aEntry).toBeDefined();
    expect(bEntry).toBeDefined();
    expect(aEntry.score).toBeGreaterThan(bEntry.score);
  });

  it('includes items only in vector list', () => {
    const vectorResults = [{ id: 'vec-only', score: 0.9 }];
    const lexicalResults = [{ id: 'lex-only', score: 0.8 }];
    const fused = reciprocalRankFusion(vectorResults, lexicalResults);
    expect(fused.map(r => r.id)).toContain('vec-only');
    expect(fused.map(r => r.id)).toContain('lex-only');
  });

  it('returns results sorted by descending RRF score', () => {
    const vectorResults = [{ id: 'a', score: 0.9 }, { id: 'b', score: 0.8 }, { id: 'c', score: 0.7 }];
    const lexicalResults = [{ id: 'a', score: 0.9 }, { id: 'c', score: 0.7 }];
    const fused = reciprocalRankFusion(vectorResults, lexicalResults);
    for (let i = 1; i < fused.length; i++) {
      expect(fused[i - 1].score).toBeGreaterThanOrEqual(fused[i].score);
    }
  });
});

// ── buildNamespace ───────────────────────────────────────────────────────────

describe('buildNamespace', () => {
  it('builds namespace from workspaceId and corpus', () => {
    expect(buildNamespace('ws-123', 'memory')).toBe('ws-123:memory');
  });

  it('builds code namespace', () => {
    expect(buildNamespace('ws-abc', 'code')).toBe('ws-abc:code');
  });
});

// ── KnowledgeStore contract tests (mock implementation) ──────────────────────

function makeMockStore(): KnowledgeStore & {
  _chunks: Map<string, UpsertChunk & { namespace: string; score?: number }>;
} {
  const _chunks = new Map<string, UpsertChunk & { namespace: string }>();

  return {
    _chunks,
    async upsert(namespace: string, chunks: UpsertChunk[]) {
      for (const chunk of chunks) {
        _chunks.set(`${namespace}:${chunk.id}`, { ...chunk, namespace });
      }
    },
    async query(namespace: string, params): Promise<QueryResult[]> {
      const results: QueryResult[] = [];
      for (const [key, chunk] of _chunks.entries()) {
        if (!key.startsWith(namespace + ':')) continue;
        if (params.text && !chunk.content.toLowerCase().includes(params.text.toLowerCase())) continue;
        results.push({
          id: chunk.id,
          namespace,
          corpus: 'memory',
          sourceType: chunk.sourceType,
          sourcePath: chunk.sourcePath ?? null,
          sourceUrl: chunk.sourceUrl ?? null,
          content: chunk.content,
          metadata: chunk.metadata ?? {},
          score: 0.5,
        });
      }
      return results.slice(0, params.topK ?? 10);
    },
    async delete(namespace: string, ids: string[]) {
      for (const id of ids) {
        _chunks.delete(`${namespace}:${id}`);
      }
    },
    async listNamespaces(): Promise<string[]> {
      const namespaces = new Set<string>();
      for (const [, chunk] of _chunks.entries()) {
        namespaces.add(chunk.namespace);
      }
      return Array.from(namespaces);
    },
  };
}

describe('KnowledgeStore contract', () => {
  let store: ReturnType<typeof makeMockStore>;

  beforeEach(() => {
    store = makeMockStore();
  });

  it('upserts and retrieves a chunk', async () => {
    await store.upsert('ws-1:memory', [
      {
        id: 'mem-1',
        content: 'The codex runner uses bun to execute scripts',
        sourceType: 'memory',
        metadata: { memoryId: 'mem-1', type: 'gotcha' },
      },
    ]);

    const results = await store.query('ws-1:memory', { text: 'codex', topK: 5 });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('mem-1');
    expect(results[0].content).toContain('codex');
  });

  it('upserts idempotently — second upsert with same id overwrites', async () => {
    await store.upsert('ws-1:memory', [
      { id: 'mem-1', content: 'Original content', sourceType: 'memory' },
    ]);
    await store.upsert('ws-1:memory', [
      { id: 'mem-1', content: 'Updated content', sourceType: 'memory' },
    ]);

    const results = await store.query('ws-1:memory', { text: 'updated', topK: 5 });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('Updated content');
  });

  it('deletes a chunk', async () => {
    await store.upsert('ws-1:memory', [
      { id: 'mem-1', content: 'to be deleted', sourceType: 'memory' },
    ]);

    await store.delete('ws-1:memory', ['mem-1']);
    const results = await store.query('ws-1:memory', { text: 'deleted', topK: 5 });
    expect(results).toHaveLength(0);
  });

  it('lists namespaces', async () => {
    await store.upsert('ws-1:memory', [
      { id: 'm1', content: 'a', sourceType: 'memory' },
    ]);
    await store.upsert('ws-2:memory', [
      { id: 'm2', content: 'b', sourceType: 'memory' },
    ]);

    const namespaces = await store.listNamespaces();
    expect(namespaces).toContain('ws-1:memory');
    expect(namespaces).toContain('ws-2:memory');
  });

  it('scopes queries to the given namespace', async () => {
    await store.upsert('ws-1:memory', [
      { id: 'mem-a', content: 'codex backend', sourceType: 'memory' },
    ]);
    await store.upsert('ws-2:memory', [
      { id: 'mem-b', content: 'codex backend', sourceType: 'memory' },
    ]);

    const ws1Results = await store.query('ws-1:memory', { text: 'codex', topK: 10 });
    expect(ws1Results.every(r => r.id === 'mem-a')).toBe(true);
    expect(ws1Results.some(r => r.id === 'mem-b')).toBe(false);
  });

  it('respects topK limit', async () => {
    for (let i = 0; i < 5; i++) {
      await store.upsert('ws-1:memory', [
        { id: `mem-${i}`, content: 'codex test item', sourceType: 'memory' },
      ]);
    }
    const results = await store.query('ws-1:memory', { text: 'codex', topK: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });
});

// ── Memory ingestion wiring ──────────────────────────────────────────────────

describe('handleMemoryAction with KnowledgeStore wiring', () => {
  it('types compile: KnowledgeStore and Embedder interfaces are importable', async () => {
    // This test verifies the interfaces exist and are structurally correct
    const embedder: Embedder = {
      model: 'test-model',
      dimensions: 4,
      embed: async (texts: string[]) => texts.map(() => [0, 0, 0, 0]),
    };

    const store: KnowledgeStore = {
      upsert: async () => {},
      query: async () => [],
      delete: async () => {},
      listNamespaces: async () => [],
    };

    expect(embedder.model).toBe('test-model');
    expect(embedder.dimensions).toBe(4);
    expect(typeof store.upsert).toBe('function');
  });
});
