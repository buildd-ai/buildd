import type { GoalCriteriaState, GoalCriterion, LivingSpecGoalCriterion } from '@buildd/shared';
import { criterionFingerprint } from '@buildd/core/mission-helpers';

export const WAIVE_ON_COMPLETE_REASON = 'Waived when the mission was completed.';

export interface SettledSpecWaive {
  goalCriteria: GoalCriterion[];
  goalCriteriaState: GoalCriteriaState;
  /** Criteria newly recorded as waived, across every outcome spec. */
  waivedIds: string[];
}

/**
 * Waive and complete, for the outcome spec row. The person's act records every
 * unmet in-scope criterion on the spec's own `waived` list (the one waive
 * record) and rewrites that criterion's stored entry to match, so the row, the
 * Verify bar and the Overview all read it as waived in the same transition.
 * Passed standings are untouched and a waived one never counts as passed.
 * Idempotent: criteria already waived are left as they are. Null when nothing
 * changes. Pure.
 */
export function settleSpecWaive(
  goalCriteria: readonly GoalCriterion[],
  state: GoalCriteriaState | null,
  by: string,
  reason: string = WAIVE_ON_COMPLETE_REASON,
  now: Date = new Date(),
): SettledSpecWaive | null {
  if (!state) return null;
  const waivedIds: string[] = [];
  const criteria = goalCriteria.map((c, i): GoalCriterion => {
    if (c.type !== 'living_spec') return c;
    const entry = state.criteria.find(e => e.index === i && e.type === 'living_spec');
    const standings = entry?.spec?.standings ?? [];
    const already = new Set((c.waived ?? []).map(w => w.criterionId));
    const unmet = standings.filter(s => s.standing !== 'pass' && s.standing !== 'waived' && !already.has(s.criterionId)).map(s => s.criterionId);
    if (unmet.length === 0) return c;
    waivedIds.push(...unmet);
    const waived = [...(c.waived ?? []), ...unmet.map(criterionId => ({ criterionId, reason, by, at: now.toISOString() }))]
      .sort((a, b) => a.criterionId.localeCompare(b.criterionId));
    return { ...c, waived } as LivingSpecGoalCriterion;
  });
  if (waivedIds.length === 0) return null;
  const waivedNow = new Set(waivedIds);
  const next: GoalCriteriaState = {
    ...state,
    criteria: state.criteria.map(e => {
      const c = criteria[e.index];
      if (!e.spec || c?.type !== 'living_spec' || c === goalCriteria[e.index]) return e;
      const { workerTaskId: _task, ...rest } = e;
      return {
        ...rest,
        verdict: 'UNVERIFIED',
        evidence: `${c.waived!.length} waived by a person.`,
        fingerprint: criterionFingerprint(c),
        spec: { ...e.spec, standings: e.spec.standings.map(s => (waivedNow.has(s.criterionId) ? { ...s, standing: 'waived' as const } : s)) },
      } as typeof e;
    }),
  };
  return { goalCriteria: criteria, goalCriteriaState: next, waivedIds };
}
