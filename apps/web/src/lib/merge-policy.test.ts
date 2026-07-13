import { describe, it, expect } from 'bun:test';
import { resolvePolicy } from './merge-policy';

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
