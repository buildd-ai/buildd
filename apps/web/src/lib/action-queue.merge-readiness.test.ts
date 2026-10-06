/**
 * "Needs you" means a person can take the next meaningful action now. A MERGE
 * card that the merge route then refuses with "Not mergeable yet: checks or
 * the review are still running" is a contradiction — these tests pin the
 * precedence (resolveMergeChip) that keeps pending CI/review waits out of the
 * human queue, and the review-in-flight predicate Home derives them from.
 */
import { describe, it, expect } from 'bun:test';
import {
  buildActionQueue,
  resolveMergeChip,
  describePendingGates,
  isActionableChip,
  AWAITING_CI_WINDOW_MS,
  type EscalationRawItem,
  type WaitingOnYouRawItem,
} from './action-queue';
import { resolveReviewInFlight } from './reviewer-gate';
import { resolveCiGate } from './ci-gate';
import { resolveMergeOutcome } from './merge-outcome';
import { splitWaitingOnYou } from '../app/app/(protected)/home/home-view';

const NOW = new Date('2026-10-05T12:00:00Z');
const HEAD = 'a'.repeat(40);
const PR_URL = 'https://github.com/org/repo/pull/3600';

function esc(overrides: Partial<EscalationRawItem> = {}): EscalationRawItem {
  return {
    workerId: 'w-1',
    taskId: 't-1',
    taskTitle: 'fix: something',
    workspaceId: 'ws-1',
    workspaceName: 'buildd',
    prNumber: 3600,
    prUrl: PR_URL,
    policyTier: 'human',
    escalationReason: 'Human Gate · manual merge required',
    waitingMinutes: 5,
    prOpenedAt: NOW,
    prLifecycleVerifiedAt: NOW,
    prLifecycleStatus: 'ci_green',
    prLifecycleUpdatedAt: NOW,
    ...overrides,
  };
}

function queue(items: EscalationRawItem[], woy: WaitingOnYouRawItem[] = []) {
  return buildActionQueue(woy, items, { now: NOW });
}

const ciGateFor = (prLifecycleStatus: 'ci_running' | 'ci_green' | 'pr_open') =>
  resolveCiGate({ prLifecycleStatus });

