import { describe, it, expect } from 'bun:test';
import { resolveReviewerGate } from './reviewer-gate';
import type { ReviewerGateInput } from './reviewer-gate';
import { resolvePolicy, isMissionIntegrationBase } from './merge-policy';
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
    prLifecycleVerifiedAt: new Date(NOW.getTime() - 5 * MINUTE_MS),
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
      prLifecycleVerifiedAt: null,
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
      prLifecycleVerifiedAt: null,
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
      prLifecycleVerifiedAt: null,
    })], { now: NOW });

    expect(queue[0].chip).toBe('RESOLVING');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Direction 4: Option A′ quarantined task PRs.
//
// A task PR based on a mission's integration branch resolves to
// `auto-threshold` (merge-policy precedence rule 2) so it can land unattended —
// the human gate for that work is the ONE mission PR into trunk. But that tier
// drop is also what removes the reviewer, and "no reviewer will ever run" was
// otherwise read as "a human must merge this". Net effect: A′ turned into its
// own opposite, demoting task PRs and then presenting every one of them as the
// human's problem.
//
// `/api/prs/escalation-inbox` and `/api/cron/stall-notify` drop these PRs by
// testing the resolved tier. Home reaches the same question through
// `resolveReviewerGate`, so the exemption has to live in the gate or the two
// answers diverge for the same PR.
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveReviewerGate — Option A′ integration-branch task PRs', () => {
  it("a quarantined task PR with no reviewer is the platform's move, not the human's", () => {
    const gate = resolveReviewerGate(
      baseInput({
        policyTier: 'auto-threshold',
        reviewerTask: null,
        isMissionIntegrationTaskPr: true,
      }),
    );
    expect(gate.actor).toBe('platform');
    // Home buckets the in-flight rails on agentState and the inbox on
    // actor === 'human', so a platform-owned PR must claim neither.
    expect(gate.agentState).toBeUndefined();
  });

  it('the same PR without the A′ flag still falls to the human (pre-A′ behaviour untouched)', () => {
    const gate = resolveReviewerGate(
      baseInput({ policyTier: 'auto-threshold', reviewerTask: null }),
    );
    expect(gate.actor).toBe('human');
  });

  it('task.requiresReview still wins — an explicit per-task human gate is never revoked', () => {
    // resolvePolicy rule 1 beats rule 2, so the tier arrives as 'human' even
    // when the base is the integration branch.
    const gate = resolveReviewerGate(
      baseInput({ policyTier: 'human', isMissionIntegrationTaskPr: true }),
    );
    expect(gate.actor).toBe('human');
    expect(gate.reason).toBe('Human Gate — manual merge required');
  });

  it('an explicit reviewer escalation on a quarantined PR still reaches the human', () => {
    // Matches the inbox, which admits an escalated task before it looks at the
    // tier at all. An agent that handed the PR back by name is not overridden.
    const gate = resolveReviewerGate(
      baseInput({
        policyTier: 'auto-threshold',
        isMissionIntegrationTaskPr: true,
        escalationReason: 'escalated: touches a protected path',
      }),
    );
    expect(gate.actor).toBe('human');
    expect(gate.reason).toBe('escalated: touches a protected path');
  });

  it('a reviewer approval on a quarantined PR still reaches the human', () => {
    const gate = resolveReviewerGate(
      baseInput({
        policyTier: 'auto-threshold',
        isMissionIntegrationTaskPr: true,
        approvalSummary: 'Looks good, confidence 0.9',
      }),
    );
    expect(gate.actor).toBe('human');
  });

  it('a failed reviewer task does not page a human for a quarantined PR', () => {
    // Nothing is waiting on this verdict: the platform merges the PR into a
    // branch that is itself still behind the mission's review gate.
    const gate = resolveReviewerGate(
      baseInput({
        policyTier: 'auto-threshold',
        isMissionIntegrationTaskPr: true,
        reviewerTask: { status: 'failed', hasLiveWorker: false, createdAt: NOW },
      }),
    );
    expect(gate.actor).toBe('platform');
  });
});

// The three surfaces that ask "is this PR a human's problem" about the SAME PR,
// evaluated over one fixture. Two of them are one-line tier checks in route
// handlers this file cannot import (they are server routes with DB clients), so
// their predicates are reproduced verbatim and cited; Home's composition is the
// real code path — `resolvePolicy` with the PR base ref, feeding
// `resolveReviewerGate`.
//
// SCOPE, deliberately narrow: the claim under test is agreement about an
// integration-branch task PR. Home legitimately knows more than the routes about
// reviewer liveness under `agent-review` (a reviewer that never started IS a
// human's problem, and the routes do not model that at all), so this does not
// assert blanket agreement — only that A′ quarantine resolves identically.
describe('Home, the escalation inbox and stall-notify agree about a quarantined task PR', () => {
  const INTEGRATION_BRANCH = 'mission/example-slug-0a1b2c3d';
  const optedInMission = { workingBranch: INTEGRATION_BRANCH, integrationBranchEnabled: true };
  const humanWorkspace = { gitConfig: { mergePolicy: { tier: 'human' } } as any };
  const agentReviewWorkspace = {
    gitConfig: { mergePolicy: { tier: 'agent-review', agentReview: { reviewerRole: 'reviewer' } } } as any,
  };

  // api/prs/escalation-inbox/route.ts: `return policy.tier === 'human'`
  // api/cron/stall-notify/route.ts:    `const isHumanGate = policy.tier === 'human'`
  // Both build `policy` from resolvePolicy(ws, mission, null, { baseRef }).
  function routesSayHuman(ws: { gitConfig: unknown }, baseRef: string | null): boolean {
    return resolvePolicy(ws as never, optedInMission, null, { baseRef }).tier === 'human';
  }

  // home/page.tsx: same resolvePolicy call, then resolveReviewerGate.
  function homeSaysHuman(ws: { gitConfig: unknown }, baseRef: string | null): boolean {
    const policy = resolvePolicy(ws as never, optedInMission, null, { baseRef });
    return (
      resolveReviewerGate(
        baseInput({
          policyTier: policy.tier,
          reviewerTask: null,
          // Well past any dispatch grace period — the worst case for the human queue.
          prOpenedAt: new Date(NOW.getTime() - 2 * HOUR_MS),
          isMissionIntegrationTaskPr: isMissionIntegrationBase({ baseRef, mission: optedInMission }),
        }),
      ).actor === 'human'
    );
  }

  it('a human-tier workspace: neither surface calls the quarantined task PR a human problem', () => {
    expect(routesSayHuman(humanWorkspace, INTEGRATION_BRANCH)).toBe(false);
    expect(homeSaysHuman(humanWorkspace, INTEGRATION_BRANCH)).toBe(false);
  });

  it('an agent-review workspace: same answer, same PR', () => {
    expect(routesSayHuman(agentReviewWorkspace, INTEGRATION_BRANCH)).toBe(false);
    expect(homeSaysHuman(agentReviewWorkspace, INTEGRATION_BRANCH)).toBe(false);
  });

  it('and all three still call the mission PR itself (base = trunk) a human problem', () => {
    expect(routesSayHuman(humanWorkspace, 'dev')).toBe(true);
    expect(homeSaysHuman(humanWorkspace, 'dev')).toBe(true);
  });

  it('an unknown base ref is never treated as quarantined by either surface', () => {
    // The direction that silently deletes a review gate.
    expect(routesSayHuman(humanWorkspace, null)).toBe(true);
    expect(homeSaysHuman(humanWorkspace, null)).toBe(true);
  });
});
