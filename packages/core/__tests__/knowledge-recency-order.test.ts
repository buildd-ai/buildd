import { describe, it, expect, mock } from 'bun:test';

// pg-vector-store imports drizzle-orm at module load; _finalize never touches
// the db, so a minimal stub is enough to get the class loaded.
mock.module('drizzle-orm', () => ({
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ _sql: true, strings, values }),
    { join: (parts: unknown[]) => ({ _sql: true, parts }) },
  ),
}));

const { PgVectorStore } = await import('../knowledge-store/pg-vector-store');
import type { QueryResult } from '../knowledge-store/types';

const DAY = 24 * 60 * 60 * 1000;

function hit(id: string, score: number, ageDays: number): QueryResult {
  return {
    id,
    content: id,
    score,
    corpus: 'task',
    sourceType: 'test',
    metadata: { source_ts: new Date(Date.now() - ageDays * DAY).toISOString() },
  } as unknown as QueryResult;
}

/** Reranker that returns candidates unchanged with a flat, equal score. */
function flatReranker(score: number) {
  return {
    rerank: async (_q: string, docs: string[]) =>
      docs.map((_d, i) => ({ index: i, score })),
  };
}

function finalize(store: any, results: QueryResult[], recencyAuthority: boolean) {
  return store._finalize(results, 'query', 10, recencyAuthority);
}

describe('_finalize: recency × authority survives rerank', () => {
  it('applies age decay to the reranked score instead of discarding it', async () => {
    // The regression. applyRecencyAuthority used to run BEFORE applyRerank,
    // which overwrites score — so with a reranker configured the age term was
    // computed and thrown away, and two equally-relevant results of wildly
    // different ages came back in arbitrary order.
    const store = new PgVectorStore(null, flatReranker(0.9) as any);
    const out = await finalize(store, [hit('old', 0.5, 400), hit('fresh', 0.5, 1)], true);

    expect(out.map((r: QueryResult) => r.id)).toEqual(['fresh', 'old']);
    // Equal rerank relevance, so the ordering can only come from age.
    expect(out[0].score).toBeGreaterThan(out[1].score);
  });

  it('leaves the reranker order untouched when recencyAuthority is false', async () => {
    // The contract dispatch relies on: relevance only, so it can own one age
    // policy that behaves the same with or without a reranker.
    const store = new PgVectorStore(null, {
      rerank: async (_q: string, docs: string[]) =>
        // Deliberately rank the OLD document first.
        docs.map((d, i) => ({ index: i, score: d === 'old' ? 0.9 : 0.1 })),
    } as any);
    const out = await finalize(store, [hit('old', 0.5, 400), hit('fresh', 0.5, 1)], false);

    expect(out.map((r: QueryResult) => r.id)).toEqual(['old', 'fresh']);
  });

  it('still applies decay when no reranker is configured', async () => {
    const store = new PgVectorStore(null);
    const out = await finalize(store, [hit('old', 0.5, 400), hit('fresh', 0.5, 1)], true);

    expect(out.map((r: QueryResult) => r.id)).toEqual(['fresh', 'old']);
  });

  it('weights everything the reranker returned, then truncates', async () => {
    const store = new PgVectorStore(null, flatReranker(0.9) as any);
    const results = [hit('old', 0.5, 400), hit('mid', 0.5, 60), hit('fresh', 0.5, 1)];
    const out = await store._finalize(results, 'query', 2, true);

    expect(out.map((r: QueryResult) => r.id)).toEqual(['fresh', 'mid']);

    // Caveat this test cannot cover: applyRerank is called with `limit`, and a
    // real reranker honours it, so candidates are cut by relevance *before* age
    // is ever considered. A fresh-but-marginally-less-relevant chunk can be
    // dropped where age would have promoted it. Widening the rerank window is a
    // separate change; this stub ignores topK, so the truncation here is only
    // the final slice.
  });

  it('is a no-op on an empty result set', async () => {
    const store = new PgVectorStore(null, flatReranker(0.9) as any);
    expect(await finalize(store, [], true)).toEqual([]);
  });
});
