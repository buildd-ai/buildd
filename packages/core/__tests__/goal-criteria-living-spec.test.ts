import { describe, it, expect } from 'bun:test';
import {
  validateGoalCriteria,
  criterionFingerprint,
  evaluateGoalCriteria,
  MECHANICAL_CRITERION_TYPES,
  deliverableRole,
} from '../mission-helpers';
import type { GoalCriterion, LivingSpecGoalCriterion } from '@buildd/shared';

// Living Specs Slice 12: a mission's selected outcome spec is a typed goal
// criterion written by the server. These pin the write boundary, identity and
// the pure evaluator's answer (never a pass on its own).

const SPEC = '11111111-1111-4111-8111-111111111111';
const REV = '22222222-2222-4222-8222-222222222222';
const base: LivingSpecGoalCriterion = { type: 'living_spec', specId: SPEC, specRevisionId: REV, revision: 3, contentHash: 'a'.repeat(64) };

describe('living_spec criterion: write boundary', () => {
  it('is a mechanical criterion: its verdict comes from recorded evidence, not a model', () => {
    expect(MECHANICAL_CRITERION_TYPES as readonly string[]).toContain('living_spec');
  });

  it('refuses a new living_spec criterion written straight into goalCriteria: selection is the one write path', () => {
    const err = validateGoalCriteria([{ type: 'no_open_tasks' }, base]);
    expect(err).toContain('outcomeSpec');
  });

  it('passes a stored living_spec criterion through unchanged (the dashboard re-saves the whole array)', () => {
    expect(validateGoalCriteria([{ type: 'no_open_tasks' }, base], { stored: [{ type: 'no_open_tasks' }, base] })).toBeNull();
  });

  it('refuses an edited living_spec criterion (a caller-written hash is never trusted)', () => {
    const edited = { ...base, contentHash: 'b'.repeat(64) };
    expect(validateGoalCriteria([edited], { stored: [base] })).toContain('outcomeSpec');
  });
});

describe('living_spec criterion: identity', () => {
  const fp = (c: GoalCriterion) => criterionFingerprint(c);

  it('changes with the revision, the hash, the scope and the waivers, so no verdict carries across', () => {
    const f0 = fp(base);
    expect(fp({ ...base, specRevisionId: '33333333-3333-4333-8333-333333333333', revision: 4 })).not.toBe(f0);
    expect(fp({ ...base, contentHash: 'c'.repeat(64) })).not.toBe(f0);
    expect(fp({ ...base, criteria: ['R-1'], narrowedReason: 'only the API half ships here' })).not.toBe(f0);
    expect(fp({ ...base, waived: [{ criterionId: 'R-2', reason: 'owner accepted the gap', by: 'user:x', at: '2026-10-14T00:00:00Z' }] })).not.toBe(f0);
  });

  it('is order-independent over scope ids', () => {
    expect(fp({ ...base, criteria: ['R-2', 'R-1'], narrowedReason: 'x'.repeat(12) }))
      .toBe(fp({ ...base, criteria: ['R-1', 'R-2'], narrowedReason: 'x'.repeat(12) }));
  });
});

describe('living_spec criterion: pure evaluator', () => {
  it('never passes on its own: the integrated verdicts are read by the DB layer', () => {
    const state = evaluateGoalCriteria({ id: 'm' }, [base], { tasks: [], workers: [], artifacts: [], evaluatedBy: 'auto' });
    expect(state.criteria[0].verdict).toBe('NOT_EVALUATED');
    expect(state.overall).toBe('UNVERIFIED');
  });
});

describe('final verification and spec repair tasks stay out of the build count', () => {
  it('reads a final verification task as verification and a spec repair as repair', () => {
    expect(deliverableRole({ title: '[final verification] Mission spec', context: { finalVerification: { missionId: 'm' } } })).toBe('verification');
    expect(deliverableRole({ title: '[spec repair] R-3: empty state copy', context: { specRepair: { missionId: 'm', criterionId: 'R-3' } } })).toBe('repair');
  });
});
