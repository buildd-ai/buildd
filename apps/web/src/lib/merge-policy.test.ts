import { describe, it, expect } from 'bun:test';
import { resolvePolicy, mergePolicySchema, DEFAULT_MERGE_POLICY, isMissionIntegrationBase } from './merge-policy';
import { parseMergePolicy } from '@buildd/shared';

describe('DEFAULT_MERGE_POLICY', () => {
  it('is auto-threshold with 800 line limit and no deny paths', () => {
    expect(DEFAULT_MERGE_POLICY.tier).toBe('auto-threshold');
    expect(DEFAULT_MERGE_POLICY.threshold?.maxLines).toBe(800);
    expect(DEFAULT_MERGE_POLICY.threshold?.denyPaths).toEqual([]);
  });
});

describe('resolvePolicy precedence', () => {
  it('falls back to default when no context is given', () => {
    const policy = resolvePolicy({ gitConfig: null });
    expect(policy.tier).toBe('auto-threshold');
    expect(policy.threshold?.maxLines).toBe(800);
  });

  it('workspace mergePolicy overrides default', () => {
    const policy = resolvePolicy({ gitConfig: { mergePolicy: { tier: 'human' } } as any });
    expect(policy.tier).toBe('human');
  });

  it('workspace mergePolicy with agent-review is returned as-is', () => {
    const agentPolicy = {
      tier: 'agent-review' as const,
      agentReview: { reviewerRole: 'reviewer', maxConfidenceThreshold: 0.6 },
    };
    const policy = resolvePolicy({ gitConfig: { mergePolicy: agentPolicy } as any });
    expect(policy.tier).toBe('agent-review');
    expect(policy.agentReview?.reviewerRole).toBe('reviewer');
  });

  it('mission mergePolicy overrides workspace policy', () => {
    const policy = resolvePolicy(
      { gitConfig: { mergePolicy: { tier: 'auto-threshold' } } as any },
      { mergePolicy: { tier: 'human' } },
    );
    expect(policy.tier).toBe('human');
  });

  it('null mission mergePolicy falls through to workspace', () => {
    const policy = resolvePolicy(
      { gitConfig: { mergePolicy: { tier: 'human' } } as any },
      { mergePolicy: null },
    );
    expect(policy.tier).toBe('human');
  });

  it('task.requiresReview trumps mission and workspace policy', () => {
    const policy = resolvePolicy(
      { gitConfig: { mergePolicy: { tier: 'auto-threshold' } } as any },
      { mergePolicy: { tier: 'agent-review', agentReview: { reviewerRole: 'r' } } },
      { requiresReview: true },
    );
    expect(policy.tier).toBe('human');
  });

  it('mission.requiresReview overrides workspace policy but not mission mergePolicy', () => {
    const policy = resolvePolicy(
      { gitConfig: { mergePolicy: { tier: 'auto-threshold' } } as any },
      { mergePolicy: null, requiresReview: true },
    );
    expect(policy.tier).toBe('human');
  });

  it('mission mergePolicy beats mission.requiresReview', () => {
    // mission.mergePolicy is checked before mission.requiresReview
    const policy = resolvePolicy(
      { gitConfig: null },
      { mergePolicy: { tier: 'auto-threshold' }, requiresReview: true },
    );
    expect(policy.tier).toBe('auto-threshold');
  });

  it('task.requiresReview:false does not force human tier', () => {
    const policy = resolvePolicy(
      { gitConfig: null },
      null,
      { requiresReview: false },
    );
    expect(policy.tier).toBe('auto-threshold');
  });
});

