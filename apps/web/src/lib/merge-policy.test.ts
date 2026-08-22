import { describe, it, expect } from 'bun:test';
import { resolvePolicy, DEFAULT_MERGE_POLICY } from './merge-policy';
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
