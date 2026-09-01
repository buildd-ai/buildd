import { describe, it, expect } from 'bun:test';
import { resolveReviewerGate } from './reviewer-gate';
import type { ReviewerGateInput } from './reviewer-gate';

const NOW = new Date('2026-09-01T12:00:00Z');

function baseInput(overrides?: Partial<ReviewerGateInput>): ReviewerGateInput {
  return {
    policyTier: 'agent-review',
    escalationReason: null,
    approvalSummary: null,
    reviewerTask: null,
    prOpenedAt: NOW,
    now: NOW,
    ...overrides,
  };
}

describe('resolveReviewerGate — over-fire direction (agent still owns the PR)', () => {
  it('reviewer task PENDING, never claimed → agent, queued (the #2029 scenario)', () => {
    const result = resolveReviewerGate(
      baseInput({
        reviewerTask: { status: 'pending', hasLiveWorker: false, createdAt: NOW },
      }),
    );
    expect(result.actor).toBe('agent');
    expect(result.agentState).toBe('queued');
  });

  it('reviewer task RUNNING with a live worker → agent, reviewing', () => {
    const result = resolveReviewerGate(
      baseInput({
        reviewerTask: { status: 'in_progress', hasLiveWorker: true, createdAt: NOW },
      }),
    );
    expect(result.actor).toBe('agent');
    expect(result.agentState).toBe('reviewing');
  });

  it('reviewer task ASSIGNED but not yet live → agent, queued', () => {
    const result = resolveReviewerGate(
      baseInput({
        reviewerTask: { status: 'assigned', hasLiveWorker: false, createdAt: NOW },
      }),
    );
    expect(result.actor).toBe('agent');
    expect(result.agentState).toBe('queued');
  });

  it('no reviewer task yet under agent-review policy, PR just opened → agent, queued (dispatch grace period)', () => {
    const result = resolveReviewerGate(
      baseInput({ reviewerTask: null, prOpenedAt: NOW }),
    );
    expect(result.actor).toBe('agent');
    expect(result.agentState).toBe('queued');
  });

  it('a queued reviewer task within the grace period is never handed to the human', () => {
    const twentyMinAgo = new Date(NOW.getTime() - 20 * 60_000);
    const result = resolveReviewerGate(
      baseInput({
        reviewerTask: { status: 'pending', hasLiveWorker: false, createdAt: twentyMinAgo },
        queuedThresholdMinutes: 30,
      }),
    );
    expect(result.actor).toBe('agent');
  });
});

describe('resolveReviewerGate — under-fire direction (human genuinely owns the PR)', () => {
  it('reviewer escalated → human, with the escalation reason', () => {
    const result = resolveReviewerGate(
      baseInput({ escalationReason: 'escalated: drizzle/0099_x.sql' }),
    );
    expect(result.actor).toBe('human');
    expect(result.reason).toBe('escalated: drizzle/0099_x.sql');
  });

  it('reviewer approved under approve-only gate → human, awaiting merge', () => {
    const result = resolveReviewerGate(
      baseInput({ approvalSummary: 'Looks good, confidence 0.9' }),
    );
    expect(result.actor).toBe('human');
  });

  it('request-changes retries exhausted (escalation note written) → human', () => {
    // escalateReviewerExhaustion writes a reviewer_escalated note — modeled
    // here as escalationReason being set, same as any other escalation.
    const result = resolveReviewerGate(
      baseInput({ escalationReason: 'review loop hit its 3-iteration cap — needs a human' }),
    );
    expect(result.actor).toBe('human');
  });

  it('reviewer task FAILED → human, reviewer task failed', () => {
    const result = resolveReviewerGate(
      baseInput({
        reviewerTask: { status: 'failed', hasLiveWorker: false, createdAt: NOW },
      }),
    );
    expect(result.actor).toBe('human');
    expect(result.reason).toContain('failed');
  });

  it('reviewer task CANCELLED → human', () => {
    const result = resolveReviewerGate(
      baseInput({
        reviewerTask: { status: 'cancelled', hasLiveWorker: false, createdAt: NOW },
      }),
    );
    expect(result.actor).toBe('human');
  });

  it('tier is human → human, regardless of reviewer state', () => {
    const result = resolveReviewerGate(
      baseInput({
        policyTier: 'human',
        reviewerTask: { status: 'pending', hasLiveWorker: false, createdAt: NOW },
      }),
    );
    expect(result.actor).toBe('human');
    expect(result.reason).toBe('Human Gate — manual merge required');
  });

  it('no reviewer task and tier will never create one (auto-threshold) → human', () => {
    const result = resolveReviewerGate(
      baseInput({ policyTier: 'auto-threshold', reviewerTask: null }),
    );
    expect(result.actor).toBe('human');
  });

  it('reviewer task pending beyond the queued threshold → human (unclaimable)', () => {
    const fortyMinAgo = new Date(NOW.getTime() - 40 * 60_000);
    const result = resolveReviewerGate(
      baseInput({
        reviewerTask: { status: 'pending', hasLiveWorker: false, createdAt: fortyMinAgo },
        queuedThresholdMinutes: 30,
      }),
    );
    expect(result.actor).toBe('human');
    expect(result.reason).toMatch(/not started/i);
  });

  it('no reviewer task under agent-review policy, PR stale beyond threshold → human', () => {
    const fortyMinAgo = new Date(NOW.getTime() - 40 * 60_000);
    const result = resolveReviewerGate(
      baseInput({ reviewerTask: null, prOpenedAt: fortyMinAgo, queuedThresholdMinutes: 30 }),
    );
    expect(result.actor).toBe('human');
  });

  it('reviewer task completed with no recorded verdict → human (fail-safe, nothing else will act)', () => {
    const result = resolveReviewerGate(
      baseInput({
        reviewerTask: { status: 'completed', hasLiveWorker: false, createdAt: NOW },
      }),
    );
    expect(result.actor).toBe('human');
  });
});

describe('resolveReviewerGate — precedence', () => {
  it('escalation note wins even if a reviewer task is still nominally pending (stale status)', () => {
    const result = resolveReviewerGate(
      baseInput({
        escalationReason: 'escalated: schema.ts',
        reviewerTask: { status: 'pending', hasLiveWorker: false, createdAt: NOW },
      }),
    );
    expect(result.actor).toBe('human');
  });

  it('human tier wins even with a live reviewing worker', () => {
    const result = resolveReviewerGate(
      baseInput({
        policyTier: 'human',
        reviewerTask: { status: 'in_progress', hasLiveWorker: true, createdAt: NOW },
      }),
    );
    expect(result.actor).toBe('human');
  });
});
