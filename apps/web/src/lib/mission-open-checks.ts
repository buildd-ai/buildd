/**
 * What the mission still owes before it can complete, read the way the
 * Checks rail reads it (spec 8e137fdb I-1, AC-7): one count of open required
 * goal criteria, the selected outcome spec included, and one summary of the
 * visual review for the header, the list card and Next.
 */
import type { GoalCriteriaState, GoalCriterion } from '@buildd/shared';
import { criteriaChecks } from './mission-checks';
import { BROWSER_RUNNER_MISSING } from './claim-hold-phrase';
import { presentVisualReview } from './workflow/visual-review-presentation';
import type { MissionVisualReviewState } from './workflow/visual-review-state';

const SETTLED = new Set(['passed', 'waived', 'not_applicable']);

type CriteriaCtx = { branch: 'mission-branch' | 'direct'; prMerged: boolean; buildComplete: boolean };

/** Required goal criteria the rail does not show as passed, waived or not applicable: name and state, as the rail words them. */
export function openCriteriaChecks(goalCriteria: unknown, goalCriteriaState: unknown, ctx: CriteriaCtx): Array<{ label: string; state: string }> {
  if (!Array.isArray(goalCriteria) || goalCriteria.length === 0) return [];
  const rows = criteriaChecks(goalCriteria as GoalCriterion[], (goalCriteriaState ?? null) as GoalCriteriaState | null, { ...ctx, target: null });
  return rows.filter(r => r.blocks && !SETTLED.has(r.status)).map(r => ({ label: r.label, state: r.state }));
}

export function openCriteriaCount(goalCriteria: unknown, goalCriteriaState: unknown, ctx: CriteriaCtx): number {
  return openCriteriaChecks(goalCriteria, goalCriteriaState, ctx).length;
}

export interface MissionVisualReviewSummary {
  status: string;
  /** For `blocked`: why, as the end of a sentence. */
  blockedDetail: string | null;
  /** For `queued`: the claim loop's newest refusal reason, when the loader read one. */
  holdReason: string | null;
  /** The review holds the open mission PR (`MissionVisualReviewState.blocksMerge`): it is not ready to merge. */
  blocksMerge?: boolean;
  /** `presentVisualReview(state).label`: what the review waits on, in its own words. */
  label?: string;
  /** A person owes the review a decision (`presentVisualReview(state).needsYou`). */
  needsOwner?: boolean;
}

/** The visual review as the mission state reads it: one cause, from the review's own state. */
export function summarizeVisualReview(state: MissionVisualReviewState | null | undefined): MissionVisualReviewSummary | null {
  if (!state) return null;
  return {
    status: state.status,
    blockedDetail: state.status === 'blocked'
      ? state.blocked?.cause === 'no_browser_runner' ? BROWSER_RUNNER_MISSING : presentVisualReview(state).label.toLowerCase()
      : null,
    holdReason: state.status === 'queued' ? state.holdReason ?? null : null,
    ...(state.blocksMerge ? { blocksMerge: true, label: presentVisualReview(state).label, needsOwner: presentVisualReview(state).needsYou } : {}),
  };
}
