import { describe, expect, mock, test } from 'bun:test';
import type { GatedSubject } from './escalation-gate-check';
import { escalationRuleExecutor, policyAllowsRuleMerge } from './escalation-rule-executor';

const s = (over: Partial<GatedSubject> = {}): GatedSubject => ({
  key: 'pr:ws:7', workspaceId: 'ws', prNumber: 7, taskId: 't7', missionId: null, title: 't', why: 'reviewer_escalated',
  ci: 'green', conflict: false, machineActing: false, missionPrRole: null, headSha: 'h1', teamId: 'team', ...over,
});
const agentReview = { tier: 'agent-review' as const, agentReview: { reviewerRole: 'reviewer', gateCondition: 'approve-and-merge' as const } };

describe('policyAllowsRuleMerge: never around the workspace merge policy', () => {
  test('agent-review approve-and-merge and auto-threshold let the platform land', () => {
    expect(policyAllowsRuleMerge(agentReview as any)).toBe(true);
    expect(policyAllowsRuleMerge({ tier: 'auto-threshold' } as any)).toBe(true);
  });
  test('human tier, approve-only, or no policy keep the person\'s merge', () => {
    expect(policyAllowsRuleMerge({ tier: 'human' } as any)).toBe(false);
    expect(policyAllowsRuleMerge({ tier: 'agent-review', agentReview: { gateCondition: 'approve-only' } } as any)).toBe(false);
    expect(policyAllowsRuleMerge(null)).toBe(false);
  });
});

describe('escalationRuleExecutor', () => {
  test('policy_merge approves the head through the kernel when the policy lets the platform land', async () => {
    const policyMerge = mock(async (_p: any) => ({ result: 'applied' }));
    await escalationRuleExecutor({ loadPolicy: async () => agentReview as any, policyMerge })(s(), 'policy_merge');
    expect(policyMerge).toHaveBeenCalledTimes(1);
    expect(policyMerge.mock.calls[0]![0]).toMatchObject({ workspaceId: 'ws', prNumber: 7, headSha: 'h1' });
  });

  test('a human-tier workspace: nothing runs', async () => {
    const policyMerge = mock(async (_p: any) => ({}));
    await escalationRuleExecutor({ loadPolicy: async () => ({ tier: 'human' }) as any, policyMerge })(s(), 'policy_merge');
    expect(policyMerge).not.toHaveBeenCalled();
  });

  test('no head or no PR: nothing to pin, nothing runs', async () => {
    const policyMerge = mock(async (_p: any) => ({}));
    const run = escalationRuleExecutor({ loadPolicy: async () => agentReview as any, policyMerge });
    await run(s({ headSha: null }), 'policy_merge');
    await run(s({ prNumber: null }), 'policy_merge');
    expect(policyMerge).not.toHaveBeenCalled();
  });

  test.each(['ci_fix', 'conflict_fix', 'renumber_migration', 'retry_landing', 'wait_ci', 'wait_machine'] as const)('%s is left to the kernel and landing sweeps', async (action) => {
    const policyMerge = mock(async (_p: any) => ({}));
    const loadPolicy = mock(async () => agentReview as any);
    await escalationRuleExecutor({ loadPolicy, policyMerge })(s(), action);
    expect(policyMerge).not.toHaveBeenCalled();
    expect(loadPolicy).not.toHaveBeenCalled();
  });
});
