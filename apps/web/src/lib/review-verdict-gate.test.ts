import { describe, it, expect, mock, beforeEach } from 'bun:test';

const firedGateEvents: any[] = [];
mock.module('@/lib/gate-ledger', () => ({
  fireGateEvent: mock((input: any) => { firedGateEvents.push(input); }),
  GATE_SLUGS: { REVIEW_VERDICT: 'review_verdict' },
}));

import { evaluateReviewVerdictGate, guardReviewVerdict, classifyMergeAgainstReview } from './review-verdict-gate';
import type { PrReviewStatus, PrReviewState } from './pr-review-status';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function status(over: Partial<PrReviewStatus> = {}): PrReviewStatus {
  return {
    state: 'not_requested',
    terminal: false,
    reviewTaskId: null,
    adoptedTaskId: null,
    verdict: null,
    confidence: null,
    summary: null,
    feedback: null,
    escalationReason: null,
    iteration: null,
    maxIterations: null,
    reviewHeadSha: null,
    reviewEquivalentHeadShas: [],
    prState: 'open',
    merged: false,
    mergeBlocked: null,
    ...over,
  };
}

describe('evaluateReviewVerdictGate — approval carried across a content-preserving rebase', () => {
  it('passes an approval made at A when head B is recorded as content-equivalent', () => {
    const result = evaluateReviewVerdictGate(
      status({ state: 'approved', reviewHeadSha: SHA_A, reviewEquivalentHeadShas: [SHA_B] }),
      SHA_B,
    );
    expect(result.blocks).toBe(false);
  });

  it('still blocks as stale when head B is not recorded as equivalent', () => {
    const result = evaluateReviewVerdictGate(
      status({ state: 'approved', reviewHeadSha: SHA_A, reviewEquivalentHeadShas: ['c'.repeat(40)] }),
      SHA_B,
    );
    expect(result.kind).toBe('stale_approval');
  });

  it('an equivalence record never clears a request-changes verdict', () => {
    const result = evaluateReviewVerdictGate(
      status({ state: 'changes_requested', reviewHeadSha: SHA_A, reviewEquivalentHeadShas: [SHA_B] }),
      SHA_B,
    );
    expect(result.blocks).toBe(true);
  });
});

