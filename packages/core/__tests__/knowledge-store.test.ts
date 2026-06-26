import { describe, it, expect, mock, beforeEach } from 'bun:test';
// All pure functions live in scoring.ts — no drizzle-orm dependency
import {
  buildNamespace,
  reciprocalRankFusion,
  recencyDecay,
  applyRecencyAuthority,
  CORPUS_AUTHORITY,
  HALF_LIFE_DAYS,
} from '../knowledge-store/scoring';
import { VoyageEmbedder, isCodeCorpus } from '../knowledge-store/voyage-embedder';
import type { KnowledgeStore, UpsertChunk, QueryResult, Embedder, Corpus } from '../knowledge-store/types';

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

// ── Per-corpus embedder selection ────────────────────────────────────────────

describe('isCodeCorpus', () => {
  it('returns true for code, docs, and spec corpora', () => {
    expect(isCodeCorpus('code')).toBe(true);
    expect(isCodeCorpus('docs')).toBe(true);
    expect(isCodeCorpus('spec')).toBe(true);
  });

  it('returns false for memory, task, pr, plan, artifact, session', () => {
    const nonCode: Corpus[] = ['memory', 'task', 'pr', 'plan', 'artifact', 'session'];
    for (const corpus of nonCode) {
      expect(isCodeCorpus(corpus)).toBe(false);
    }
  });
});

describe('VoyageEmbedder per-model', () => {
  it('stores the model name passed to constructor', () => {
    const e = new VoyageEmbedder('fake-key', 'voyage-code-3');
    expect(e.model).toBe('voyage-code-3');
  });

  it('defaults to voyage-4-large when no model specified', () => {
    const e = new VoyageEmbedder('fake-key');
    expect(e.model).toBe('voyage-4-large');
  });
});

// ── spec corpus ───────────────────────────────────────────────────────────────

