import { describe, it, expect } from 'bun:test';
import { evaluateReviewVerdictGate, guardReviewVerdict } from './review-verdict-gate';
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
    prState: 'open',
    merged: false,
    mergeBlocked: null,
    ...over,
  };
}

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
    expect(evaluateReviewVerdictGate(status({ state: 'not_requested' }), SHA_A).blocks).toBe(false);
  });

  it('passes review_failed — no verdict means no finding to protect', () => {
    // A reviewer whose session died produced nothing to enforce, and nothing
    // re-reviews the same head SHA, so this would strand the PR forever.
    // escalateReviewContractFailure already surfaces it to a human.
    expect(evaluateReviewVerdictGate(status({ state: 'review_failed' }), SHA_A).blocks).toBe(false);
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