describe('evaluateReviewVerdictGate', () => {
  it('blocks a request-changes verdict made against the commit being merged', () => {
    const result = evaluateReviewVerdictGate(
      status({
        state: 'changes_requested',
        verdict: 'request-changes',
        reviewHeadSha: SHA_A,
        feedback: 'the new block never checks worker.mergedAt',
        reviewTaskId: 'review-1',
      }),
      SHA_A,
    );

    expect(result.blocks).toBe(true);
    expect(result.kind).toBe('changes_requested');
    // Names the blocking verdict, and what it said.
    expect(result.reason).toContain('requested changes');
    expect(result.reason).toContain('never checks worker.mergedAt');
    expect(result.reason).toContain(SHA_A.slice(0, 7));
    // Never a dead end.
    expect(result.clearedBy).toBeTruthy();
    expect(result.reviewTaskId).toBe('review-1');
  });

  it('blocks an escalate verdict at the same commit', () => {
    const result = evaluateReviewVerdictGate(
      status({
        state: 'escalated',
        verdict: 'escalate',
        reviewHeadSha: SHA_A,
        escalationReason: 'touches .github/workflows',
      }),
      SHA_A,
    );
    expect(result.blocks).toBe(true);
    expect(result.kind).toBe('escalated');
    expect(result.reason).toContain('escalated');
    expect(result.reason).toContain('touches .github/workflows');
  });

  it('blocks while a review round is still in flight', () => {
    for (const state of ['queued', 'reviewing'] as PrReviewState[]) {
      const result = evaluateReviewVerdictGate(
        status({ state, reviewHeadSha: SHA_A }),
        SHA_A,
      );
      expect(result.blocks).toBe(true);
      expect(result.kind).toBe('in_flight');
    }
  });

  it('regression: a push no longer clears a request-changes verdict on its own', () => {
    // Pre-fix behaviour: a later push made the gate PASS unconditionally,
    // trusting that *something* must have re-reviewed the new commit. Nothing
    // did — the webhook only ever dispatched a reviewer on `opened`. A
    // reviewer is now re-dispatched automatically on `synchronize` (see
    // maybeReDispatchReviewer), and the gate blocks until THAT round reaches
    // a terminal state (readPrReviewStatus reads the newest review task, so a
    // fresh round simply replaces this stale one) — not merely because a push
    // happened.
    const result = evaluateReviewVerdictGate(
      status({ state: 'changes_requested', verdict: 'request-changes', reviewHeadSha: SHA_A }),
      SHA_B,
    );
    expect(result.blocks).toBe(true);
    expect(result.kind).toBe('changes_requested');
  });

  it('regression: a push no longer clears an escalated verdict on its own', () => {
    const result = evaluateReviewVerdictGate(
      status({ state: 'escalated', verdict: 'escalate', reviewHeadSha: SHA_A }),
      SHA_B,
    );
    expect(result.blocks).toBe(true);
    expect(result.kind).toBe('escalated');
  });

  it('passes an approve that follows a previous request-changes', () => {
    // readPrReviewStatus reads the NEWEST review task, so an approve from a
    // re-review replaces the stale verdict outright.
    const result = evaluateReviewVerdictGate(
      status({ state: 'approved', verdict: 'approve', confidence: 0.9, reviewHeadSha: SHA_A }),
      SHA_A,
    );
    expect(result.blocks).toBe(false);
  });

  it('blocks a stale approval — a later push moved the head past what was approved', () => {
    // Unlike changes_requested/escalated, an approval does not get a reviewer
    // auto re-dispatched on every push (see the module doc) — the gate itself
    // is the thing that stops silently trusting it.
    const result = evaluateReviewVerdictGate(
      status({ state: 'approved', verdict: 'approve', confidence: 0.9, reviewHeadSha: SHA_A, summary: 'LGTM' }),
      SHA_B,
    );
    expect(result.blocks).toBe(true);
    expect(result.kind).toBe('stale_approval');
    expect(result.reason).toContain(SHA_B.slice(0, 7));
    expect(result.clearedBy).toBeTruthy();
  });

  it('passes an approve with no recorded SHA — cannot prove staleness', () => {
    const result = evaluateReviewVerdictGate(
      status({ state: 'approved', verdict: 'approve', confidence: 0.9, reviewHeadSha: null }),
      SHA_B,
    );
    expect(result.blocks).toBe(false);
  });

  it('passes an approve when the commit being merged is unknown — cannot prove staleness', () => {
    const result = evaluateReviewVerdictGate(
      status({ state: 'approved', verdict: 'approve', confidence: 0.9, reviewHeadSha: SHA_A }),
      null,
    );
    expect(result.blocks).toBe(false);
  });

  it('compares commits case-insensitively for a stale approval', () => {
    expect(
      evaluateReviewVerdictGate(
        status({ state: 'approved', verdict: 'approve', reviewHeadSha: SHA_A.toUpperCase() }),
        SHA_A,
      ).blocks,
    ).toBe(false);
    expect(
      evaluateReviewVerdictGate(
        status({ state: 'approved', verdict: 'approve', reviewHeadSha: SHA_A }),
        SHA_B.toUpperCase(),
      ).blocks,
    ).toBe(true);
  });

  it('passes when no review was ever requested', () => {
    const result = evaluateReviewVerdictGate(status({ state: 'not_requested' }), SHA_A);
    expect(result.blocks).toBe(false);
    expect(result.state).toBe('not_requested');
  });

  it('passes review_failed — no verdict means no finding to protect', () => {
    // A reviewer whose session died produced nothing to enforce, and nothing
    // re-reviews the same head SHA, so this would strand the PR forever.
    // escalateReviewContractFailure already surfaces it to a human.
    const result = evaluateReviewVerdictGate(status({ state: 'review_failed' }), SHA_A);
    expect(result.blocks).toBe(false);
    // `state` rides along on every PASS (not just a block) specifically so a
    // caller — guardReviewVerdict below — can tell this PASS apart from
    // not_requested/approved and count it.
    expect(result.state).toBe('review_failed');
  });

  it('passes an already-merged PR so an idempotent re-merge is not a refusal', () => {
    const result = evaluateReviewVerdictGate(
      status({ state: 'changes_requested', reviewHeadSha: SHA_A, merged: true, prState: 'merged' }),
      SHA_A,
    );
    expect(result.blocks).toBe(false);
  });

  it('fails closed when the commit being merged is unknown', () => {
    const result = evaluateReviewVerdictGate(
      status({ state: 'changes_requested', reviewHeadSha: SHA_A }),
      null,
    );
    expect(result.blocks).toBe(true);
  });

  it('fails closed when the review round recorded no commit', () => {
    const result = evaluateReviewVerdictGate(
      status({ state: 'changes_requested', reviewHeadSha: null }),
      SHA_A,
    );
    expect(result.blocks).toBe(true);
  });

  it('blocks regardless of SHA casing or abbreviation — changes_requested has no pass escape', () => {
    expect(
      evaluateReviewVerdictGate(
        status({ state: 'changes_requested', reviewHeadSha: SHA_A.toUpperCase() }),
        SHA_A,
      ).blocks,
    ).toBe(true);
    // An abbreviated sha cannot establish identity either way, but it no
    // longer matters here — changes_requested blocks unconditionally now.
    expect(
      evaluateReviewVerdictGate(
        status({ state: 'changes_requested', reviewHeadSha: SHA_A }),
        SHA_B.slice(0, 7),
      ).blocks,
    ).toBe(true);
  });
});

