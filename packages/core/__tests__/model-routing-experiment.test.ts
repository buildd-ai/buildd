import { describe, it, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_MAX_BUDGET_PRESSURE,
  DEFAULT_MIN_SAMPLE_PER_ARM,
  assignArm,
  decideArm,
  isEligible,
  parseModelRoutingConfig,
  resolveInheritanceParent,
  resolveUnit,
  treatmentApplicable,
  type EligibilityInput,
  type IneligibleReason,
} from '../model-routing-experiment';

const EXP = '5b0f6c1e-0000-4000-8000-000000000001';

const base: EligibilityInput = {
  backend: 'claude',
  explicitModel: null,
  taskTier: null,
  roleModel: null,
  routerReason: 'baseline',
  routerModel: 'sonnet',
  taskClass: 'work',
  kind: 'engineering',
  category: 'feature',
  reviewerFor: undefined,
  budgetPressure: 0.1,
  maxBudgetPressure: 0.5,
};

describe('isEligible', () => {
  it('admits a baseline standard-tier claude work task', () => {
    expect(isEligible(base)).toEqual({ eligible: true, reason: null });
  });

  it("treats role model 'inherit' and a null role model as unpinned", () => {
    expect(isEligible({ ...base, roleModel: 'inherit' }).eligible).toBe(true);
    expect(isEligible({ ...base, roleModel: null }).eligible).toBe(true);
  });

  it('treats a missing kind as eligible (kind is stratified, not filtered)', () => {
    expect(isEligible({ ...base, kind: null }).eligible).toBe(true);
  });

  const cases: Array<[IneligibleReason, Partial<EligibilityInput>]> = [
    ['backend_not_claude', { backend: 'codex' }],
    ['explicit_model', { explicitModel: 'claude-sonnet-5' }],
    ['task_tier_pinned', { taskTier: 'standard' }],
    ['role_model_pinned', { roleModel: 'premium' }],
    ['role_model_pinned', { roleModel: 'claude-opus-5' }],
    ['reviewer_task', { category: 'review' }],
    ['reviewer_task', { reviewerFor: 'parent-task' }],
    ['task_class_not_work', { taskClass: 'attempt' }],
    ['task_class_not_work', { taskClass: 'bookkeeping' }],
    ['kind_observation', { kind: 'observation' }],
    ['router_not_baseline', { routerReason: 'budget_downshift' }],
    ['router_not_baseline', { routerReason: 'spike_downshift' }],
    ['router_not_baseline', { routerReason: 'role_floor_clamp' }],
    ['tier_not_standard', { routerModel: 'opus' }],
    ['tier_not_standard', { routerModel: 'haiku' }],
    ['budget_pressure', { budgetPressure: 0.5 }],
    ['budget_pressure', { budgetPressure: 0.9 }],
    ['budget_pressure', { budgetPressure: Number.NaN }],
  ];
  for (const [reason, over] of cases) {
    it(`rejects ${reason} for ${JSON.stringify(over)}`, () => {
      expect(isEligible({ ...base, ...over })).toEqual({ eligible: false, reason });
    });
  }

  it('reports the pin before the budget when both apply', () => {
    expect(isEligible({ ...base, explicitModel: 'x', budgetPressure: 0.99 }).reason).toBe('explicit_model');
  });
});

describe('resolveUnit', () => {
  it('uses the mission when the task has one', () => {
    expect(resolveUnit({ id: 't1', missionId: 'm1' })).toEqual({ unitType: 'mission', unitId: 'm1' });
  });
  it('falls back to the task', () => {
    expect(resolveUnit({ id: 't1', missionId: null })).toEqual({ unitType: 'task', unitId: 't1' });
    expect(resolveUnit({ id: 't1' })).toEqual({ unitType: 'task', unitId: 't1' });
  });
});

