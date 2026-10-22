import { describe, it, expect } from 'bun:test';
import {
  validateGoalCriteria,
  criterionFingerprint,
  evaluateGoalCriteria,
  recalculateOverall,
  isStandardCriterion,
  countedGoalCriteria,
  MAX_GOAL_CRITERIA,
  outcomeSpecWriteRefusal,
} from '../mission-helpers';
import type { GoalCriterion, LivingSpecGoalCriterion } from '@buildd/shared';

// Living Specs D-43: a workspace standard rides on the mission as a
// `living_spec` entry tagged `role: 'standard'`. It never counts toward
// MAX_GOAL_CRITERIA nor toward the goal criteria's overall verdict.

const outcome: LivingSpecGoalCriterion = { type: 'living_spec', specId: 's-outcome', specRevisionId: 'r1', revision: 1, contentHash: 'a'.repeat(64) };
const standard: LivingSpecGoalCriterion = { type: 'living_spec', specId: 's-voice', specRevisionId: 'r2', revision: 2, contentHash: 'b'.repeat(64), role: 'standard' };

describe('standards on a mission (D-43)', () => {
  it('tells a standard from the selected outcome spec', () => {
    expect(isStandardCriterion(standard)).toBe(true);
    expect(isStandardCriterion(outcome)).toBe(false);
    expect(isStandardCriterion({ type: 'no_open_tasks', role: 'standard' })).toBe(false);
  });

  it('does not count standards toward MAX_GOAL_CRITERIA', () => {
    const twenty: GoalCriterion[] = Array.from({ length: MAX_GOAL_CRITERIA }, (_, i) => ({ type: 'artifact_exists', key: `k${i}` }));
    const standards = [standard, { ...standard, specId: 's-design', specRevisionId: 'r3' }];
    const all = [...twenty, ...standards];
    expect(countedGoalCriteria(all)).toBe(MAX_GOAL_CRITERIA);
    // A full-list save keeps the stored standards unchanged and stays within the cap.
    expect(validateGoalCriteria(all, { stored: all })).toBeNull();
  });

  it('leaves standards out of the overall verdict: a failing standard does not fail the goal criteria', () => {
    const overall = recalculateOverall([
      { index: 0, type: 'no_open_tasks', verdict: 'pass' },
      { index: 1, type: 'living_spec', verdict: 'fail', standard: true },
    ]);
    expect(overall).toBe('pass');
  });

  it('marks the evaluated entry of a standard, and only of a standard', () => {
    const state = evaluateGoalCriteria({ id: 'm' }, [outcome, standard], { tasks: [], workers: [], artifacts: [], evaluatedBy: 'auto' } as any);
    expect(state.criteria[0].standard).toBeUndefined();
    expect(state.criteria[1].standard).toBe(true);
    // The outcome spec still holds the overall verdict until it is verified.
    expect(state.overall).not.toBe('pass');
  });

  it('gives a standard its own identity, and keeps the outcome spec fingerprint unchanged', () => {
    const { role: _r, ...untagged } = standard;
    expect(criterionFingerprint(standard)).not.toBe(criterionFingerprint(untagged));
    expect(criterionFingerprint(outcome)).toBe(criterionFingerprint({ ...outcome }));
  });

  it('refuses a goalCriteria write that drops a stored standard (only the snapshot writes them)', () => {
    expect(outcomeSpecWriteRefusal([standard], [])).not.toBeNull();
    expect(outcomeSpecWriteRefusal([standard], [standard])).toBeNull();
  });
});