describe('guardReviewVerdict', () => {
  beforeEach(() => {
    firedGateEvents.length = 0;
  });

  it('fires a warned gate event when a review_failed PASS lets a merge proceed', async () => {
    const result = await guardReviewVerdict({
      workspaceId: 'ws-1',
      prNumber: 2587,
      headSha: SHA_A,
      surface: 'auto-merge',
      taskId: 'review-task-1',
      deps: {
        read: async () => status({ state: 'review_failed', reviewTaskId: 'review-task-1' }),
      },
    });
    expect(result.blocks).toBe(false);
    expect(firedGateEvents).toHaveLength(1);
    expect(firedGateEvents[0].gate).toBe('review_verdict');
    expect(firedGateEvents[0].outcome).toBe('warned');
    expect(firedGateEvents[0].surface).toBe('auto-merge');
    expect(firedGateEvents[0].taskId).toBe('review-task-1');
    expect(firedGateEvents[0].detail.prNumber).toBe(2587);
  });

  it('does not fire a gate event for an ordinary not_requested PASS', async () => {
    const result = await guardReviewVerdict({
      workspaceId: 'ws-1',
      prNumber: 1,
      headSha: SHA_A,
      deps: { read: async () => status({ state: 'not_requested' }) },
    });
    expect(result.blocks).toBe(false);
    expect(firedGateEvents).toHaveLength(0);
  });

  it('does not fire a gate event when the gate blocks', async () => {
    const result = await guardReviewVerdict({
      workspaceId: 'ws-1',
      prNumber: 1,
      headSha: SHA_A,
      deps: { read: async () => status({ state: 'changes_requested', reviewHeadSha: SHA_A }) },
    });
    expect(result.blocks).toBe(true);
    expect(firedGateEvents).toHaveLength(0);
  });

  it('reads the status and applies the rule', async () => {
    const result = await guardReviewVerdict({
      workspaceId: 'ws-1',
      prNumber: 2396,
      headSha: SHA_A,
      deps: {
        read: async () =>
          status({ state: 'changes_requested', verdict: 'request-changes', reviewHeadSha: SHA_A }),
      },
    });
    expect(result.blocks).toBe(true);
    expect(result.kind).toBe('changes_requested');
  });

  it('fails closed when the review status cannot be read', async () => {
    const result = await guardReviewVerdict({
      workspaceId: 'ws-1',
      prNumber: 2396,
      headSha: SHA_A,
      deps: {
        read: async () => {
          throw new Error('connection reset');
        },
      },
    });
    expect(result.blocks).toBe(true);
    expect(result.reason).toContain('connection reset');
    expect(result.clearedBy).toBeTruthy();
  });
});