describe('parseMergePolicy (write-path validation)', () => {
  it('accepts valid auto-threshold policy', () => {
    const result = parseMergePolicy({ tier: 'auto-threshold', threshold: { maxLines: 500, denyPaths: ['src/'] } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.policy.tier).toBe('auto-threshold');
  });

  it('accepts valid agent-review policy', () => {
    const result = parseMergePolicy({
      tier: 'agent-review',
      agentReview: { reviewerRole: 'reviewer', maxConfidenceThreshold: 0.7 },
    });
    expect(result.ok).toBe(true);
  });

  it('accepts valid human policy', () => {
    const result = parseMergePolicy({ tier: 'human' });
    expect(result.ok).toBe(true);
  });

  it('rejects unknown top-level key', () => {
    const result = parseMergePolicy({ tier: 'human', unknownField: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown field/);
  });

  it('rejects unknown threshold key', () => {
    const result = parseMergePolicy({ tier: 'auto-threshold', threshold: { maxLines: 500, approvalMode: 'lgtm' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown field/);
  });

  it('rejects unknown agentReview key', () => {
    const result = parseMergePolicy({ tier: 'agent-review', agentReview: { reviewerRole: 'r', badKey: true } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown field/);
  });

  it('rejects invalid tier', () => {
    const result = parseMergePolicy({ tier: 'approve-only' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe('tier');
  });

  it('rejects non-object', () => {
    const result = parseMergePolicy('auto-threshold');
    expect(result.ok).toBe(false);
  });

  it('rejects agent-review missing reviewerRole', () => {
    const result = parseMergePolicy({ tier: 'agent-review', agentReview: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toMatch(/reviewerRole/);
  });
});

describe('parseMergePolicyRead (fail-soft)', () => {
  it('returns default on malformed stored policy', async () => {
    // Import parseMergePolicyRead directly
    const { parseMergePolicyRead } = await import('./merge-policy');
    const result = parseMergePolicyRead({ tier: 'bogus', approvalMode: 'lgtm' });
    expect(result.tier).toBe('auto-threshold');
  });

  it('returns default on null/undefined', async () => {
    const { parseMergePolicyRead } = await import('./merge-policy');
    expect(parseMergePolicyRead(null).tier).toBe('auto-threshold');
    expect(parseMergePolicyRead(undefined).tier).toBe('auto-threshold');
  });

  it('passes through valid policy unchanged', async () => {
    const { parseMergePolicyRead } = await import('./merge-policy');
    const result = parseMergePolicyRead({ tier: 'human' });
    expect(result.tier).toBe('human');
  });
});

describe('mergePolicySchema', () => {
  it('accepts a valid auto-threshold policy', () => {
    const result = mergePolicySchema.safeParse({
      tier: 'auto-threshold',
      threshold: { maxLines: 500, denyPaths: ['drizzle/'] },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid agent-review policy', () => {
    const result = mergePolicySchema.safeParse({
      tier: 'agent-review',
      agentReview: {
        reviewerRole: 'reviewer',
        maxConfidenceThreshold: 0.6,
        gateCondition: 'approve-and-merge',
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid human policy with stallNotifyMinutes', () => {
    const result = mergePolicySchema.safeParse({ tier: 'human', stallNotifyMinutes: 30 });
    expect(result.success).toBe(true);
  });

  it('rejects unknown top-level keys', () => {
    const result = mergePolicySchema.safeParse({ tier: 'human', unknownKey: 'bad' });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys inside threshold', () => {
    const result = mergePolicySchema.safeParse({
      tier: 'auto-threshold',
      threshold: { maxLines: 100, bogus: true },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys inside agentReview', () => {
    const result = mergePolicySchema.safeParse({
      tier: 'agent-review',
      agentReview: { reviewerRole: 'reviewer', extra: 'bad' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid tier value', () => {
    const result = mergePolicySchema.safeParse({ tier: 'invalid-tier' });
    expect(result.success).toBe(false);
  });

  it('rejects missing tier', () => {
    const result = mergePolicySchema.safeParse({ threshold: { maxLines: 100 } });
    expect(result.success).toBe(false);
  });

  it('rejects invalid gateCondition', () => {
    const result = mergePolicySchema.safeParse({
      tier: 'agent-review',
      agentReview: { reviewerRole: 'reviewer', gateCondition: 'invalid' },
    });
    expect(result.success).toBe(false);
  });
});

describe('mergePolicySchema', () => {
  it('accepts a valid auto-threshold policy', () => {
    const result = mergePolicySchema.safeParse({
      tier: 'auto-threshold',
      threshold: { maxLines: 500, denyPaths: ['drizzle/'] },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid agent-review policy', () => {
    const result = mergePolicySchema.safeParse({
      tier: 'agent-review',
      agentReview: {
        reviewerRole: 'reviewer',
        maxConfidenceThreshold: 0.6,
        gateCondition: 'approve-and-merge',
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid human policy with stallNotifyMinutes', () => {
    const result = mergePolicySchema.safeParse({ tier: 'human', stallNotifyMinutes: 30 });
    expect(result.success).toBe(true);
  });

  it('rejects unknown top-level keys', () => {
    const result = mergePolicySchema.safeParse({ tier: 'human', unknownKey: 'bad' });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys inside threshold', () => {
    const result = mergePolicySchema.safeParse({
      tier: 'auto-threshold',
      threshold: { maxLines: 100, bogus: true },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys inside agentReview', () => {
    const result = mergePolicySchema.safeParse({
      tier: 'agent-review',
      agentReview: { reviewerRole: 'reviewer', extra: 'bad' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid tier value', () => {
    const result = mergePolicySchema.safeParse({ tier: 'invalid-tier' });
    expect(result.success).toBe(false);
  });

  it('rejects missing tier', () => {
    const result = mergePolicySchema.safeParse({ threshold: { maxLines: 100 } });
    expect(result.success).toBe(false);
  });

  it('rejects invalid gateCondition', () => {
    const result = mergePolicySchema.safeParse({
      tier: 'agent-review',
      agentReview: { reviewerRole: 'reviewer', gateCondition: 'invalid' },
    });
    expect(result.success).toBe(false);
  });
});

// ── Option A′: mission integration branch ───────────────────────────────────
// The crux: the merge-policy TIER applies to the MISSION PR (integration branch →
// trunk), not to the task PRs that target the integration branch. A task PR based
// on a quarantined integration branch runs auto-threshold and lands unattended;
// the human / agent-review gate fires exactly once, at the mission PR.
describe('isMissionIntegrationBase', () => {
  const MISSION_BRANCH = 'mission/example-slug-0a1b2c3d';

  it('is true when opted in, workingBranch set, and baseRef matches', () => {
    expect(isMissionIntegrationBase({
      baseRef: MISSION_BRANCH,
      mission: { workingBranch: MISSION_BRANCH, integrationBranchEnabled: true },
    })).toBe(true);
  });

  it('is false when the mission has not opted in', () => {
    expect(isMissionIntegrationBase({
      baseRef: MISSION_BRANCH,
      mission: { workingBranch: MISSION_BRANCH, integrationBranchEnabled: false },
    })).toBe(false);
  });

  it('is false when workingBranch is null even if baseRef is the empty string', () => {
    expect(isMissionIntegrationBase({
      baseRef: '',
      mission: { workingBranch: null, integrationBranchEnabled: true },
    })).toBe(false);
  });

  it('is false when workingBranch is the empty string and baseRef is too', () => {
    // Guards against a "both blank" match: two unset refs are not the same branch.
    expect(isMissionIntegrationBase({
      baseRef: '',
      mission: { workingBranch: '', integrationBranchEnabled: true },
    })).toBe(false);
  });

  it('is false when baseRef is null/undefined', () => {
    expect(isMissionIntegrationBase({
      baseRef: null,
      mission: { workingBranch: MISSION_BRANCH, integrationBranchEnabled: true },
    })).toBe(false);
    expect(isMissionIntegrationBase({
      mission: { workingBranch: MISSION_BRANCH, integrationBranchEnabled: true },
    })).toBe(false);
  });

  it('is false when baseRef points at trunk, not the integration branch', () => {
    expect(isMissionIntegrationBase({
      baseRef: 'dev',
      mission: { workingBranch: MISSION_BRANCH, integrationBranchEnabled: true },
    })).toBe(false);
  });

  it('is false with no mission at all', () => {
    expect(isMissionIntegrationBase({ baseRef: MISSION_BRANCH, mission: null })).toBe(false);
    expect(isMissionIntegrationBase({ baseRef: MISSION_BRANCH })).toBe(false);
  });
});

describe('resolvePolicy — mission integration branch (Option A′)', () => {
  const MISSION_BRANCH = 'mission/example-slug-0a1b2c3d';
  const humanWorkspace = { gitConfig: { mergePolicy: { tier: 'human' } } as any };
  const missionOptedIn = { workingBranch: MISSION_BRANCH, integrationBranchEnabled: true };
  const missionOptedOut = { workingBranch: MISSION_BRANCH, integrationBranchEnabled: false };

  it('drops a human workspace gate to auto-threshold for a task PR based on the integration branch', () => {
    const policy = resolvePolicy(humanWorkspace, missionOptedIn, null, { baseRef: MISSION_BRANCH });
    expect(policy.tier).toBe('auto-threshold');
  });

  it('preserves the resolved threshold when dropping the tier', () => {
    const policy = resolvePolicy(
      { gitConfig: { mergePolicy: { tier: 'human', threshold: { maxLines: 250, denyPaths: ['drizzle/'] } } } as any },
      missionOptedIn,
      null,
      { baseRef: MISSION_BRANCH },
    );
    expect(policy.tier).toBe('auto-threshold');
    expect(policy.threshold?.maxLines).toBe(250);
    expect(policy.threshold?.denyPaths).toEqual(['drizzle/']);
  });

  it('falls back to the default threshold when the resolved policy carries none', () => {
    const policy = resolvePolicy(humanWorkspace, missionOptedIn, null, { baseRef: MISSION_BRANCH });
    expect(policy.threshold?.maxLines).toBe(DEFAULT_MERGE_POLICY.threshold?.maxLines);
    expect(policy.threshold?.denyPaths).toEqual([]);
  });

  it('changes nothing until the mission opts in', () => {
    const policy = resolvePolicy(humanWorkspace, missionOptedOut, null, { baseRef: MISSION_BRANCH });
    expect(policy.tier).toBe('human');
  });

  it('keeps the human gate for the mission PR itself (baseRef = trunk)', () => {
    const policy = resolvePolicy(humanWorkspace, missionOptedIn, null, { baseRef: 'dev' });
    expect(policy.tier).toBe('human');
  });

  it('keeps the human gate when the base ref is unknown (null)', () => {
    const policy = resolvePolicy(humanWorkspace, missionOptedIn, null, { baseRef: null });
    expect(policy.tier).toBe('human');
  });

  it('keeps the human gate when the pr argument is omitted entirely', () => {
    const policy = resolvePolicy(humanWorkspace, missionOptedIn, null);
    expect(policy.tier).toBe('human');
  });

  it('task.requiresReview beats the base-ref rule', () => {
    const policy = resolvePolicy(
      humanWorkspace,
      missionOptedIn,
      { requiresReview: true },
      { baseRef: MISSION_BRANCH },
    );
    expect(policy.tier).toBe('human');
  });

  it('drops mission.mergePolicy agent-review to auto-threshold for an integration-branch task PR', () => {
    const policy = resolvePolicy(
      { gitConfig: null },
      { ...missionOptedIn, mergePolicy: { tier: 'agent-review', agentReview: { reviewerRole: 'reviewer' } } },
      null,
      { baseRef: MISSION_BRANCH },
    );
    expect(policy.tier).toBe('auto-threshold');
    expect(policy.agentReview).toBeUndefined();
  });

  it('drops mission.requiresReview for an integration-branch task PR', () => {
    const policy = resolvePolicy(
      { gitConfig: null },
      { ...missionOptedIn, requiresReview: true },
      null,
      { baseRef: MISSION_BRANCH },
    );
    expect(policy.tier).toBe('auto-threshold');
  });
});
