import type { GoalCriteriaState } from '@buildd/shared';

/**
 * Pure readings of a stored goal-criteria verdict, shared by the producer
 * (`mission-criteria-eval.ts`), the heartbeat consumer (`criteria-rearm.ts`)
 * and the mission PATCH route. No database, no clock: the three must agree on
 * what "the verdict changed" means, and this is the one place that says it.
 */

/**
 * Verdict shape, independent of when it was produced or how it was worded.
 *
 * Keyed on each criterion's own fingerprint where one exists — array index alone
 * is not identity, since deleting a criterion renumbers the rest. Evidence text
 * is excluded on purpose: an LLM re-grading the same failure phrases it
 * differently every run, and treating rewording as new information would defeat
 * the loop guard entirely.
 */
export function criteriaFingerprint(state: GoalCriteriaState | null | undefined): string {
  if (!state) return 'none';
  const parts = (state.criteria ?? [])
    .map(c => `${c.fingerprint ?? `i${c.index}`}=${c.verdict}`)
    .sort();
  return `${state.overall}|${parts.join(',')}`;
}

/**
 * A verdict with a criterion still PENDING is in flight: a verification task
 * or a check run is working on it. Nothing in it is for the organizer to file
 * work against or for the owner to decide (df808193 was escalated on exactly
 * this shape, and the escalation stood the heartbeat down that would have
 * read the result).
 */
export function hasPendingCriteria(state: GoalCriteriaState | null | undefined): boolean {
  return (state?.criteria ?? []).some(c => c.verdict === 'PENDING');
}
