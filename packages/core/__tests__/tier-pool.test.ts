import { describe, it, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  CHAT_CHAIN_IDLE_MS,
  CHAT_FEEDBACK_REASONS,
  agentUnitSeverity,
  chatTurnSeverity,
  continuesChain,
  decideAgentArm,
  drawPoolArm,
  incumbentOnly,
  incumbentRoute,
  isArmRoute,
  pickArm,
  poolEligibility,
  summarizeArm,
  tierAllowsPool,
  validateAllocation,
  withoutArm,
  type PoolArmRef,
  type PoolEligibilityInput,
} from '../tier-pool';

const INC = 'arm-incumbent';
const C1 = 'arm-challenger-1';
const C2 = 'arm-challenger-2';
const arms: PoolArmRef[] = [
  { id: INC, role: 'incumbent', status: 'active' },
  { id: C1, role: 'challenger', status: 'active' },
  { id: C2, role: 'challenger', status: 'active' },
];

describe('validateAllocation', () => {
  it('accepts a split inside the bounds and fills missing active arms with 0', () => {
    const r = validateAllocation({ [INC]: 0.8, [C1]: 0.2 }, arms);
    expect(r).toEqual({ ok: true, allocation: { [INC]: 0.8, [C1]: 0.2, [C2]: 0 } });
  });

  it('rejects shares that do not sum to 1', () => {
    const r = validateAllocation({ [INC]: 0.8, [C1]: 0.1 }, arms);
    expect(r.ok).toBe(false);
  });

  it('rejects a percentage typed as a whole number rather than clamping it', () => {
    const r = validateAllocation({ [INC]: 80, [C1]: 20 }, arms);
    expect(r.ok).toBe(false);
  });

  it('keeps the incumbent at or above its floor', () => {
    const r = validateAllocation({ [INC]: 0.5, [C1]: 0.25, [C2]: 0.25 }, arms);
    expect(r).toEqual({ ok: false, error: expect.stringContaining('60%') });
  });

  it('caps the challengers together', () => {
    const r = validateAllocation({ [INC]: 0.65, [C1]: 0.35 }, arms, { incumbentFloor: 0.6, explorationCap: 0.3 });
    expect(r).toEqual({ ok: false, error: expect.stringContaining('30%') });
  });

  it('refuses traffic on an arm that is not active', () => {
    const r = validateAllocation({ [INC]: 0.9, x: 0.1 }, arms);
    expect(r.ok).toBe(false);
    const paused = validateAllocation({ [INC]: 0.9, [C1]: 0.1 }, [arms[0], { ...arms[1], status: 'paused' }]);
    expect(paused.ok).toBe(false);
  });

  it('refuses a pool with no incumbent', () => {
    expect(validateAllocation({ [C1]: 1 }, [arms[1]]).ok).toBe(false);
  });
});

describe('incumbentOnly / withoutArm', () => {
  it('puts everything on the incumbent', () => {
    expect(incumbentOnly(arms)).toEqual({ [INC]: 1, [C1]: 0, [C2]: 0 });
  });
  it("hands a leaving arm's share to the incumbent", () => {
    expect(withoutArm({ [INC]: 0.8, [C1]: 0.15, [C2]: 0.05 }, C1, INC)).toEqual({ [INC]: 0.95, [C2]: 0.05 });
  });
});

describe('pickArm', () => {
  const alloc = { [INC]: 0.7, [C1]: 0.2, [C2]: 0.1 };
  const order = [INC, C1, C2];
  it('walks cumulative intervals in the given order', () => {
    expect(pickArm(alloc, order, 0)!.armId).toBe(INC);
    expect(pickArm(alloc, order, 0.69)!.armId).toBe(INC);
    expect(pickArm(alloc, order, 0.7)!.armId).toBe(C1);
    expect(pickArm(alloc, order, 0.95)!.armId).toBe(C2);
  });
  it('records the share in effect as the propensity', () => {
    expect(pickArm(alloc, order, 0.75)).toEqual({ armId: C1, propensity: 0.2 });
  });
  it('skips arms with no share and lands on the first arm under rounding', () => {
    expect(pickArm({ [INC]: 0.9999, [C1]: 0 }, [INC, C1], 0.99995)!.armId).toBe(INC);
  });
  it('never hands a share with no live arm to a challenger', () => {
    // A share left on an arm that is no longer in armOrder (removed) must
    // not spill onto the last challenger past its cap: it falls to the base.
    expect(pickArm({ [INC]: 0.6, [C1]: 0.2, [C2]: 0.2 }, [INC, C2], 0.9)!.armId).toBe(INC);
  });
  it('is null with nothing allocated', () => {
    expect(pickArm({}, order, 0.3)).toBeNull();
  });
});