describe('spec corpus support', () => {
  it('buildNamespace accepts spec corpus', () => {
    expect(buildNamespace('ws-123', 'spec')).toBe('ws-123:spec');
  });

  it('spec corpus can be upserted and queried in mock store', async () => {
    const store = makeMockStore();
    await store.upsert('ws-1:spec', [
      { id: 'spec-1', content: 'API endpoint GET /tasks returns task list', sourceType: 'spec' },
    ]);
    const results = await store.query('ws-1:spec', { text: 'tasks', topK: 5 });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('spec-1');
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

// ── recencyDecay ─────────────────────────────────────────────────────────────

describe('recencyDecay', () => {
  it('returns 1.0 when sourceTs is null (no penalty)', () => {
    const now = new Date('2026-06-25T00:00:00Z');
    expect(recencyDecay(null, 90, now)).toBe(1.0);
    expect(recencyDecay(undefined, 90, now)).toBe(1.0);
  });

  it('returns 1.0 for a freshly-dated chunk (age ≈ 0)', () => {
    const now = new Date('2026-06-25T00:00:00Z');
    const sourceTs = new Date('2026-06-25T00:00:00Z');
    expect(recencyDecay(sourceTs, 90, now)).toBeCloseTo(1.0, 4);
  });

  it('returns 0.5 at exactly one half-life', () => {
    const now = new Date('2026-06-25T00:00:00Z');
    const halfLife = 90;
    const sourceTs = new Date(now.getTime() - halfLife * 86_400_000);
    expect(recencyDecay(sourceTs, halfLife, now)).toBeCloseTo(0.5, 4);
  });

  it('returns ~0.25 at two half-lives', () => {
    const now = new Date('2026-06-25T00:00:00Z');
    const halfLife = 90;
    const sourceTs = new Date(now.getTime() - 2 * halfLife * 86_400_000);
    expect(recencyDecay(sourceTs, halfLife, now)).toBeCloseTo(0.25, 4);
  });

  it('returns 1.0 for future-dated content (no penalty for forward-dated chunks)', () => {
    const now = new Date('2026-06-25T00:00:00Z');
    const sourceTs = new Date('2026-12-31T00:00:00Z'); // in the future
    expect(recencyDecay(sourceTs, 90, now)).toBe(1.0);
  });
});

// ── CORPUS_AUTHORITY and HALF_LIFE_DAYS coverage ─────────────────────────────

describe('CORPUS_AUTHORITY', () => {
  it('spec has the highest authority', () => {
    const entries = Object.entries(CORPUS_AUTHORITY) as [Corpus, number][];
    const max = Math.max(...entries.map(([, v]) => v));
    expect(CORPUS_AUTHORITY.spec).toBe(max);
  });

  it('session has the lowest authority', () => {
    const entries = Object.entries(CORPUS_AUTHORITY) as [Corpus, number][];
    const min = Math.min(...entries.map(([, v]) => v));
    expect(CORPUS_AUTHORITY.session).toBe(min);
  });

  it('covers all Corpus values', () => {
    const expected: Corpus[] = ['memory','code','docs','spec','task','artifact','pr','plan','session'];
    for (const corpus of expected) {
      expect(CORPUS_AUTHORITY[corpus]).toBeDefined();
    }
  });
});

describe('HALF_LIFE_DAYS', () => {
  it('spec has the longest half-life', () => {
    const entries = Object.entries(HALF_LIFE_DAYS) as [Corpus, number][];
    const max = Math.max(...entries.map(([, v]) => v));
    expect(HALF_LIFE_DAYS.spec).toBe(max);
  });

  it('session has the shortest half-life', () => {
    const entries = Object.entries(HALF_LIFE_DAYS) as [Corpus, number][];
    const min = Math.min(...entries.map(([, v]) => v));
    expect(HALF_LIFE_DAYS.session).toBe(min);
  });
});

// ── applyRecencyAuthority ─────────────────────────────────────────────────────

function makeResult(overrides: Partial<QueryResult> & { id: string }): QueryResult {
  return {
    id: overrides.id,
    namespace: 'ws-1:spec',
    corpus: (overrides.corpus ?? 'spec') as Corpus,
    sourceType: overrides.sourceType ?? 'spec',
    sourcePath: overrides.sourcePath ?? null,
    sourceUrl: overrides.sourceUrl ?? null,
    content: overrides.content ?? 'test content',
    metadata: overrides.metadata ?? {},
    score: overrides.score ?? 1.0,
    sourceTs: overrides.sourceTs ?? null,
  };
}

describe('applyRecencyAuthority', () => {
  it('multiplies score by corpus authority and recency decay', () => {
    const now = new Date('2026-06-25T00:00:00Z');
    const freshSpec = makeResult({ id: 'a', corpus: 'spec', score: 1.0, sourceTs: now });
    const results = applyRecencyAuthority([freshSpec], now);
    // spec authority=1.0, decay≈1.0 at age 0 → score ≈ 1.0
    expect(results[0].score).toBeCloseTo(1.0, 3);
  });

  it('a recent spec chunk outscores an old task chunk at equal base scores', () => {
    const now = new Date('2026-06-25T00:00:00Z');
    const oneYearAgo = new Date(now.getTime() - 365 * 86_400_000);
    const recentSpec = makeResult({ id: 'spec', corpus: 'spec', score: 1.0, sourceTs: now });
    const oldTask = makeResult({ id: 'task', corpus: 'task', score: 1.0, sourceTs: oneYearAgo });
    const results = applyRecencyAuthority([recentSpec, oldTask], now);
    const specScore = results.find(r => r.id === 'spec')!.score;
    const taskScore = results.find(r => r.id === 'task')!.score;
    expect(specScore).toBeGreaterThan(taskScore);
  });

  it('a spec chunk with null sourceTs beats an equally old task chunk (no penalty for unknown age)', () => {
    const now = new Date('2026-06-25T00:00:00Z');
    const oneYearAgo = new Date(now.getTime() - 365 * 86_400_000);
    const specNoTs = makeResult({ id: 'spec', corpus: 'spec', score: 1.0, sourceTs: null });
    const oldTask = makeResult({ id: 'task', corpus: 'task', score: 1.0, sourceTs: oneYearAgo });
    const results = applyRecencyAuthority([specNoTs, oldTask], now);
    const specScore = results.find(r => r.id === 'spec')!.score;
    const taskScore = results.find(r => r.id === 'task')!.score;
    // spec authority (1.0) × decay (1.0 — no penalty) > task authority (0.4) × heavy decay
    expect(specScore).toBeGreaterThan(taskScore);
  });

  it('preserves non-score fields', () => {
    const now = new Date('2026-06-25T00:00:00Z');
    const r = makeResult({ id: 'x', corpus: 'memory', score: 0.8, content: 'hello' });
    const results = applyRecencyAuthority([r], now);
    expect(results[0].content).toBe('hello');
    expect(results[0].id).toBe('x');
  });

  it('returns empty array for empty input', () => {
    expect(applyRecencyAuthority([], new Date())).toEqual([]);
  });

  it('eval delta — spec beats task for same topic, demonstrating Phase 0 → Phase 1 improvement', () => {
    const now = new Date('2026-06-25T00:00:00Z');
    const sixMonthsAgo = new Date(now.getTime() - 180 * 86_400_000);

    // Phase 0: both have same RRF score = 0.7
    const specChunk = makeResult({ id: 'spec', corpus: 'spec', score: 0.7, sourceTs: now });
    const oldTaskChunk = makeResult({ id: 'task', corpus: 'task', score: 0.7, sourceTs: sixMonthsAgo });

    // Phase 0 order: tied at 0.7 each
    // Phase 1 order: spec (authority × recency) >> task
    const phase1Results = applyRecencyAuthority([specChunk, oldTaskChunk], now);
    const specFinal = phase1Results.find(r => r.id === 'spec')!.score;
    const taskFinal = phase1Results.find(r => r.id === 'task')!.score;

    // spec: 0.7 × 1.0 × ~1.0 ≈ 0.7
    // task: 0.7 × 0.4 × 2^(-180/30) ≈ 0.7 × 0.4 × 0.0156 ≈ 0.0044
    expect(specFinal).toBeGreaterThan(taskFinal * 10); // spec dominates by >10×
  });
});
