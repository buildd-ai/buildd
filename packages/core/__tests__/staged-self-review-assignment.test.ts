/**
 * The assignment row for a staged_self_review draw. The runner draws the arm
 * (resolveStagedConfig in apps/runner/src/staged-self-review.ts); the server
 * records the same draw so the readout can see treatment tasks. These tests pin
 * that the recorded row is exactly the arm the runner acts on.
 *
 * Run: bun run scripts/run-unit-tests.ts packages/core/__tests__/staged-self-review-assignment.test.ts
 */
import { describe, test, expect } from 'bun:test';
import { stagedAssignmentRow, assignStagedReviewArm } from '../staged-self-review';

const exp = (treatmentFraction: number, policyVersion = 2) => ({
  id: '11111111-1111-4111-8111-111111111111', treatmentFraction, policyVersion, checklistVersion: 'v1',
});

describe('stagedAssignmentRow', () => {
  test('no row is written unless acting with a registered experiment', () => {
    expect(stagedAssignmentRow('t1', null)).toBeNull();
    expect(stagedAssignmentRow('t1', { selfReview: 'acting' })).toBeNull();
    expect(stagedAssignmentRow('t1', { selfReview: 'off', selfReviewExperiment: exp(1) })).toBeNull();
    expect(stagedAssignmentRow('t1', { selfReview: 'recording', selfReviewExperiment: exp(1) })).toBeNull();
    expect(stagedAssignmentRow('', { selfReview: 'acting', selfReviewExperiment: exp(1) })).toBeNull();
  });

  test('records the same arm and propensity the runner draws for the task', () => {
    const e = exp(0.5, 2);
    const drawn = assignStagedReviewArm({ taskId: 'task-abc', experiment: { id: e.id, policyVersion: 2, treatmentFraction: 0.5 } });
    const row = stagedAssignmentRow('task-abc', { selfReview: 'acting', selfReviewExperiment: e });
    expect(row).not.toBeNull();
    expect(row!.arm).toBe(drawn.arm);
    expect(row!.propensity).toBe(drawn.propensity);
    expect(row!.policyVersion).toBe(2);
    expect(row!.experimentId).toBe(e.id);
    expect(row!.taskId).toBe('task-abc');
    expect(row!.unitType).toBe('task');
    expect(row!.unitId).toBe('task-abc');
  });

  test('treatment fraction 1 is treatment with propensity 1 and served', () => {
    const row = stagedAssignmentRow('t2', { selfReview: 'acting', selfReviewExperiment: exp(1) });
    expect(row).toMatchObject({ arm: 'treatment', served: true, propensity: 1 });
  });

  test('treatment fraction 0 is control, not served', () => {
    const row = stagedAssignmentRow('t3', { selfReview: 'acting', selfReviewExperiment: exp(0) });
    expect(row).toMatchObject({ arm: 'control', served: false, propensity: 1 });
  });

  test('served is true only for a treatment draw', () => {
    const rows = Array.from({ length: 200 }, (_, i) => stagedAssignmentRow(`task-${i}`, { selfReview: 'acting', selfReviewExperiment: exp(0.5) })!);
    for (const r of rows) expect(r.served).toBe(r.arm === 'treatment');
    expect(rows.some(r => r.arm === 'treatment')).toBe(true);
    expect(rows.some(r => r.arm === 'control')).toBe(true);
  });
});