describe('drawPoolArm', () => {
  it('is deterministic for the same experiment, version and key', () => {
    const args = { experimentId: randomUUID(), policyVersion: 1, drawKey: randomUUID(), allocation: { [INC]: 0.7, [C1]: 0.3 }, armOrder: [INC, C1] };
    expect(drawPoolArm(args)).toEqual(drawPoolArm(args));
  });
  it('spreads units roughly by share', () => {
    const experimentId = randomUUID();
    let c = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) {
      const d = drawPoolArm({ experimentId, policyVersion: 1, drawKey: randomUUID(), allocation: { [INC]: 0.8, [C1]: 0.2 }, armOrder: [INC, C1] });
      if (d!.armId === C1) c++;
    }
    expect(c / n).toBeGreaterThan(0.17);
    expect(c / n).toBeLessThan(0.23);
  });
});

const eligible: PoolEligibilityInput = {
  tier: 'standard', mode: 'split', frozen: false, workspaceSensitive: false, workspaceOverride: false,
  explicitModel: null, roleModel: null, category: null, reviewerFor: undefined,
  budgetPressure: 0.1, maxBudgetPressure: 0.5, inModelRoutingExperiment: false,
};

describe('poolEligibility', () => {
  it('admits a plain unit on a split pool', () => {
    expect(poolEligibility(eligible)).toEqual({ eligible: true });
  });
  const cases: Array<[string, Partial<PoolEligibilityInput>, string]> = [
    ['premium-plus never explores', { tier: 'premium-plus' }, 'tier_excluded'],
    ['a pinned pool draws nothing', { mode: 'pinned' }, 'pool_not_split'],
    ['a frozen pool draws nothing', { frozen: true }, 'pool_not_split'],
    ['sensitive workspaces stay on the incumbent', { workspaceSensitive: true }, 'sensitive_workspace'],
    ['a workspace registry override has its own incumbent', { workspaceOverride: true }, 'workspace_override'],
    ['an explicit model is never overridden', { explicitModel: 'claude-opus-5' }, 'explicit_model'],
    ['a role pinned to a full id is never overridden', { roleModel: 'claude-opus-5' }, 'role_model_pinned'],
    ['reviewer tasks keep a fixed model', { category: 'review', reviewerFor: { prNumber: 1 } }, 'reviewer_task'],
    ['one experiment per unit', { inModelRoutingExperiment: true }, 'model_routing_experiment'],
    ['budget pressure at the cap excludes', { budgetPressure: 0.5 }, 'budget_pressure'],
  ];
  for (const [name, patch, reason] of cases) {
    it(name, () => {
      expect(poolEligibility({ ...eligible, ...patch })).toEqual({ eligible: false, reason: reason as never });
    });
  }
  it('a role floor that names a tier is not a pin', () => {
    expect(poolEligibility({ ...eligible, roleModel: 'sonnet' })).toEqual({ eligible: true });
    expect(poolEligibility({ ...eligible, roleModel: 'standard' })).toEqual({ eligible: true });
  });
  it('chat turns carry no budget pressure', () => {
    expect(poolEligibility({ ...eligible, budgetPressure: undefined, maxBudgetPressure: undefined })).toEqual({ eligible: true });
  });
});

describe('tierAllowsPool / routes', () => {
  it('excludes premium-plus', () => {
    expect(tierAllowsPool('premium-plus')).toBe(false);
    expect(tierAllowsPool('budget')).toBe(true);
  });
  it('keeps agent and chat routes apart', () => {
    expect(isArmRoute('agent', 'runner:codex')).toBe(true);
    expect(isArmRoute('agent', 'openrouter')).toBe(false);
    expect(isArmRoute('chat', 'openrouter')).toBe(true);
    expect(isArmRoute('chat', 'runner:claude')).toBe(false);
  });
  it('maps the registry provider to each surface\'s native route', () => {
    expect(incumbentRoute('agent', 'anthropic')).toBe('runner:claude');
    expect(incumbentRoute('agent', 'openai-codex')).toBe('runner:codex');
    expect(incumbentRoute('chat', 'anthropic')).toBe('anthropic');
    expect(incumbentRoute('chat', 'openrouter')).toBe('openrouter');
    expect(incumbentRoute('chat', 'openai-codex')).toBe('anthropic');
  });
});

