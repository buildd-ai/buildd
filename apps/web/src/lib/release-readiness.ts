import type { DerivedMetric } from '@buildd/core/derived-metric';

export { type DerivedMetric };

export const COMMITS_AHEAD_THRESHOLD = 1;

export type CiState = 'passing' | 'failing' | 'pending' | 'unknown';

export type ReleaseReadinessItem = {
  workspaceId: string;
  workspaceName: string | null;
  /** Number of PRs merged since the last healthy release. Unavailable when no baseline exists. */
  queueDepth: DerivedMetric<number>;
  /** ISO timestamp of the oldest unshipped merge. Unavailable when no baseline or empty queue. */
  oldestMergedAt: DerivedMetric<string>;
  ciState: CiState;
  /** ID of the most recent releases row, or null if no releases exist yet. */
  latestReleaseId: string | null;
};

export type ReleaseWidgetDecision = 'show' | 'ci_blocking' | 'hide';

/**
 * Spec §8 exception rule: only show the release queue widget when queue depth
 * is at or above the threshold AND CI on the source ref is green.
 *
 * - queueDepth unavailable (no_baseline) → hide
 * - queueDepth < THRESHOLD → hide (nothing to ship)
 * - ciState 'passing' → show
 * - ciState 'failing' | 'pending' → ci_blocking (suppress main widget, show subtle indicator)
 * - ciState 'unknown' (no releases yet) → show optimistically
 */
export function computeReleaseWidgetDecision(
  queueDepth: DerivedMetric<number>,
  ciState: CiState,
): ReleaseWidgetDecision {
  if (queueDepth.kind === 'unavailable') return 'hide';
  if (queueDepth.value < COMMITS_AHEAD_THRESHOLD) return 'hide';
  if (ciState === 'passing' || ciState === 'unknown') return 'show';
  return 'ci_blocking';
}
