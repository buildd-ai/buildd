/**
 * The `pr.closed` supersession subscribers and the workflow kernel.
 *
 * Final kernel audit (task 708a55c0): `supersession-reconcile-on-close` ran the
 * legacy reconciler on every close, kernel-owned PRs included. Its casCancel
 * cancelled the delivery's attempts and failed their workers next to T18's own
 * `cancel_open_attempts`, with no AttemptEnded, so a reopen (T19) could find a
 * ledger row still `queued`. Spec §14: no two authorities. Its sibling
 * `supersession-detect-on-close` already asked who owns the PR.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';

const mockReconcile = mock(async (_e: unknown) => ({ cancelled: [], lostRace: [], decisions: [] }));
mock.module('@/lib/supersession', () => ({ reconcileSubjectEvent: mockReconcile }));

const mockDetect = mock(async (_p: unknown) => ({ outcome: 'none' }));
mock.module('@/lib/pr-supersession-detect', () => ({ detectPrSupersession: mockDetect }));

const mockKernelDeliveryForPr = mock(async (_ws: string, _repo: string, _pr: number): Promise<string | null> => null);
mock.module('@/lib/workflow/authority', () => ({ kernelDeliveryForPr: mockKernelDeliveryForPr }));

mock.module('next/server', () => ({ after: (fn: () => unknown) => { void fn(); } }));
mock.module('@buildd/core/db', () => ({ db: { insert: () => ({ values: () => ({ onConflictDoNothing: async () => {} }) }) } }));
mock.module('@buildd/core/db/schema', () => ({ missionNotes: {}, reviewFeedback: {} }));
mock.module('@/lib/pr-activity-comment', () => ({ appendPrActivity: async () => {} }));
mock.module('@/lib/pr-review-request', () => ({ deliverPrReviewCallback: async () => {}, readPrReviewStatus: async () => ({}) }));
mock.module('@/lib/review-verdict-gate', () => ({ classifyMergeAgainstReview: () => null }));
mock.module('@/lib/gate-ledger', () => ({ fireGateEvent: () => {}, GATE_SLUGS: { REVIEW_VERDICT: 'review_verdict' } }));
mock.module('@/lib/dead-pr-shutdown', () => ({ shutdownDeadBuilddPrs: async () => {} }));
mock.module('@/lib/review-feedback', () => ({
  reviewRowFromEvent: () => null, commentRowFromEvent: () => null, withOwner: (r: unknown) => r,
}));

import { reviewSubscribers } from './review-subscribers';

const byLabel = (label: string) => {
  const s = reviewSubscribers.find((x) => x.label === label);
  if (!s) throw new Error(`no subscriber ${label}`);
  return s.run as (e: unknown) => Promise<void>;
};

const closedEvent = (over: Record<string, unknown> = {}) => ({
  workspaceId: 'ws1', repoFullName: 'owner/repo', prNumber: 42, taskId: 't1', workerId: 'w1',
  installationId: 123, merged: false, mergeIsNew: true, headSha: 'h1', ...over,
});

describe('supersession-reconcile-on-close', () => {
  const run = byLabel('supersession-reconcile-on-close');

  beforeEach(() => {
    mockReconcile.mockClear();
    mockKernelDeliveryForPr.mockReset();
    mockKernelDeliveryForPr.mockResolvedValue(null);
  });

  it.each([false, true])('a kernel-owned PR (merged=%p) is the kernel\'s: the legacy reconciler does not run', async (merged) => {
    mockKernelDeliveryForPr.mockResolvedValue('delivery-1');

    await run(closedEvent({ merged }));

    expect(mockKernelDeliveryForPr).toHaveBeenCalledWith('ws1', 'owner/repo', 42);
    expect(mockReconcile).not.toHaveBeenCalled();
  });

  it('a legacy PR keeps the reconciler', async () => {
    await run(closedEvent());

    expect(mockReconcile).toHaveBeenCalledTimes(1);
    expect(mockReconcile.mock.calls[0]![0]).toMatchObject({ kind: 'closed', workspaceId: 'ws1', prNumber: 42, originalTaskId: 't1' });
  });

  it('a merged legacy PR reconciles as merged', async () => {
    await run(closedEvent({ merged: true }));

    expect(mockReconcile.mock.calls[0]![0]).toMatchObject({ kind: 'merged' });
  });

  it('an ownership read error falls back to the reconciler, like its detect sibling', async () => {
    mockKernelDeliveryForPr.mockRejectedValue(new Error('db down'));

    await run(closedEvent());

    expect(mockReconcile).toHaveBeenCalledTimes(1);
  });
});

describe('supersession-detect-on-close (the sibling already guarded)', () => {
  const run = byLabel('supersession-detect-on-close');

  beforeEach(() => {
    mockDetect.mockClear();
    mockKernelDeliveryForPr.mockReset();
  });

  it('a kernel-owned PR is not scanned here', async () => {
    mockKernelDeliveryForPr.mockResolvedValue('delivery-1');
    await run(closedEvent());
    expect(mockDetect).not.toHaveBeenCalled();
  });
});
