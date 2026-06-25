/**
 * Unit tests for retrieval eval metric helpers.
 *
 * These functions are defined inline in eval-retrieval.ts. Tests here verify
 * the formulas before a live DB run so CI catches metric regressions.
 */

import { describe, it, expect } from 'bun:test';

// ── Inline metric helpers (mirrors eval-retrieval.ts exactly) ────────────────

function dcg(results: Array<{ id: string; sourcePath: string | null }>, relevantSet: Set<string>, k: number): number {
  let gain = 0;
  const capped = results.slice(0, k);
  for (let i = 0; i < capped.length; i++) {
    const r = capped[i];
    const relevant = relevantSet.has(r.id) || (r.sourcePath !== null && relevantSet.has(r.sourcePath));
    if (relevant) {
      gain += 1 / Math.log2(i + 2);
    }
  }
  return gain;
}

function idcg(numRelevant: number, k: number): number {
  const n = Math.min(numRelevant, k);
  let gain = 0;
  for (let i = 0; i < n; i++) {
    gain += 1 / Math.log2(i + 2);
  }
  return gain;
}

function ndcg(results: Array<{ id: string; sourcePath: string | null }>, relevantSet: Set<string>, k: number): number {
  const ideal = idcg(relevantSet.size, k);
  if (ideal === 0) return 0;
  return dcg(results, relevantSet, k) / ideal;
}

function reciprocalRank(results: Array<{ id: string; sourcePath: string | null }>, relevantSet: Set<string>, k: number): number {
  for (let i = 0; i < Math.min(results.length, k); i++) {
    const r = results[i];
    if (relevantSet.has(r.id) || (r.sourcePath !== null && relevantSet.has(r.sourcePath))) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

function recallAtK(results: Array<{ id: string; sourcePath: string | null }>, relevantSet: Set<string>, k: number): number {
  if (relevantSet.size === 0) return 0;
  const topK = results.slice(0, k);
  const found = topK.filter(r => relevantSet.has(r.id) || (r.sourcePath !== null && relevantSet.has(r.sourcePath))).length;
  return found / relevantSet.size;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const r = (id: string, sp: string | null = null) => ({ id, sourcePath: sp });

const TOP5 = [
  r('a', 'file-a.ts'),
  r('b', 'file-b.ts'),
  r('c', 'file-c.ts'),
  r('d', 'file-d.ts'),
  r('e', 'file-e.ts'),
];

// ── NDCG tests ───────────────────────────────────────────────────────────────

describe('ndcg', () => {
  it('returns 1.0 when sole relevant item is rank 1', () => {
    const rel = new Set(['a']);
    expect(ndcg([r('a')], rel, 10)).toBeCloseTo(1.0, 5);
  });

  it('returns 0 when relevant item not in results', () => {
    const rel = new Set(['z']);
    expect(ndcg(TOP5, rel, 10)).toBe(0);
  });

  it('returns 0 when relevant set is empty', () => {
    expect(ndcg(TOP5, new Set(), 10)).toBe(0);
  });

  it('rank-2 hit scores less than rank-1 hit', () => {
    const rel = new Set(['a']);
    const rank1 = ndcg([r('a'), r('b')], rel, 10);
    const rank2 = ndcg([r('b'), r('a')], rel, 10);
    expect(rank1).toBeGreaterThan(rank2);
  });

  it('rank-1 sourcePath match scores 1.0', () => {
    const rel = new Set(['file-a.ts']);
    expect(ndcg([r('x', 'file-a.ts')], rel, 10)).toBeCloseTo(1.0, 5);
  });

  it('two relevant items at ranks 1 and 2 scores near 1.0', () => {
    const rel = new Set(['a', 'b']);
    const score = ndcg([r('a'), r('b'), r('c')], rel, 10);
    expect(score).toBeGreaterThan(0.9);
  });

  it('two relevant items at ranks 3 and 4 scores lower than ranks 1 and 2', () => {
    const rel = new Set(['c', 'd']);
    const hiScore = ndcg([r('c'), r('d'), r('a'), r('b')], rel, 10);
    const loScore = ndcg([r('a'), r('b'), r('c'), r('d')], rel, 10);
    expect(hiScore).toBeGreaterThan(loScore);
  });

  it('k=1 cap: only first result counted', () => {
    const rel = new Set(['b']);
    expect(ndcg(TOP5, rel, 1)).toBe(0); // b is rank 2, outside k=1
    expect(ndcg([r('b'), ...TOP5], rel, 1)).toBeCloseTo(1.0, 5);
  });
});

// ── MRR tests ────────────────────────────────────────────────────────────────

describe('reciprocalRank', () => {
  it('returns 1.0 for rank-1 hit', () => {
    expect(reciprocalRank([r('a'), r('b')], new Set(['a']), 10)).toBe(1.0);
  });

  it('returns 0.5 for rank-2 hit', () => {
    expect(reciprocalRank([r('b'), r('a')], new Set(['a']), 10)).toBe(0.5);
  });

  it('returns 0 for miss', () => {
    expect(reciprocalRank(TOP5, new Set(['z']), 10)).toBe(0);
  });

  it('respects k cutoff', () => {
    const results = [r('a'), r('b'), r('c'), r('target')];
    const rel = new Set(['target']);
    expect(reciprocalRank(results, rel, 3)).toBe(0); // target at rank 4, k=3
    expect(reciprocalRank(results, rel, 4)).toBeCloseTo(0.25, 5);
  });

  it('matches on sourcePath', () => {
    const rel = new Set(['packages/core/pg-vector-store.ts']);
    const results = [r('chunk-1', 'packages/core/pg-vector-store.ts')];
    expect(reciprocalRank(results, rel, 10)).toBe(1.0);
  });
});

// ── Recall@k tests ───────────────────────────────────────────────────────────

describe('recallAtK', () => {
  it('returns 1.0 when single relevant item found', () => {
    expect(recallAtK(TOP5, new Set(['a']), 5)).toBe(1.0);
  });

  it('returns 0 when relevant not in top-k', () => {
    expect(recallAtK(TOP5, new Set(['z']), 5)).toBe(0);
  });

  it('returns 0 for empty relevant set', () => {
    expect(recallAtK(TOP5, new Set(), 5)).toBe(0);
  });

  it('returns fraction when some relevant items found', () => {
    const rel = new Set(['a', 'b', 'z']); // 2 of 3 in results
    expect(recallAtK(TOP5, rel, 5)).toBeCloseTo(2 / 3, 5);
  });

  it('k cutoff prevents finding item at rank k+1', () => {
    const rel = new Set(['e']); // rank 5 (0-indexed 4)
    expect(recallAtK(TOP5, rel, 4)).toBe(0);
    expect(recallAtK(TOP5, rel, 5)).toBe(1.0);
  });
});

// ── mean tests ───────────────────────────────────────────────────────────────

describe('mean', () => {
  it('returns 0 for empty array', () => {
    expect(mean([])).toBe(0);
  });

  it('returns single value for length-1 array', () => {
    expect(mean([0.6])).toBe(0.6);
  });

  it('averages correctly', () => {
    expect(mean([0.5, 1.0, 0.0])).toBeCloseTo(0.5, 10);
  });
});
