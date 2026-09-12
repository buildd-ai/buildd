import type { DerivedMetric } from '@buildd/core/derived-metric';
import type { ReleaseBaselineSource } from '@buildd/core/release-baseline';

export { type DerivedMetric };
export type { ReleaseBaselineSource };

export const COMMITS_AHEAD_THRESHOLD = 1;

export type CiState = 'passing' | 'failing' | 'pending' | 'unknown';

export type ReleaseReadinessItem = {
  workspaceId: string;
  workspaceName: string | null;
  /** Number of PRs merged since the baseline (see baselineSource). Unavailable only when no rung of the ladder resolves. */
  queueDepth: DerivedMetric<number>;
  /** ISO timestamp of the oldest unshipped merge. Unavailable when no baseline or empty queue. */
  oldestMergedAt: DerivedMetric<string>;
  /** Which rung of the baseline ladder produced queueDepth — 'healthy' is a verified deploy, anything else means "no releases yet." */
  baselineSource: ReleaseBaselineSource;
  ciState: CiState;
  /** ID of the most recent releases row, or null if no releases exist yet. */
  latestReleaseId: string | null;
  /** Most recent release row's commits-ahead snapshot — sanity-check input only, never rendered as a live count. */
  commitsAheadAtDispatch: number | null;
};

export type ReleaseWidgetDecision = 'show' | 'ci_blocking' | 'hide' | 'error';

/** Divergence beyond this multiple between queueDepth and the last commits-ahead snapshot means a broken baseline, not a real backlog. */
export const DIVERGENCE_ORDER_OF_MAGNITUDE = 10;

/**
 * Spec §8 exception rule: only show the release queue widget when queue depth
 * is at or above the threshold AND CI on the source ref is green.
 *
 * - queueDepth unavailable (no_baseline) → hide
 * - queueDepth < THRESHOLD → hide (nothing to ship)
 * - queueDepth diverges from the last commits-ahead snapshot by more than an
 *   order of magnitude → error (broken baseline, not a real backlog — never
 *   render the large number)
 * - ciState 'passing' → show
 * - ciState 'failing' | 'pending' → ci_blocking (suppress main widget, show subtle indicator)
 * - ciState 'unknown' (no releases yet, or the only reading was stale/failed) → show optimistically
 */
export function computeReleaseWidgetDecision(
  queueDepth: DerivedMetric<number>,
  ciState: CiState,
  commitsAheadAtDispatch?: number | null,
): ReleaseWidgetDecision {
  if (queueDepth.kind === 'unavailable') return 'hide';
  if (queueDepth.value < COMMITS_AHEAD_THRESHOLD) return 'hide';

  if (typeof commitsAheadAtDispatch === 'number' && commitsAheadAtDispatch > 0) {
    const ratio = queueDepth.value / commitsAheadAtDispatch;
    if (ratio >= DIVERGENCE_ORDER_OF_MAGNITUDE || ratio <= 1 / DIVERGENCE_ORDER_OF_MAGNITUDE) return 'error';
  }

  if (ciState === 'passing' || ciState === 'unknown') return 'show';
  return 'ci_blocking';
}
