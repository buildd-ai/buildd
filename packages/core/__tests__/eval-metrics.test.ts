/**
 * Unit tests for retrieval eval metric helpers.
 *
 * These import the real implementations from scripts/eval-metrics.ts. They
 * previously re-implemented them inline "to mirror eval-retrieval.ts exactly",
 * which meant the suite could only ever test its own copy — and it passed
 * while the real recall@k and ndcg were unbounded, reporting recall of 118%
 * and NDCG of 4.377 on metrics defined to top out at 1.0.
 */

import { describe, it, expect } from 'bun:test';
import { dcg, idcg, ndcg, reciprocalRank, recallAtK, matchedSource, mean } from '../scripts/eval-metrics';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const r = (id: string, sp: string | null = null) => ({ id, sourcePath: sp });

const TOP5 = [
  r('a', 'file-a.ts'),
  r('b', 'file-b.ts'),
  r('c', 'file-c.ts'),
  r('d', 'file-d.ts'),
  r('e', 'file-e.ts'),
];

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

// ── Duplicate-source handling ────────────────────────────────────────────────
// The bug these cover: a file is chunked into many pieces sharing one
// sourcePath, and every chunk was counted as a separate find. The numerator
// counted returned chunks while the denominator counted expected sources, so N
// chunks of one relevant file scored N/1. In CI this surfaced as recall@10 of
// 118% and, on the spec corpus, 950% — read as a +301% improvement.

describe('recallAtK with duplicate chunks of one source', () => {
  it('counts a source once, not once per chunk', () => {
    const relevant = new Set(['src/a.ts']);
    const results = [
      { id: 'c1', sourcePath: 'src/a.ts' },
      { id: 'c2', sourcePath: 'src/a.ts' },
      { id: 'c3', sourcePath: 'src/a.ts' },
    ];
    expect(recallAtK(results, relevant, 10)).toBe(1);
  });

  it('never exceeds 1.0', () => {
    const relevant = new Set(['src/a.ts']);
    const results = Array.from({ length: 20 }, (_, i) => ({
      id: `c${i}`,
      sourcePath: 'src/a.ts',
    }));
    expect(recallAtK(results, relevant, 10)).toBeLessThanOrEqual(1);
  });

  it('still reports partial recall across distinct sources', () => {
    const relevant = new Set(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    const results = [
      { id: 'c1', sourcePath: 'src/a.ts' },
      { id: 'c2', sourcePath: 'src/a.ts' },
      { id: 'c3', sourcePath: 'src/b.ts' },
    ];
    // Two of three sources found — duplicates of a.ts must not inflate this.
    expect(recallAtK(results, relevant, 10)).toBeCloseTo(2 / 3, 5);
  });
});

describe('ndcg with duplicate chunks of one source', () => {
  it('cannot exceed 1.0', () => {
    const relevant = new Set(['src/a.ts', 'src/b.ts']);
    const results = [
      { id: 'c1', sourcePath: 'src/a.ts' },
      { id: 'c2', sourcePath: 'src/a.ts' },
      { id: 'c3', sourcePath: 'src/a.ts' },
      { id: 'c4', sourcePath: 'src/b.ts' },
    ];
    expect(ndcg(results, relevant, 10)).toBeLessThanOrEqual(1);
  });

  it('credits a source at its best rank, ignoring later duplicates', () => {
    const relevant = new Set(['src/a.ts']);
    const first = [{ id: 'c1', sourcePath: 'src/a.ts' }];
    const withDupes = [
      { id: 'c1', sourcePath: 'src/a.ts' },
      { id: 'c2', sourcePath: 'src/a.ts' },
    ];
    // Adding a redundant chunk of the same file adds no information, so it
    // must not change the score.
    expect(ndcg(withDupes, relevant, 10)).toBe(ndcg(first, relevant, 10));
  });

  it('dcg stays within idcg for any duplicate-heavy result set', () => {
    const relevant = new Set(['x', 'y']);
    const results = [
      { id: 'a', sourcePath: 'x' },
      { id: 'b', sourcePath: 'x' },
      { id: 'c', sourcePath: 'y' },
      { id: 'd', sourcePath: 'y' },
    ];
    expect(dcg(results, relevant, 10)).toBeLessThanOrEqual(idcg(relevant.size, 10));
  });
});

describe('matchedSource', () => {
  it('prefers sourcePath so chunks of one file share a key', () => {
    expect(matchedSource({ id: 'c1', sourcePath: 'src/a.ts' }, new Set(['src/a.ts']))).toBe('src/a.ts');
  });

  it('falls back to id when sourcePath does not match', () => {
    expect(matchedSource({ id: 'c1', sourcePath: 'other.ts' }, new Set(['c1']))).toBe('c1');
  });

  it('returns null for a miss', () => {
    expect(matchedSource({ id: 'c1', sourcePath: 'other.ts' }, new Set(['x']))).toBeNull();
  });

  it('treats a null sourcePath as id-only', () => {
    expect(matchedSource({ id: 'c1', sourcePath: null }, new Set(['c1']))).toBe('c1');
    expect(matchedSource({ id: 'c1', sourcePath: null }, new Set(['x']))).toBeNull();
  });
});