describe('assignArm', () => {
  it('is deterministic per unit', () => {
    const unitId = randomUUID();
    const a = assignArm({ experimentId: EXP, policyVersion: 1, unitId, treatmentFraction: 0.5 });
    for (let i = 0; i < 20; i++) {
      expect(assignArm({ experimentId: EXP, policyVersion: 1, unitId, treatmentFraction: 0.5 })).toEqual(a);
    }
  });

  it('lands the configured fraction within tolerance over 10k units', () => {
    for (const fraction of [0.5, 0.2]) {
      let treated = 0;
      for (let i = 0; i < 10_000; i++) {
        const { arm, propensity } = assignArm({ experimentId: EXP, policyVersion: 1, unitId: randomUUID(), treatmentFraction: fraction });
        if (arm === 'treatment') {
          treated++;
          expect(propensity).toBe(fraction);
        } else {
          expect(propensity).toBeCloseTo(1 - fraction, 10);
        }
      }
      // ±3 percentage points is > 6 standard errors at n = 10k.
      expect(Math.abs(treated / 10_000 - fraction)).toBeLessThan(0.03);
    }
  });

  it('re-randomises when the policy version is bumped', () => {
    let moved = 0;
    for (let i = 0; i < 1000; i++) {
      const unitId = randomUUID();
      const v1 = assignArm({ experimentId: EXP, policyVersion: 1, unitId, treatmentFraction: 0.5 }).arm;
      const v2 = assignArm({ experimentId: EXP, policyVersion: 2, unitId, treatmentFraction: 0.5 }).arm;
      if (v1 !== v2) moved++;
    }
    expect(moved).toBeGreaterThan(350);
    expect(moved).toBeLessThan(650);
  });

  it('runs the control with propensity 1 for out-of-range or junk fractions', () => {
    for (const f of [1.5, 15, -0.1, Number.NaN, 'abc', null, undefined]) {
      expect(assignArm({ experimentId: EXP, policyVersion: 1, unitId: randomUUID(), treatmentFraction: f }))
        .toEqual({ arm: 'control', propensity: 1 });
    }
  });

  it('accepts a numeric string fraction (real columns can arrive as strings)', () => {
    let treated = 0;
    for (let i = 0; i < 2000; i++) {
      if (assignArm({ experimentId: EXP, policyVersion: 1, unitId: randomUUID(), treatmentFraction: '0.5' }).arm === 'treatment') treated++;
    }
    expect(treated).toBeGreaterThan(800);
  });
});

describe('resolveInheritanceParent', () => {
  it('returns the parent for attempt tasks', () => {
    expect(resolveInheritanceParent({ parentTaskId: 'p', taskClass: 'attempt' })).toBe('p');
  });
  it('ignores parentTaskId on work tasks (creator lineage, not retry lineage)', () => {
    expect(resolveInheritanceParent({ parentTaskId: 'p', taskClass: 'work' })).toBeNull();
  });
  it('never inherits for reviewer tasks', () => {
    expect(resolveInheritanceParent({ parentTaskId: 'p', taskClass: 'attempt', category: 'review' })).toBeNull();
    expect(resolveInheritanceParent({ parentTaskId: 'p', taskClass: 'attempt', reviewerFor: 'p' })).toBeNull();
  });
  it('returns null for an attempt with no parent', () => {
    expect(resolveInheritanceParent({ parentTaskId: null, taskClass: 'attempt' })).toBeNull();
  });
});

