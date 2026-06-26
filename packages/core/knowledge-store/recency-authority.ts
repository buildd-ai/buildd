import type { Corpus, QueryResult } from './types';

// ── Corpus authority weights ──────────────────────────────────────────────────
// Higher = more authoritative. Used to weight the final score.

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

// ── Recency decay half-lives (days) ──────────────────────────────────────────
// 2^(−age / halfLife) — at one half-life, decay = 0.5.

export const HALF_LIFE_DAYS: Record<Corpus, number> = {
  spec:     365,
  docs:     180,
  code:     90,
  plan:     60,
  memory:   120,
  pr:       45,
  task:     30,
  artifact: 30,
  session:  7,
};

/**
 * Compute the recency decay factor for a chunk.
 * Returns 1.0 when sourceTs is null (no penalty — conservative fallback).
 */
export function recencyDecay(sourceTs: Date | null | undefined, halfLifeDays: number): number {
  if (!sourceTs) return 1.0;
  const ageDays = (Date.now() - sourceTs.getTime()) / (1000 * 60 * 60 * 24);
  if (ageDays < 0) return 1.0; // future-dated chunk — treat as fresh
  return Math.pow(2, -ageDays / halfLifeDays);
}

/**
 * Apply recency × authority reranking to a result set.
 * Mutates each result's `.score` in place:
 *   finalScore = rrfScore × corpusAuthority × recencyDecay(source_ts, halfLife)
 *
 * `source_ts` is read from `result.metadata.source_ts` (ISO string).
 */
export function applyRecencyAuthority(results: QueryResult[], now: Date): QueryResult[] {
  for (const r of results) {
    const authority = CORPUS_AUTHORITY[r.corpus] ?? 1.0;
    const halfLife = HALF_LIFE_DAYS[r.corpus] ?? 90;

    // source_ts may be in metadata as ISO string (set by upsert from UpsertChunk.sourceTs)
    let sourceTs: Date | null = null;
    const rawTs = r.metadata?.source_ts;
    if (typeof rawTs === 'string') {
      const parsed = new Date(rawTs);
      if (!isNaN(parsed.getTime())) sourceTs = parsed;
    } else if (rawTs instanceof Date) {
      sourceTs = rawTs;
    }

    const decay = recencyDecay(sourceTs, halfLife);
    r.score = r.score * authority * decay;
  }
  return results;
}