describe('merge readiness — pending gates never produce a MERGE card', () => {
  it('CI pending + review otherwise satisfied => not MERGE, no merge CTA, not in Needs You', () => {
    const [card] = queue([esc({ prLifecycleStatus: 'ci_running', ciGate: ciGateFor('ci_running') })]);
    expect(card.chip).toBe('CI_RUNNING');
    expect(isActionableChip(card.chip)).toBe(false);
    expect(describePendingGates(card.pendingGates!)).toBe('CI running');
  });

  it('PR opened with no CI result yet => CI_RUNNING ("Waiting for CI"), not MERGE', () => {
    const [card] = queue([esc({ prLifecycleStatus: 'pr_open' })]);
    expect(card.chip).toBe('CI_RUNNING');
    expect(describePendingGates(card.pendingGates!)).toBe('Waiting for CI');
  });

  it('a pr_open row past the awaiting-CI window falls back to MERGE (a repo with no CI is still mergeable)', () => {
    const old = new Date(NOW.getTime() - AWAITING_CI_WINDOW_MS - 60_000);
    const [card] = queue([esc({ prLifecycleStatus: 'pr_open', prLifecycleUpdatedAt: old })]);
    expect(card.chip).toBe('MERGE');
  });

  it('CI green + re-review running => REVIEW_RUNNING with the reviewer state, not MERGE', () => {
    const [card] = queue([esc({ reviewInFlight: 'reviewing' })]);
    expect(card.chip).toBe('REVIEW_RUNNING');
    expect(isActionableChip(card.chip)).toBe(false);
    expect(describePendingGates(card.pendingGates!)).toBe('CI passed · reviewer checking the latest commit');
  });

  it('a review in flight also outranks a REVIEW (agent-review approve-note) card', () => {
    const [card] = queue([esc({ policyTier: 'agent-review', reviewInFlight: 'queued' })]);
    expect(card.chip).toBe('REVIEW_RUNNING');
    expect(describePendingGates(card.pendingGates!)).toBe('CI passed · review queued');
  });

  it('CI running + review running names both gates compactly', () => {
    const [card] = queue([esc({ prLifecycleStatus: 'ci_running', ciGate: ciGateFor('ci_running'), reviewInFlight: 'reviewing' })]);
    expect(card.chip).toBe('CI_RUNNING');
    expect(describePendingGates(card.pendingGates!)).toBe('CI running · reviewer checking the latest commit');
  });

  it('CI green + request-changes + fix task queued => FIXING_REVIEW, never MERGE', () => {
    const ciGate = resolveCiGate({
      prLifecycleStatus: 'ci_green',
      liveFixTaskId: 'fix-1',
      liveFixKind: 'review',
      liveFixClaimed: false,
      liveFixIteration: 1,
      maxCiRetries: 3,
    });
    const [card] = queue([esc({ ciGate, escalationReason: 'the reviewer requested changes' })]);
    expect(card.chip).toBe('FIXING_REVIEW');
    expect(card.pendingGates).toBeNull();
  });

  it('an open fix attempt outranks a review in flight too', () => {
    const ciGate = resolveCiGate({ prLifecycleStatus: 'ci_green', liveFixTaskId: 'fix-1', liveFixKind: 'review', liveFixClaimed: true });
    const [card] = queue([esc({ ciGate, reviewInFlight: 'reviewing' })]);
    expect(card.chip).toBe('FIXING_REVIEW');
  });

  it('CI green + approved review + human merge policy => MERGE, and a successful tap reads as merged', () => {
    const [card] = queue([esc()]);
    expect(card.chip).toBe('MERGE');
    expect(isActionableChip(card.chip)).toBe(true);
    expect(card.pendingGates).toBeNull();
    expect(resolveMergeOutcome(true, 200, null)).toEqual({ kind: 'merged' });
  });

  it('agent-review platform landing: approved, green, stale approval or refresh in flight never reads MERGE or REVIEW', () => {
    for (const reviewApproved of [true, false]) {
      const [card] = queue([esc({ policyTier: 'agent-review', autoMerge: true, reviewApproved })]);
      expect(card.chip).toBe('AUTO_MERGE');
      expect(isActionableChip(card.chip)).toBe(false);
    }
  });

  it('agent-review landing handed to a person (autoMerge false) => MERGE once approved', () => {
    const [card] = queue([esc({ policyTier: 'agent-review', autoMerge: false, reviewApproved: true })]);
    expect(card.chip).toBe('MERGE');
  });

  it('CI green + approved review + auto-merge policy => AUTO_MERGE, no human MERGE card', () => {
    const [card] = queue([esc({ policyTier: 'auto-threshold', autoMerge: true })]);
    expect(card.chip).toBe('AUTO_MERGE');
    expect(isActionableChip(card.chip)).toBe(false);
  });

  it('a blocker-derived merge card obeys the same gates', () => {
    const woy: WaitingOnYouRawItem = {
      kind: 'merge',
      prUrl: PR_URL,
      prNumber: 3600,
      upstreamTaskId: 'up-1',
      upstreamTaskTitle: 'feat: upstream',
      unblockCount: 2,
      prOpenedAt: NOW,
      prLifecycleVerifiedAt: NOW,
      prLifecycleUpdatedAt: NOW,
      reviewInFlight: 'reviewing',
    };
    const [card] = buildActionQueue([woy], [], { now: NOW });
    expect(card.chip).toBe('REVIEW_RUNNING');
    expect(card.unblockCount).toBe(2);
  });

  it('Needs You count excludes platform-owned waits', () => {
    const items = queue([
      esc({ prUrl: `${PR_URL}1`, prLifecycleStatus: 'ci_running', ciGate: ciGateFor('ci_running') }),
      esc({ prUrl: `${PR_URL}2`, reviewInFlight: 'reviewing' }),
      esc({ prUrl: `${PR_URL}3`, prLifecycleStatus: 'pr_open' }),
      esc({ prUrl: `${PR_URL}4`, policyTier: 'auto-threshold', autoMerge: true }),
      esc({ prUrl: `${PR_URL}5` }),
    ]);
    const { needsYou, inFlight } = splitWaitingOnYou(items);
    expect(needsYou.map((i) => i.chip)).toEqual(['MERGE']);
    expect(inFlight).toHaveLength(4);
  });
});