describe('decideArm', () => {
  const experiment = { id: EXP, policyVersion: 1, treatmentFraction: 0.5 };
  const eligible = () => ({ eligible: true as const, reason: null });

  it('reuses the task\'s own existing row without re-judging eligibility', () => {
    let judged = false;
    const d = decideArm({
      experiment, task: { id: 't1' }, inheritanceParentId: null,
      priors: [{ taskId: 't1', unitType: 'task', unitId: 't1', arm: 'treatment', propensity: 0.5 }],
      eligibility: () => { judged = true; return { eligible: false, reason: 'explicit_model' }; },
    });
    expect(judged).toBe(false);
    expect(d).toMatchObject({ source: 'existing', arm: 'treatment', propensity: 0.5 });
  });

  it('inherits the parent\'s arm and unit instead of drawing', () => {
    // Find a parent/child id pair whose independent draws DISAGREE, so the test
    // fails if inheritance silently falls through to a fresh draw.
    let childId = '';
    let parentArm: 'control' | 'treatment' = 'control';
    for (;;) {
      const p = randomUUID();
      const c = randomUUID();
      const pa = assignArm({ experimentId: EXP, policyVersion: 1, unitId: p, treatmentFraction: 0.5 }).arm;
      const ca = assignArm({ experimentId: EXP, policyVersion: 1, unitId: c, treatmentFraction: 0.5 }).arm;
      if (pa !== ca) { childId = c; parentArm = pa; break; }
    }
    const d = decideArm({
      experiment, task: { id: childId }, inheritanceParentId: 'parent',
      priors: [{ taskId: 'parent', unitType: 'task', unitId: 'parent', arm: parentArm, propensity: 0.5 }],
      eligibility: () => ({ eligible: false, reason: 'task_class_not_work' }),
    });
    expect(d).toMatchObject({ source: 'inherited', arm: parentArm, inheritedFromTaskId: 'parent', unit: { unitType: 'task', unitId: 'parent' } });
  });

  it('judges eligibility when the parent has no row', () => {
    const d = decideArm({
      experiment, task: { id: 't1' }, inheritanceParentId: 'parent', priors: [],
      eligibility: () => ({ eligible: false, reason: 'task_class_not_work' }),
    });
    expect(d).toEqual({ source: 'ineligible', reason: 'task_class_not_work' });
  });

  it('draws on the mission unit so every task in a mission shares an arm', () => {
    const missionId = randomUUID();
    const arms = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const d = decideArm({ experiment, task: { id: randomUUID(), missionId }, inheritanceParentId: null, priors: [], eligibility: eligible });
      if (d.source !== 'drawn') throw new Error('expected a draw');
      expect(d.unit).toEqual({ unitType: 'mission', unitId: missionId });
      arms.add(d.arm);
    }
    expect(arms.size).toBe(1);
  });
});

describe('treatmentApplicable', () => {
  it('applies on the tier path for unpinned claude tasks', () => {
    expect(treatmentApplicable({ routerReason: 'baseline', taskTier: null, backend: 'claude' })).toBe(true);
  });
  it('never overrides an explicit model, a task tier, or another backend', () => {
    expect(treatmentApplicable({ routerReason: 'explicit_override', taskTier: null, backend: 'claude' })).toBe(false);
    expect(treatmentApplicable({ routerReason: 'baseline', taskTier: 'budget', backend: 'claude' })).toBe(false);
    expect(treatmentApplicable({ routerReason: 'baseline', taskTier: null, backend: 'codex' })).toBe(false);
  });
});

describe('parseModelRoutingConfig', () => {
  it('defaults every field on an empty or junk config', () => {
    for (const raw of [{}, null, 'x', [], { arms: 5 }]) {
      expect(parseModelRoutingConfig(raw)).toEqual({
        treatmentTier: 'premium',
        maxBudgetPressure: DEFAULT_MAX_BUDGET_PRESSURE,
        minSamplePerArm: DEFAULT_MIN_SAMPLE_PER_ARM,
      });
    }
  });
  it('reads valid fields and rejects out-of-range ones', () => {
    expect(parseModelRoutingConfig({
      arms: { treatment: { tier: 'premium-plus' } }, eligibility: { maxBudgetPressure: 0.3 }, minSamplePerArm: 50,
    })).toEqual({ treatmentTier: 'premium-plus', maxBudgetPressure: 0.3, minSamplePerArm: 50 });
    expect(parseModelRoutingConfig({
      arms: { treatment: { tier: 'ultra' } }, eligibility: { maxBudgetPressure: 5 }, minSamplePerArm: -1,
    })).toEqual({ treatmentTier: 'premium', maxBudgetPressure: DEFAULT_MAX_BUDGET_PRESSURE, minSamplePerArm: DEFAULT_MIN_SAMPLE_PER_ARM });
  });
});
