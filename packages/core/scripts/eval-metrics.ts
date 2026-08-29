/**
 * Retrieval eval metrics.
 *
 * Extracted from eval-retrieval.ts so they can be imported. That script calls
 * `main()` at module scope, so a test could not import it — which is why
 * eval-metrics.test.ts re-implemented these functions inline and therefore
 * could not catch a bug in the real ones. It did not catch this one: recall
 * and NDCG were unbounded (recall@10 of 118%, NDCG@10 of 4.377 on a metric
 * defined to top out at 1.0) while the mirrored copy in the test passed.
 *
 * One implementation, imported by both.
 */

export interface RankedResult {
  id: string;
  sourcePath: string | null;
}

/**
 * Discounted Cumulative Gain at k with binary relevance.
 * relevantSet: set of relevant result IDs (or source paths).
 * results: ordered list of {id, sourcePath} from the retriever.
 */
export function dcg(results: RankedResult[], relevantSet: Set<string>, k: number): number {
  let gain = 0;
  const counted = new Set<string>();
  const capped = results.slice(0, k);
  for (let i = 0; i < capped.length; i++) {
    const key = matchedSource(capped[i], relevantSet);
    // Credit each relevant SOURCE once, at its best rank. A file is chunked
    // into many pieces sharing one sourcePath, so counting per chunk let dcg
    // exceed idcg — which is how NDCG@10 reached 4.377 on a metric bounded at
    // 1.0. Duplicate chunks of an already-credited source add no information.
    if (key !== null && !counted.has(key)) {
      counted.add(key);
      gain += 1 / Math.log2(i + 2); // log2(rank+1), rank is 1-based → i+2
    }
  }
  return gain;
}

/** Ideal DCG: all relevant items at the top. */
export function idcg(numRelevant: number, k: number): number {
  const n = Math.min(numRelevant, k);
  let gain = 0;
  for (let i = 0; i < n; i++) {
    gain += 1 / Math.log2(i + 2);
  }
  return gain;
}

export function ndcg(results: RankedResult[], relevantSet: Set<string>, k: number): number {
  const ideal = idcg(relevantSet.size, k);
  if (ideal === 0) return 0;
  return dcg(results, relevantSet, k) / ideal;
}

/**
 * Reciprocal rank: 1/rank of first relevant result (0 if none in top-k).
 */
export function reciprocalRank(results: RankedResult[], relevantSet: Set<string>, k: number): number {
  for (let i = 0; i < Math.min(results.length, k); i++) {
    if (matchedSource(results[i], relevantSet) !== null) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

/**
 * The relevant-set key a result matches, or null.
 *
 * Returning the key rather than a boolean is what lets callers deduplicate:
 * several returned chunks can match the same expected source.
 */
export function matchedSource(
  r: RankedResult,
  relevantSet: Set<string>,
): string | null {
  if (r.sourcePath !== null && relevantSet.has(r.sourcePath)) return r.sourcePath;
  if (relevantSet.has(r.id)) return r.id;
  return null;
}

/** recall@k: fraction of relevant items found in top-k (capped at 1.0 for multi-relevant). */
export function recallAtK(results: RankedResult[], relevantSet: Set<string>, k: number): number {
  if (relevantSet.size === 0) return 0;
  const topK = results.slice(0, k);
  // Distinct sources, not chunk hits. The numerator used to count returned
  // chunks while the denominator counted expected sources, so N chunks of one
  // relevant file scored N/1 — producing recall of 118%, and 950% on the spec
  // corpus. Clamped as well, so a future mismatch shows up as a suspicious
  // 1.0 rather than an impossible number that reads as a huge win.
  const found = new Set(
    topK.map(r => matchedSource(r, relevantSet)).filter((key): key is string => key !== null),
  ).size;
  return Math.min(found / relevantSet.size, 1);
}

/** Arithmetic mean, 0 for an empty list. */
export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
