import { describe, it, expect } from 'bun:test';
import { resolveMergeOutcome } from './merge-outcome';

describe('resolveMergeOutcome', () => {
  it('200 → merged', () => {
    expect(resolveMergeOutcome(true, 200, { ok: true, merged: true })).toEqual({ kind: 'merged' });
  });

  it('404 "already merged" → stale, not an error', () => {
    // The card was rendered before the PR merged (Home is a server snapshot).
    // Surfacing "PR not found" here is a lie — the card is simply out of date.
    expect(
      resolveMergeOutcome(false, 404, { error: 'PR not found or already merged' }),
    ).toEqual({ kind: 'stale' });
  });

  it('404 with an unrelated message → error', () => {
    expect(resolveMergeOutcome(false, 404, { error: 'Workspace not found' })).toEqual({
      kind: 'error',
      message: 'Workspace not found',
    });
  });

  it('conflict dispatch wins over the generic error path', () => {
    expect(
      resolveMergeOutcome(false, 409, {
        error: 'PR #1 has merge conflicts.',
        conflictRetryDispatched: true,
        conflictRetryTaskId: 'task-1',
      }),
    ).toEqual({ kind: 'conflict_dispatched', taskId: 'task-1' });
  });

  it('conflict dispatch with no task id → null taskId', () => {
    expect(
      resolveMergeOutcome(false, 409, { conflictRetryDispatched: true }),
    ).toEqual({ kind: 'conflict_dispatched', taskId: null });
  });

  it('conflictExhausted → conflict_exhausted', () => {
    expect(resolveMergeOutcome(false, 409, { conflictExhausted: true })).toEqual({
      kind: 'conflict_exhausted',
    });
  });

  it('422 → error carrying the server message', () => {
    expect(
      resolveMergeOutcome(false, 422, { error: 'PR is not in a mergeable state' }),
    ).toEqual({ kind: 'error', message: 'PR is not in a mergeable state' });
  });

  it('unparseable body → generic error', () => {
    expect(resolveMergeOutcome(false, 500, null)).toEqual({ kind: 'error', message: 'Merge failed' });
  });

  it('indeterminate + confirmed-open live state → safe-to-retry outcome', () => {
    expect(
      resolveMergeOutcome(false, 502, {
        error: "Lost GitHub's response while merging. The PR is still open, so it's safe to retry.",
        indeterminate: true,
        liveState: 'open',
      }),
    ).toEqual({
      kind: 'indeterminate',
      liveState: 'open',
      message: "Lost GitHub's response while merging. The PR is still open, so it's safe to retry.",
    });
  });

  it('indeterminate + unconfirmable live state → unknown, not safe to retry', () => {
    expect(
      resolveMergeOutcome(false, 502, {
        error: "Lost GitHub's response while merging, and its current state couldn't be confirmed.",
        indeterminate: true,
        liveState: 'unknown',
      }),
    ).toEqual({
      kind: 'indeterminate',
      liveState: 'unknown',
      message: "Lost GitHub's response while merging, and its current state couldn't be confirmed.",
    });
  });

  it('indeterminate with no liveState defaults to unknown, never assumes open', () => {
    expect(resolveMergeOutcome(false, 502, { indeterminate: true })).toEqual({
      kind: 'indeterminate',
      liveState: 'unknown',
      message: "Could not confirm the merge's result",
    });
  });
});

describe('resolveMergeOutcome — review gate', () => {
  it('409 reviewGateBlocked → review_blocked, carrying what would clear it', () => {
    expect(
      resolveMergeOutcome(false, 409, {
        error: 'Merge refused: the reviewer requested changes on this PR',
        reviewGateBlocked: true,
        clearedBy: 'Push the fix, or merge with an explicit override.',
      }),
    ).toEqual({
      kind: 'review_blocked',
      message: 'Merge refused: the reviewer requested changes on this PR',
      clearedBy: 'Push the fix, or merge with an explicit override.',
    });
  });

  it('a review block with no clearedBy still resolves as review_blocked', () => {
    expect(resolveMergeOutcome(false, 409, { error: 'Merge refused: x', reviewGateBlocked: true })).toEqual({
      kind: 'review_blocked',
      message: 'Merge refused: x',
      clearedBy: null,
    });
  });

  it('an ordinary 409 without the marker is still an error', () => {
    expect(resolveMergeOutcome(false, 409, { error: 'PR has merge conflicts' })).toEqual({
      kind: 'error',
      message: 'PR has merge conflicts',
    });
  });

  // A merge refused for conflicts with no automatic fix filed: the same merge
  // cannot succeed until the branch changes, so the card must not offer Retry.
  it('a conflict refusal with no fix filed → conflict_blocked, never a retryable error', () => {
    expect(resolveMergeOutcome(false, 422, {
      error: 'GitHub rejected the merge: PR has merge conflicts.',
      mergeConflict: true,
    })).toEqual({ kind: 'conflict_blocked', message: 'GitHub rejected the merge: PR has merge conflicts.' });
  });

  it('a conflict with a live retry reads as conflict_dispatched with that task', () => {
    expect(resolveMergeOutcome(false, 409, {
      error: 'already in progress',
      conflictRetryDispatched: true,
      conflictRetryTaskId: 'live-1',
    })).toEqual({ kind: 'conflict_dispatched', taskId: 'live-1' });
  });

  it('a transient failure stays a retryable error', () => {
    expect(resolveMergeOutcome(false, 422, { error: 'GitHub rejected the merge: Internal Server Error' })).toEqual({
      kind: 'error',
      message: 'GitHub rejected the merge: Internal Server Error',
    });
  });
});