// Reviewer precision needs the merges that went past the reviewer, not only the
// ones buildd refused. A GitHub-side merge never passes a buildd door, so the
// webhook classifies the merged commit against the review state it landed on.
describe('classifyMergeAgainstReview', () => {
  it('a merge while a request-changes verdict is outstanding is merged_over_verdict', () => {
    const out = classifyMergeAgainstReview(
      status({ state: 'changes_requested', verdict: 'request-changes', reviewHeadSha: SHA_A, reviewTaskId: 'r1', merged: true }),
      SHA_A,
    );
    expect(out).toMatchObject({ event: 'merged_over_verdict', state: 'changes_requested', reviewTaskId: 'r1' });
  });

  it('a merge over an escalation is merged_over_verdict', () => {
    const out = classifyMergeAgainstReview(
      status({ state: 'escalated', verdict: 'escalate', reviewHeadSha: SHA_A }),
      SHA_A,
    );
    expect(out?.event).toBe('merged_over_verdict');
  });

  it('a merge after a fix push, before its re-review, is still over the verdict', () => {
    const out = classifyMergeAgainstReview(
      status({ state: 'changes_requested', verdict: 'request-changes', reviewHeadSha: SHA_A }),
      SHA_B,
    );
    expect(out?.event).toBe('merged_over_verdict');
  });

  it('a merge while the review is queued or running is merged_unreviewed', () => {
    for (const state of ['queued', 'reviewing'] as const) {
      const out = classifyMergeAgainstReview(status({ state, reviewHeadSha: SHA_A }), SHA_A);
      expect(out?.event).toBe('merged_unreviewed');
    }
  });

  it('a merge after the review failed to produce a verdict is merged_unreviewed', () => {
    const out = classifyMergeAgainstReview(status({ state: 'review_failed', reviewHeadSha: SHA_A }), SHA_A);
    expect(out?.event).toBe('merged_unreviewed');
  });

  it('a merge of a commit the approval did not cover is merged_unreviewed', () => {
    const out = classifyMergeAgainstReview(
      status({ state: 'approved', verdict: 'approve', reviewHeadSha: SHA_A }),
      SHA_B,
    );
    expect(out?.event).toBe('merged_unreviewed');
  });

  it('a merge of the approved commit is not an event', () => {
    expect(classifyMergeAgainstReview(
      status({ state: 'approved', verdict: 'approve', reviewHeadSha: SHA_A, merged: true }),
      SHA_A,
    )).toBeNull();
  });

  it('a merge of a content-equivalent head of the approved commit is not an event', () => {
    expect(classifyMergeAgainstReview(
      status({ state: 'approved', verdict: 'approve', reviewHeadSha: SHA_A, reviewEquivalentHeadShas: [SHA_B] }),
      SHA_B,
    )).toBeNull();
  });

  it('a PR no review was ever requested for is not an event', () => {
    // Policy tiers that never review are not reviewer misses.
    expect(classifyMergeAgainstReview(status({ state: 'not_requested' }), SHA_A)).toBeNull();
  });
});
