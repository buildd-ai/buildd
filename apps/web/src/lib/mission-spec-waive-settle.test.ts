import { describe, expect, it } from 'bun:test';
import type { GoalCriteriaState, LivingSpecCriterionStanding, LivingSpecGoalCriterion } from '@buildd/shared';
import { settleSpecWaive } from './mission-spec-waive-settle';
import { criteriaChecks } from './mission-checks';
import { openCriteriaCount } from './mission-open-checks';
import { outcomeSpecView } from './mission-outcome-spec-view';

const SPEC = '00000000-0000-4000-8000-000000000001';
const crit: LivingSpecGoalCriterion = {
  type: 'living_spec', specId: SPEC, specRevisionId: '00000000-0000-4000-8000-000000000002', revision: 1, contentHash: 'h', provisional: true,
};
const stateOf = (standings: Array<[string, LivingSpecCriterionStanding['standing']]>, verdict: 'PENDING' | 'fail' = 'PENDING'): GoalCriteriaState => ({
  evaluatedAt: '2026-10-20T07:00:01Z', evaluatedBy: 'auto', overall: 'UNVERIFIED',
  criteria: [{
    index: 0, type: 'living_spec', verdict, workerTaskId: 'task-1', evidence: 'Could not tell. Final verification task-1 is open.',
    spec: { specId: SPEC, revision: 1, targetSha: 'abc1234def', buildDone: true, standings: standings.map(([criterionId, standing]) => ({ criterionId, standing, headSha: null })) },
  }],
});
const ctx = { branch: 'direct' as const, prMerged: false, target: null, buildComplete: true };
const BY = 'user:u1';

describe('settleSpecWaive', () => {
  const st = stateOf([['R-1', 'pass'], ['R-2', 'pass'], ['R-28', 'inconclusive'], ['AC-7', 'inconclusive']]);

  it('records unmet criteria as waived and the row reads waived, bar closed, passed count unchanged', () => {
    const s = settleSpecWaive([crit], st, BY)!;
    expect(s.waivedIds.sort()).toEqual(['AC-7', 'R-28']);
    const c = s.goalCriteria[0] as LivingSpecGoalCriterion;
    expect(c.waived?.map(w => [w.criterionId, w.by])).toEqual([['AC-7', BY], ['R-28', BY]]);
    const [row] = criteriaChecks(s.goalCriteria, s.goalCriteriaState, ctx);
    expect(row.status).toBe('waived');
    expect(openCriteriaCount(s.goalCriteria, s.goalCriteriaState, ctx)).toBe(0);
    const v = outcomeSpecView(c, s.goalCriteriaState.criteria[0]);
    expect(v.passed).toBe(2);
    expect(v.short).toBe('2 of 4 pass');
    expect(s.goalCriteriaState.criteria[0].workerTaskId).toBeUndefined();
  });

  it('before the settle the same state reads verifying and open', () => {
    expect(criteriaChecks([crit], st, ctx)[0].status).toBe('running');
    expect(openCriteriaCount([crit], st, ctx)).toBe(1);
  });

  it('is idempotent', () => {
    const once = settleSpecWaive([crit], st, BY)!;
    expect(settleSpecWaive(once.goalCriteria, once.goalCriteriaState, BY)).toBeNull();
  });

  it('leaves a mission whose spec is all passed unchanged', () => {
    expect(settleSpecWaive([crit], stateOf([['R-1', 'pass']]), BY)).toBeNull();
  });

  it('waives a failing criterion too, since a person closed it, and never reads it as passed', () => {
    const s = settleSpecWaive([crit], stateOf([['R-1', 'pass'], ['R-2', 'fail']], 'fail'), BY)!;
    expect(criteriaChecks(s.goalCriteria, s.goalCriteriaState, ctx)[0].status).toBe('waived');
    expect(outcomeSpecView(s.goalCriteria[0] as LivingSpecGoalCriterion, s.goalCriteriaState.criteria[0]).passed).toBe(1);
  });

  it('without a waive the unmet criteria keep blocking', () => {
    expect(openCriteriaCount([crit], st, ctx)).toBe(1);
    expect(settleSpecWaive([crit], null, BY)).toBeNull();
  });
});
