import { describe, expect, test } from 'bun:test';
import { calibrateClaimConfidence, evaluateClaimLearningCell, type ClaimLearningOutcome } from '../orchestration-claim-learning';
const safe = (actor: ClaimLearningOutcome['actor'] = 'jev_start'): ClaimLearningOutcome => ({
  actor, confidence: .8, attributableUnsafe: false, waitMs: 10
});
const baseline = Array.from({ length: 400 }, () => ({
  ...safe('rule_start_clean'), waitMs: 100
}));
const input = {
  gate: 'soft_overlap', area: 'other', fingerprint: 'fixture', baseline, now: new Date('2026-01-01')
};

describe('claim learning', () => {
  test('human forces and stale blockers never calibrate', () => {
    expect(calibrateClaimConfidence([...Array.from({ length: 400 }, () => safe('human_force')), ...Array.from({ length: 400 }, () => ({
        ...safe(), staleBlocker: true
      }))], baseline)).toBe(.85);
  });
  test('small samples keep the live confidence floor', () => expect(calibrateClaimConfidence([safe()], baseline)).toBe(.85));
  test('chooses the lowest supported confidence', () => expect(calibrateClaimConfidence(Array.from({ length: 400 }, () => safe()), baseline)).toBe(.8));
  test('breach reverts even a pinned live cell', () => {
    const prior = evaluateClaimLearningCell({
      ...input, outcomes: []
    }).policy;
    const result = evaluateClaimLearningCell({
      ...input, prior: {
        ...prior, pinned: true
      }, outcomes: Array.from({ length: 30 }, () => ({
        ...safe(), attributableUnsafe: true
      }))
    });
    expect(result.policy.fraction).toBe(0);
    expect(result.policy.record.state).toBe('reverted');
  });
  test('promotion needs measurable wait or idle improvement', () => {
    const prior = {
      ...evaluateClaimLearningCell({
        ...input, outcomes: []
      }).policy, dial: 2 as const, fraction: .25
    };
    const result = evaluateClaimLearningCell({
      ...input, prior, outcomes: Array.from({ length: 400 }, () => ({
        ...safe(), waitMs: 100
      }))
    });
    expect(result.policy.fraction).toBe(.25);
  });
  test('safe improvement raises only one step', () => {
    const prior = {
      ...evaluateClaimLearningCell({
        ...input, outcomes: []
      }).policy, dial: 2 as const, fraction: .25
    };
    expect(evaluateClaimLearningCell({
      ...input, prior, outcomes: Array.from({ length: 400 }, () => safe())
    }).policy.fraction).toBe(.5);
  });
  test('disagreements are observational', () => {
    const result = evaluateClaimLearningCell({
      ...input, outcomes: [{
          ...safe('human_force'), matchedJevLabel: 'HOLD'
        }, {
          ...safe(), attributableUnsafe: true
        }]
    });
    expect(result.candidates.falseHold).toBe(1);
    expect(result.candidates.falseStart).toBe(1);
  });
  test('stale unsafe outcomes are ownership hygiene, never a safety breach', () => {
    const result = evaluateClaimLearningCell({
      ...input, outcomes: Array.from({ length: 400 }, () => ({
        ...safe(), attributableUnsafe: true, staleBlocker: true
      }))
    });
    expect(result.policy.fraction).toBe(1);
    expect(result.ownershipHygiene).toBe(400);
    expect(result.safety.jevSamples).toBe(0);
  });
  test('reverted cells use the existing cooldown', () => {
    const prior = evaluateClaimLearningCell({
      ...input, outcomes: Array.from({ length: 30 }, () => ({
        ...safe(), attributableUnsafe: true
      }))
    }).policy;
    const result = evaluateClaimLearningCell({
      ...input, prior, outcomes: Array.from({ length: 400 }, () => safe())
    });
    expect(result.policy.record.state).toBe('reverted');
    expect(result.policy.fraction).toBe(0);
  });
  test('human safe outcomes cannot hide Jev attributable harm', () => {
    const result = evaluateClaimLearningCell({
      ...input, outcomes: [...Array.from({ length: 30 }, () => ({
          ...safe(), attributableUnsafe: true
        })), ...Array.from({ length: 400 }, () => safe('human_force'))]
    });
    expect(result.safety.attributableUnsafeRate).toBe(1);
    expect(result.policy.fraction).toBe(0);
  });
  test('duplicate task observations cannot satisfy minimum sample', () => {
    const rows = Array.from({ length: 400 }, () => ({
      ...safe(), taskId: 'fixture-task'
    }));
    expect(calibrateClaimConfidence(rows, baseline)).toBe(.85);
    expect(evaluateClaimLearningCell({
      ...input, outcomes: rows
    }).safety.jevSamples).toBe(1);
  });
  test('a repeated safe observation cannot hide a task attributable harm', () => {
    const outcomes = [{...safe(), taskId:'repeated'}, {...safe(), taskId:'repeated', attributableUnsafe:true}];
    expect(evaluateClaimLearningCell({...input,outcomes}).safety.attributableUnsafeRate).toBe(1);
  });
  test('censored deterministic HOLD is never the unsafe baseline', () => {
    expect(calibrateClaimConfidence(Array.from({ length: 400 }, () => safe()), Array.from({ length: 400 }, () => safe('deterministic_hold')))).toBe(.85);
  });
  test('nonfinite confidence keeps the default threshold', () => {
    expect(calibrateClaimConfidence(Array.from({ length: 400 }, () => ({
      ...safe(), confidence: NaN
    })), baseline)).toBe(.85);
  });
  test('nonfinite policy delta fails closed', () => {
    const prior = {
      ...evaluateClaimLearningCell({
        ...input, outcomes: []
      }).policy, delta: NaN
    };
    expect(evaluateClaimLearningCell({
      ...input, prior, outcomes: []
    }).policy.fraction).toBe(0);
  });
  test('wait improvement uses held controls while safety uses clean starts', () => {
    const prior = {
      ...evaluateClaimLearningCell({
        ...input, outcomes: []
      }).policy, dial: 2 as const, fraction: .25
    };
    const result = evaluateClaimLearningCell({
      ...input, prior, baseline: baseline.map(r => ({
        ...r, waitMs: 0
      })), controlOutcomes: baseline.map(r => ({
        ...r, actor: 'deterministic_hold' as const, waitMs: 100
      })), outcomes: Array.from({ length: 400 }, () => safe())
    });
    expect(result.policy.fraction).toBe(.5);
  });
  test('overlap starts cannot replace the clean base cohort', () => {
    expect(calibrateClaimConfidence(Array.from({ length: 400 }, () => safe()), baseline.map(r => ({
      ...r, actor: 'rule_start_overlap' as const
    })))).toBe(.85);
  });
  test('sample minimum is recorded with policy', () => {
    expect(evaluateClaimLearningCell({
      ...input, outcomes: [], minSamplePerArm: 50
    }).policy.minSamplePerArm).toBe(50);
  });
});
