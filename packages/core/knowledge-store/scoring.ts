/**
 * Pure utility and scoring functions — no I/O or DB dependencies.
 * Fully unit-testable in isolation (no drizzle-orm).
 */
import type { Corpus, QueryResult } from './types';

// ── Namespace helpers ─────────────────────────────────────────────────────────

export function buildNamespace(workspaceId: string, corpus: Corpus): string {
  return `${workspaceId}:${corpus}`;
}

// ── Reciprocal Rank Fusion ────────────────────────────────────────────────────

/**
 * Reciprocal Rank Fusion — fuse vector ANN and lexical BM25 result lists.
 * k=60 is the standard constant from the original RRF paper.
 */
export function reciprocalRankFusion(
  vectorResults: Array<{ id: string; score: number }>,
  lexicalResults: Array<{ id: string; score: number }>,
  k = 60,
): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();

  vectorResults.forEach(({ id }, idx) => {
    scores.set(id, (scores.get(id) ?? 0) + 1 / (k + idx + 1));
  });
  lexicalResults.forEach(({ id }, idx) => {
    scores.set(id, (scores.get(id) ?? 0) + 1 / (k + idx + 1));
  });

  return Array.from(scores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

// ── Corpus authority and recency decay constants ──────────────────────────────

/**
 * Static authority weights per corpus. Higher = more canonical.
 * spec/docs/code are ground truth; task/artifact/session are ephemeral.
 */
export const CORPUS_AUTHORITY: Record<Corpus, number> = {
  spec:     1.0,
  docs:     0.9,
  code:     0.8,
  plan:     0.6,
  memory:   0.5,
  pr:       0.5,
  task:     0.4,
  artifact: 0.4,
  session:  0.2,
};

/**
 * Per-corpus half-life in days for the recency decay function.
 * Specs change slowly; task outcomes are highly time-bound.
 */
export const HALF_LIFE_DAYS: Record<Corpus, number> = {
  spec:     365,
  docs:     180,
  code:     90,
  memory:   120,
  plan:     60,
  pr:       45,
  task:     30,
  artifact: 30,
  session:  7,
};

/**
 * Exponential recency decay: 2^(-age_days / halfLifeDays).
 * Returns 1.0 when sourceTs is null (no penalty — conservative fallback for
 * chunks whose source timestamp is unknown).
 */
export function recencyDecay(
  sourceTs: Date | null | undefined,
  halfLifeDays: number,
  now: Date,
): number {
  if (!sourceTs) return 1.0;
  const ageDays = (now.getTime() - sourceTs.getTime()) / 86_400_000;
  if (ageDays < 0) return 1.0; // future-dated content: no penalty
  return Math.pow(2, -ageDays / halfLifeDays);
}

/**
 * Apply recency × authority multipliers to a result list (returns new array).
 *
 * Pipeline position: called AFTER the optional cross-encoder reranker so that
 * semantic relevance scores from Voyage become the base, then we multiply by
 * deterministic factors. This ensures recency/authority can never be
 * overridden by the semantic model.
 *
 *   finalScore = voyageRelevance × corpusAuthority × recencyDecay(source_ts, corpus)
 */
export function applyRecencyAuthority(results: QueryResult[], now: Date): QueryResult[] {
  return results.map(r => {
    const authority = CORPUS_AUTHORITY[r.corpus] ?? 0.5;
    const halfLife = HALF_LIFE_DAYS[r.corpus] ?? 90;
    const decay = recencyDecay(r.sourceTs, halfLife, now);
    return { ...r, score: r.score * authority * decay };
  });
}
