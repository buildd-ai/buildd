/**
 * Percentile — the one nearest-rank definition for the monorepo.
 *
 * Convention (decided when the per-file copies were merged): `p` is 0–100, like
 * the name "p95", and the result is always an element of the input (nearest
 * rank: the value at 1-based rank ceil(p/100 * n), clamped to the ends). No
 * interpolation — callers report latencies, token counts and the like, where
 * a value nobody observed is misleading. Returns null for no values; a caller
 * that wants 0 writes `?? 0`. Input is copied, never mutated.
 *
 * Not covered, deliberately: linear interpolation (R-7, `apps/cloud-runner`
 * eval-report) and the rounded-index rule in the recovery queue panel are
 * different statistics whose outputs differ, so they stay with their callers.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}