describe('resolveMergeChip precedence is total and explicit', () => {
  it('a chip is never MERGE while any gate is pending', () => {
    const lifecycles = [null, 'pr_open', 'ci_running', 'ci_green'] as const;
    const reviews = [null, 'queued', 'reviewing'] as const;
    for (const prLifecycleStatus of lifecycles) {
      for (const reviewInFlight of reviews) {
        const ciGate = prLifecycleStatus === 'ci_running' ? ciGateFor('ci_running') : null;
        const { chip, pendingGates } = resolveMergeChip({ prLifecycleStatus, prLifecycleUpdatedAt: NOW, ciGate, reviewInFlight, policyTier: 'human', now: NOW });
        const pending = reviewInFlight != null || prLifecycleStatus === 'pr_open' || prLifecycleStatus === 'ci_running';
        if (pending) {
          expect(chip === 'MERGE' || chip === 'REVIEW').toBe(false);
          expect(pendingGates).not.toBeNull();
        } else {
          expect(chip).toBe('MERGE');
          expect(pendingGates).toBeNull();
        }
      }
    }
  });
});

describe('resolveReviewInFlight — the merge route\'s in_flight rule, read off the reviewer task', () => {
  const base = { currentHeadSha: HEAD, now: NOW };

  it('a reviewer with a live worker is reviewing', () => {
    expect(resolveReviewInFlight({
      ...base,
      reviewerTask: { status: 'in_progress', hasLiveWorker: true, createdAt: NOW },
    })).toBe('reviewing');
  });

  it('a freshly queued reviewer is queued', () => {
    expect(resolveReviewInFlight({
      ...base,
      reviewerTask: { status: 'pending', hasLiveWorker: false, createdAt: new Date(NOW.getTime() - 5 * 60_000) },
    })).toBe('queued');
  });

  it('a queued reviewer past the stall threshold is not in flight — the stall goes to a person', () => {
    expect(resolveReviewInFlight({
      ...base,
      reviewerTask: { status: 'pending', hasLiveWorker: false, createdAt: new Date(NOW.getTime() - 90 * 60_000) },
    })).toBeNull();
  });

  it('a completed approve is terminal, not in flight', () => {
    expect(resolveReviewInFlight({
      ...base,
      reviewerTask: {
        status: 'completed',
        hasLiveWorker: false,
        createdAt: NOW,
        result: { structuredOutput: { verdict: 'approve' } },
        context: { headSha: HEAD },
      },
    })).toBeNull();
  });

  it('no reviewer task => nothing in flight', () => {
    expect(resolveReviewInFlight({ ...base, reviewerTask: null })).toBeNull();
  });
});

describe('merge tap: a pending gate is not an error', () => {
  it('maps the route\'s waiting_ci refusal to pending (no Retry / Dismiss)', () => {
    const outcome = resolveMergeOutcome(false, 409, {
      error: 'Not mergeable yet: checks or the review are still running on the PR head.',
      landing: { kind: 'waiting_ci', headSha: HEAD },
    });
    expect(outcome.kind).toBe('pending');
  });

  it('a genuine refusal stays an error', () => {
    expect(resolveMergeOutcome(false, 409, { error: 'Merge refused: x', landing: { kind: 'needs_human' } }).kind).toBe('error');
  });
});
