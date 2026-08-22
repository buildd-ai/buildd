import { describe, it, expect } from 'bun:test';
import { resolvePolicy, mergePolicySchema } from './merge-policy';

describe('resolvePolicy', () => {
  it('returns auto-threshold from legacy autoMergePR: true', () => {
    const policy = resolvePolicy({ gitConfig: { autoMergePR: true } as any });
    expect(policy.tier).toBe('auto-threshold');
  });

  it('returns human from legacy autoMergePR: false', () => {
    const policy = resolvePolicy({ gitConfig: { autoMergePR: false } as any });
    expect(policy.tier).toBe('human');
  });

  it('returns auto-threshold from legacy autoMergeOnGreenCI: true', () => {
    const policy = resolvePolicy({ gitConfig: { autoMergeOnGreenCI: true } as any });
    expect(policy.tier).toBe('auto-threshold');
  });

  it('returns human from legacy autoMergeOnGreenCI: false', () => {
    const policy = resolvePolicy({ gitConfig: { autoMergeOnGreenCI: false } as any });
    expect(policy.tier).toBe('human');
  });

  it('autoMergeOnGreenCI takes precedence over autoMergePR', () => {
    const policy = resolvePolicy({
      gitConfig: { autoMergeOnGreenCI: false, autoMergePR: true } as any,
    });
    expect(policy.tier).toBe('human');
  });

  it('defaults to auto-threshold when no legacy fields are set', () => {
    const policy = resolvePolicy({ gitConfig: null });
    expect(policy.tier).toBe('auto-threshold');
    expect((policy.threshold?.maxLines)).toBe(800);
  });

  it('inherits legacy maxLines and denyPaths', () => {
    const policy = resolvePolicy({
      gitConfig: {
        autoMergeOnGreenCI: true,
        autoMergeMaxLines: 400,
        autoMergeDenyPaths: ['drizzle/'],
      } as any,
    });
    expect(policy.tier).toBe('auto-threshold');
    expect(policy.threshold?.maxLines).toBe(400);
    expect(policy.threshold?.denyPaths).toEqual(['drizzle/']);
  });

  it('workspace explicit mergePolicy overrides legacy fields', () => {
    const policy = resolvePolicy({
      gitConfig: {
        autoMergePR: true,
        mergePolicy: { tier: 'human' },
      } as any,
    });
    expect(policy.tier).toBe('human');
  });

  it('workspace mergePolicy with agent-review is returned as-is', () => {
    const agentPolicy = {
      tier: 'agent-review' as const,
      agentReview: { reviewerRole: 'reviewer', maxConfidenceThreshold: 0.6 },
    };
    const policy = resolvePolicy({
      gitConfig: { mergePolicy: agentPolicy } as any,
    });
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

  it('mission mergePolicy overrides legacy fields', () => {
    const policy = resolvePolicy(
      { gitConfig: { autoMergePR: true } as any },
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