describe('decideAgentArm', () => {
  const active = new Set([INC, C1]);
  const drawn = () => ({ armId: C1, propensity: 0.2 });
  const base = { taskId: 't1', parentId: null, unitId: 't1', activeArmIds: active, draw: drawn, allocationVersion: 3 };

  it('draws when nothing is recorded', () => {
    expect(decideAgentArm({ ...base, priors: [] })).toEqual({ source: 'drawn', armId: C1, propensity: 0.2, allocationVersion: 3 });
  });
  it('a re-claim reuses its own row, even when the arm has since left', () => {
    const priors = [{ taskId: 't1', unitType: 'task', unitId: 't1', armId: C2, propensity: 0.1, allocationVersion: 1 }];
    expect(decideAgentArm({ ...base, priors })).toEqual({ source: 'existing', armId: C2, propensity: 0.1, allocationVersion: 1 });
  });
  it('a retry inherits its parent\'s arm', () => {
    const priors = [{ taskId: 'p', unitType: 'task', unitId: 'p', armId: INC, propensity: 0.8, allocationVersion: 2 }];
    expect(decideAgentArm({ ...base, parentId: 'p', priors })).toMatchObject({ source: 'inherited', armId: INC });
  });
  it('a mission task takes the mission\'s arm while it is active', () => {
    const priors = [{ taskId: 'other', unitType: 'mission', unitId: 'm1', armId: INC, propensity: 0.8, allocationVersion: 2 }];
    expect(decideAgentArm({ ...base, unitId: 'm1', priors })).toMatchObject({ source: 'unit', armId: INC });
  });
  it('a mission whose arm left the pool draws afresh', () => {
    const priors = [{ taskId: 'other', unitType: 'mission', unitId: 'm1', armId: C2, propensity: 0.1, allocationVersion: 1 }];
    expect(decideAgentArm({ ...base, unitId: 'm1', priors })).toMatchObject({ source: 'drawn', armId: C1 });
  });
  it('is none when the draw has nothing', () => {
    expect(decideAgentArm({ ...base, priors: [], draw: () => null })).toEqual({ source: 'none' });
  });
});

describe('continuesChain', () => {
  const now = new Date('2026-09-26T12:00:00Z');
  const active = new Set([INC, C1]);
  const prev = { tier: 'standard', createdAt: new Date(now.getTime() - 60_000), armId: C1 };
  it('keeps the arm on the next turn at the same tier', () => {
    expect(continuesChain({ previous: prev, tier: 'standard', now, activeArmIds: active })).toBe(C1);
  });
  it('ends when the tier changes', () => {
    expect(continuesChain({ previous: prev, tier: 'premium', now, activeArmIds: active })).toBeNull();
  });
  it('ends after the idle window', () => {
    const old = { ...prev, createdAt: new Date(now.getTime() - CHAT_CHAIN_IDLE_MS - 1) };
    expect(continuesChain({ previous: old, tier: 'standard', now, activeArmIds: active })).toBeNull();
  });
  it('ends when the arm is no longer active', () => {
    expect(continuesChain({ previous: prev, tier: 'standard', now, activeArmIds: new Set([INC]) })).toBeNull();
  });
  it('starts a chain with no previous turn', () => {
    expect(continuesChain({ previous: null, tier: 'standard', now, activeArmIds: active })).toBeNull();
  });
});

describe('severity', () => {
  it('maps every thumbs-down reason', () => {
    expect(CHAT_FEEDBACK_REASONS.length).toBe(5);
    expect(chatTurnSeverity('down', 'wrong_answer')).toBe('major');
    expect(chatTurnSeverity('down', 'wrong_action')).toBe('major');
    expect(chatTurnSeverity('down', 'made_up')).toBe('major');
    expect(chatTurnSeverity('down', 'ignored_me')).toBe('minor');
    expect(chatTurnSeverity('down', 'too_slow')).toBe('none');
    expect(chatTurnSeverity('down', null)).toBe('minor');
  });
  it('a thumbs-up is no mistake; no thumbs is not graded', () => {
    expect(chatTurnSeverity('up', null)).toBe('none');
    expect(chatTurnSeverity(null, null)).toBeNull();
    expect(chatTurnSeverity('dismiss', null)).toBeNull();
  });
  it('grades agent outcomes, leaving infra failures ungraded', () => {
    const infra = new Set(['infra_failure']);
    expect(agentUnitSeverity({ outcome: 'completed' }, infra)).toBe('none');
    expect(agentUnitSeverity({ outcome: 'failed', exitCause: 'error' }, infra)).toBe('major');
    expect(agentUnitSeverity({ outcome: 'failed', exitCause: 'infra_failure' }, infra)).toBeNull();
    expect(agentUnitSeverity(null, infra)).toBeNull();
  });
});

describe('summarizeArm', () => {
  it('counts units, wins, severity, cost and latency', () => {
    const s = summarizeArm([
      { severity: 'none', costUsd: 0.02, latencyMs: 1000 },
      { severity: 'none', costUsd: 0.04, latencyMs: 3000 },
      { severity: 'major', costUsd: null, latencyMs: 2000 },
      { severity: null, costUsd: 0.03, latencyMs: null },
    ]);
    expect(s.units).toBe(4);
    expect(s.graded).toBe(3);
    expect(s.wins).toBe(2);
    expect(s.winRate).toBeCloseTo(2 / 3);
    expect(s.severity).toEqual({ none: 2, minor: 0, major: 1, critical: 0 });
    expect(s.meanQuality).toBeCloseTo((1 + 1 + 0.3) / 3);
    expect(s.costPer1k).toBeCloseTo(30);
    expect(s.latencyP50Ms).toBe(2000);
  });
  it('reports nothing it does not have', () => {
    expect(summarizeArm([])).toMatchObject({ units: 0, winRate: null, costPer1k: null, latencyP50Ms: null, meanQuality: null });
  });
});
