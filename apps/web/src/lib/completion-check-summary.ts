import type { GoalCriteriaState } from '@buildd/shared';

/** A compact observation for Home and mission detail, never a diagnosis of ownership. */
export function describeCriteriaBlocker(state: GoalCriteriaState | null | undefined): string {
  const blockers = (state?.criteria ?? []).filter(c => c.verdict !== 'pass');
  if (blockers.length > 1) return `${blockers.length} completion checks need review.`;
  const blocker = blockers[0];
  const label = blocker?.label?.trim().replace(/\s+/g, ' ');
  if (!label || label.length > 100) return 'Completion checks need review.';
  return `${blocker.verdict === 'fail' ? 'Failed check' : 'Check not verified'}: ${label}`;
}
