import { describe, it, expect } from 'bun:test';
import { resolveReviewerGate } from './reviewer-gate';
import type { ReviewerGateInput } from './reviewer-gate';
import { buildActionQueue } from './action-queue';
import type { EscalationRawItem } from './action-queue';
import { DAY_MS, HOUR_MS, MINUTE_MS } from './pr-freshness';

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

// ─────────────────────────────────────────────────────────────────────────────
// The three directions, in one place.
//
// Three separate reports produced three separate fixes, each of which could
// silently reopen another:
//
//   1. UNDER-FIRE  (task facae217) — a PR that genuinely fell to the human was
//      missing from Waiting on You. Fix: never silently drop a PR.
//   2. OVER-FIRE   (PR #2032)      — a PR whose reviewer had not even been
//      claimed yet was asking the human to merge it. Fix: pending/running
//      reviewer work means the agent still owns the PR.
//   3. STALE LEAK  (this change)   — a row buildd could not resolve stayed
//      pinned to the action queue as a merge CTA forever, because 1 says don't
//      drop it and nothing bounded how old "unknown" was allowed to get.
//
// The gate answers WHO owns the next move; the queue answers WHETHER the card
// may claim to be a merge. Both are exercised here so a future fix to one has
// to keep the other two passing.
// ─────────────────────────────────────────────────────────────────────────────

const PR_URL = 'https://github.com/org/repo/pull/2040';

function queueItem(overrides?: Partial<EscalationRawItem>): EscalationRawItem {
  return {
    workerId: 'worker-1',
    taskId: 'task-1',
    taskTitle: 'fix(mobile): suppress redundant h1',
    workspaceId: 'ws-1',
    workspaceName: 'buildd',
    prNumber: 2040,
    prUrl: PR_URL,
    policyTier: 'human',
    escalationReason: 'Human Gate — manual merge required',
    waitingMinutes: 15,
    prOpenedAt: new Date(NOW.getTime() - 3 * HOUR_MS),
    prLifecycleCheckedAt: new Date(NOW.getTime() - 5 * MINUTE_MS),
    ...overrides,
  };
}

describe('all three directions hold simultaneously', () => {
  it('1. under-fire: a PR that genuinely fell to the human still gets a card', () => {
    const gate = resolveReviewerGate(
      baseInput({ escalationReason: 'escalated: needs a human' }),
    );
    expect(gate.actor).toBe('human');

    const queue = buildActionQueue([], [queueItem()], { now: NOW });
    expect(queue).toHaveLength(1);
    expect(queue[0].chip).toBe('MERGE');
  });

  it('2. over-fire: an unclaimed reviewer keeps the PR with the agent, so no human card is built', () => {
    const gate = resolveReviewerGate(
      baseInput({
        policyTier: 'agent-review',
        reviewerTask: { status: 'pending', hasLiveWorker: false, createdAt: NOW },
      }),
    );
    expect(gate.actor).toBe('agent');

    // Home only puts gate.actor === 'human' rows into the escalation inbox, so
    // an agent-owned PR reaches the queue as nothing at all.
    expect(buildActionQueue([], [], { now: NOW })).toHaveLength(0);
  });

  it('3. stale leak: a human-owned PR whose state is 90 days unverified is NOT a merge CTA', () => {
    const gate = resolveReviewerGate(
      baseInput({ policyTier: 'human' }),
    );
    // The gate is right — under a human tier this genuinely is the human's move.
    // It is the queue's job to refuse to render it as one on stale input.
    expect(gate.actor).toBe('human');

    const queue = buildActionQueue([], [queueItem({
      prOpenedAt: new Date(NOW.getTime() - 90 * DAY_MS),
      prLifecycleCheckedAt: null,
      waitingMinutes: 90 * 24 * 60,
    })], { now: NOW });

    expect(queue).toHaveLength(1);
    expect(queue[0].chip).toBe('STALE');
    // AC-6 is honoured, but not on the action queue: still visible, no longer
    // claiming "manual merge required".
    expect(queue[0].escalationReason).not.toContain('manual merge required');
    expect(queue[0].cardAgeHours).toBe(90 * 24);
  });

  it('3b. stale leak: a row retired to terminal unresolvable leaves the queue entirely', () => {
    const queue = buildActionQueue([], [queueItem({
      prLifecycleStatus: 'unresolvable',
      prOpenedAt: new Date(NOW.getTime() - 90 * DAY_MS),
      prLifecycleCheckedAt: null,
    })], { now: NOW });

    expect(queue).toHaveLength(0);
  });

  it('fixing 3 does not reopen 1: a fresh human-owned PR is untouched by the staleness gate', () => {
    const queue = buildActionQueue([], [queueItem()], { now: NOW });
    expect(queue[0].chip).toBe('MERGE');
    expect(queue[0].staleGate).toBeNull();
  });

  it('fixing 3 does not reopen 2: an agent-handled card is never relabelled STALE', () => {
    // A conflict retry is live — the agent owns this, and how old the PR is
    // does not change that. Only merge CTAs are freshness-gated.
    const queue = buildActionQueue([], [queueItem({
      conflictRetryTaskId: 'retry-1',
      prOpenedAt: new Date(NOW.getTime() - 90 * DAY_MS),
      prLifecycleCheckedAt: null,
    })], { now: NOW });

    expect(queue[0].chip).toBe('RESOLVING');
  });
});
