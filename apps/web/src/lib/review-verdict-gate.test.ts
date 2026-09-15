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

  it('passes a request-changes verdict that a later push superseded', () => {
    // The retry pushed its fix: the PR head moved, so the verdict is about code
    // that is no longer what merges. Nothing re-reviews an existing head SHA,
    // so blocking here would deadlock the PR permanently.
    const result = evaluateReviewVerdictGate(
      status({ state: 'changes_requested', verdict: 'request-changes', reviewHeadSha: SHA_A }),
      SHA_B,
    );
    expect(result.blocks).toBe(false);
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

  it('compares commits case-insensitively and ignores non-SHA noise', () => {
    expect(
      evaluateReviewVerdictGate(
        status({ state: 'changes_requested', reviewHeadSha: SHA_A.toUpperCase() }),
        SHA_A,
      ).blocks,
    ).toBe(true);
    // An abbreviated sha cannot establish identity — fail closed rather than
    // guessing that a 7-char prefix means the same commit.
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
