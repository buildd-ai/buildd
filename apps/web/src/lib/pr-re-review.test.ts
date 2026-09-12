import { describe, it, expect, mock } from 'bun:test';

const mockFindReviewTaskForPr = mock(() => Promise.resolve(null) as any);

mock.module('@/lib/pr-review-request', () => ({ findReviewTaskForPr: mockFindReviewTaskForPr }));

import { resolveReReviewPlan } from './pr-re-review';

describe('resolveReReviewPlan', () => {
  it('resolves to full when no reviewer task was ever created', async () => {
    mockFindReviewTaskForPr.mockResolvedValue(null);
    const plan = await resolveReReviewPlan({ workspaceId: 'ws-1', prNumber: 1, currentHeadSha: 'sha1' });
    expect(plan).toEqual({ kind: 'full' });
  });

  it('resolves to in_flight when the latest reviewer task is still pending', async () => {
    mockFindReviewTaskForPr.mockResolvedValue({ id: 'rt-1', status: 'pending', result: null, context: null });
    const plan = await resolveReReviewPlan({ workspaceId: 'ws-1', prNumber: 1, currentHeadSha: 'sha1' });
    expect(plan).toEqual({ kind: 'in_flight', reviewTaskId: 'rt-1' });
  });

  it('resolves to in_flight when the latest reviewer task is in_progress', async () => {
    mockFindReviewTaskForPr.mockResolvedValue({ id: 'rt-1', status: 'in_progress', result: null, context: null });
    const plan = await resolveReReviewPlan({ workspaceId: 'ws-1', prNumber: 1, currentHeadSha: 'sha1' });
    expect(plan).toEqual({ kind: 'in_flight', reviewTaskId: 'rt-1' });
  });

  it('resolves to delta when a terminal verdict exists at a different SHA than the current head', async () => {
    mockFindReviewTaskForPr.mockResolvedValue({
      id: 'rt-1',
      status: 'completed',
      result: { structuredOutput: { verdict: 'approve', confidence: 0.9, summary: 'good' } },
      context: { headSha: 'old-sha' },
    });
    const plan = await resolveReReviewPlan({ workspaceId: 'ws-1', prNumber: 1, currentHeadSha: 'new-sha' });
    expect(plan).toEqual({
      kind: 'delta',
      priorVerdict: {
        headSha: 'old-sha',
        verdict: 'approve',
        confidence: 0.9,
        summary: 'good',
        feedback: null,
        escalationReason: null,
      },
    });
  });

  it('resolves to full when the terminal verdict is already at the current head', async () => {
    mockFindReviewTaskForPr.mockResolvedValue({
      id: 'rt-1',
      status: 'completed',
      result: { structuredOutput: { verdict: 'approve', confidence: 0.9, summary: 'good' } },
      context: { headSha: 'same-sha' },
    });
    const plan = await resolveReReviewPlan({ workspaceId: 'ws-1', prNumber: 1, currentHeadSha: 'same-sha' });
    expect(plan).toEqual({ kind: 'full' });
  });

  it('resolves to full when the completed task recorded no usable verdict', async () => {
    mockFindReviewTaskForPr.mockResolvedValue({
      id: 'rt-1',
      status: 'completed',
      result: null,
      context: { headSha: 'old-sha' },
    });
    const plan = await resolveReReviewPlan({ workspaceId: 'ws-1', prNumber: 1, currentHeadSha: 'new-sha' });
    expect(plan).toEqual({ kind: 'full' });
  });

  it('resolves to full when the latest reviewer task failed or was cancelled', async () => {
    mockFindReviewTaskForPr.mockResolvedValue({ id: 'rt-1', status: 'failed', result: null, context: null });
    const plan = await resolveReReviewPlan({ workspaceId: 'ws-1', prNumber: 1, currentHeadSha: 'sha1' });
    expect(plan).toEqual({ kind: 'full' });
  });
});
