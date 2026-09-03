/**
 * The release-detail surface has one blank-render code path standing in for
 * three distinct conditions: a release that shipped no commits, a release
 * whose commit range attribution never ran (or couldn't), and a release
 * whose attribution ran but genuinely matched no tasks. Collapsing these
 * makes a correctly-empty release indistinguishable from a broken one — this
 * is the same empty-state doctrine settled for the queue-depth baseline
 * ladder (docs/specs/surface-ia-home-missions-initiatives.md §9), generalized
 * here to a single release's task attribution rather than a workspace's
 * unshipped queue. Keep this the ONE place that classifies attribution state
 * for a release; do not inline a per-surface variant.
 */

export type ReleaseAttributionState = 'clean' | 'unseeded' | 'unmatched' | 'attributed';

export interface ReleaseAttributionStateInput {
  commitsAheadAtDispatch: number | null;
  previousSha: string | null;
  headSha: string | null;
  /** Count of tasks (release_tasks rows) already attributed to this release. */
  attributedCount: number;
}

export function deriveReleaseAttributionState(input: ReleaseAttributionStateInput): ReleaseAttributionState {
  const { commitsAheadAtDispatch, previousSha, headSha, attributedCount } = input;

  if (commitsAheadAtDispatch === 0 || (previousSha !== null && previousSha === headSha)) {
    return 'clean';
  }

  if (attributedCount > 0) {
    return 'attributed';
  }

  // Attribution is fired from a guard requiring both shas (see
  // release-attribution.ts / trigger route) — without both, it structurally
  // could not have run, as opposed to having run and found nothing.
  if (!previousSha || !headSha) {
    return 'unseeded';
  }

  return 'unmatched';
}
