import { describe, it, expect } from 'bun:test';
import { resolvePolicy, mergePolicySchema } from './merge-policy';

const WS_AUTO = { gitConfig: { mergePolicy: { tier: 'auto-threshold' as const, threshold: { maxLines: 800 } } } };
const WS_HUMAN = { gitConfig: { mergePolicy: { tier: 'human' as const } } };
const WS_EMPTY = { gitConfig: null };

describe('resolvePolicy — resolution chain', () => {
  it('defaults to auto-threshold (maxLines 800) with no context', () => {
    const p = resolvePolicy(WS_EMPTY);
    expect(p.tier).toBe('auto-threshold');
    expect(p.threshold?.maxLines).toBe(800);
  });

  it('uses workspace mergePolicy when no task or mission override', () => {
    expect(resolvePolicy(WS_HUMAN).tier).toBe('human');
  });

  it('workspace mergePolicy with agent-review is returned as-is', () => {
    const agentPolicy = {
      tier: 'agent-review' as const,
      agentReview: { reviewerRole: 'reviewer', maxConfidenceThreshold: 0.6 },
    };
    const p = resolvePolicy({ gitConfig: { mergePolicy: agentPolicy } as any });
    expect(p.tier).toBe('agent-review');
    expect(p.agentReview?.reviewerRole).toBe('reviewer');
  });

  it('mission.mergePolicy overrides workspace policy', () => {
    const p = resolvePolicy(WS_AUTO, { mergePolicy: { tier: 'human' } });
    expect(p.tier).toBe('human');
  });

  it('null mission.mergePolicy falls through to workspace', () => {
    const p = resolvePolicy(WS_HUMAN, { mergePolicy: null });
    expect(p.tier).toBe('human');
  });

  it('mission.requiresReview=true maps to human tier (overrides mission.mergePolicy)', () => {
    const p = resolvePolicy(WS_AUTO, { mergePolicy: { tier: 'auto-threshold' }, requiresReview: true });
    expect(p.tier).toBe('human');
  });

  it('task.requiresReview=true maps to human tier (highest precedence)', () => {
    const p = resolvePolicy(
      WS_AUTO,
      { mergePolicy: { tier: 'auto-threshold' }, requiresReview: false },
      { requiresReview: true },
    );
    expect(p.tier).toBe('human');
  });

  it('task.requiresReview=false does not block mission or workspace policy', () => {
    const p = resolvePolicy(WS_HUMAN, null, { requiresReview: false });
    expect(p.tier).toBe('human');
  });

  it('task.requiresReview=true wins even when mission.mergePolicy is agent-review', () => {
    const p = resolvePolicy(
      WS_AUTO,
      { mergePolicy: { tier: 'agent-review', agentReview: { reviewerRole: 'reviewer' } } },
      { requiresReview: true },
    );
    expect(p.tier).toBe('human');
  });

  it('mission.requiresReview=true wins over mission.mergePolicy', () => {
    const p = resolvePolicy(WS_AUTO, {
      mergePolicy: { tier: 'agent-review', agentReview: { reviewerRole: 'reviewer' } },
      requiresReview: true,
    });
    expect(p.tier).toBe('human');
  });

  it('returns default when gitConfig is null and no mission/task', () => {
    const p = resolvePolicy({ gitConfig: null }, null, null);
    expect(p.tier).toBe('auto-threshold');
    expect(p.threshold?.maxLines).toBe(800);
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
