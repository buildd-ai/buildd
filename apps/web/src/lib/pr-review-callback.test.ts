import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ── DB mock ───────────────────────────────────────────────────────────────────

let reviewTaskRow: any = null;
let workerRow: any = null;
/** Whether the CAS claim finds the callback still unfired. */
let casClaims = true;
const casWheres: any[] = [];

const mockSelect = mock(() => ({
  from: () => ({
    where: () => ({
      orderBy: () => ({ limit: () => Promise.resolve(reviewTaskRow ? [reviewTaskRow] : []) }),
    }),
  }),
}));

mock.module('@buildd/core/db', () => ({
  db: {
    select: mockSelect,
    query: {
      workers: { findFirst: async () => workerRow },
    },
    update: () => ({
      set: () => ({
        where: (w: any) => {
          casWheres.push(w);
          return { returning: () => Promise.resolve(casClaims ? [{ id: 'review-task-1' }] : []) };
        },
      }),
    }),
  },
}));

// ── Fetch mock ────────────────────────────────────────────────────────────────

const fetchCalls: Array<{ url: string; body: any }> = [];
beforeEach(() => {
  fetchCalls.length = 0;
  casWheres.length = 0;
  casClaims = true;
  reviewTaskRow = null;
  workerRow = null;
  globalThis.fetch = (async (url: any, init: any = {}) => {
    fetchCalls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
});

const { deliverPrReviewCallback } = await import('./pr-review-request');

function completedReview(verdict: string, callback: any = { url: 'https://example.test/hook', on: 'verdict' }) {
  return {
    id: 'review-task-1',
    status: 'completed',
    result: { structuredOutput: { verdict, confidence: 0.9, summary: 'ok' } },
    context: { prNumber: 42, reviewCallback: callback },
  };
}

const target = { workspaceId: 'ws-1', prNumber: 42, repoFullName: 'buildd-ai/buildd' };

describe('deliverPrReviewCallback', () => {
  it('does nothing when the review carries no callback', async () => {
    reviewTaskRow = { ...completedReview('approve'), context: { prNumber: 42 } };
    expect(await deliverPrReviewCallback(target)).toBe('skipped');
    expect(fetchCalls).toHaveLength(0);
  });

  it('POSTs the verdict once the review reaches one', async () => {
    reviewTaskRow = completedReview('approve');
    expect(await deliverPrReviewCallback(target)).toBe('fired');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.body).toMatchObject({
      prNumber: 42,
      repoFullName: 'buildd-ai/buildd',
      state: 'approved',
      verdict: 'approve',
      terminal: true,
    });
  });

  it('holds off while the review is still running', async () => {
    reviewTaskRow = { id: 'review-task-1', status: 'in_progress', result: null, context: { prNumber: 42, reviewCallback: { url: 'https://example.test/hook', on: 'verdict' } } };
    expect(await deliverPrReviewCallback(target)).toBe('skipped');
    expect(fetchCalls).toHaveLength(0);
  });

  it('fires exactly once — a second delivery attempt loses the CAS claim', async () => {
    reviewTaskRow = completedReview('approve');
    expect(await deliverPrReviewCallback(target)).toBe('fired');

    casClaims = false; // the marker is now set on the row
    expect(await deliverPrReviewCallback(target)).toBe('already');
    expect(fetchCalls).toHaveLength(1);
  });

  it('an on=merge callback waits for the PR, not the approval', async () => {
    reviewTaskRow = completedReview('approve', { url: 'https://example.test/hook', on: 'merge' });
    workerRow = { taskId: 'task-1', prLifecycleStatus: 'ci_running', mergedAt: null };
    expect(await deliverPrReviewCallback(target)).toBe('skipped');

    workerRow = { taskId: 'task-1', prLifecycleStatus: 'merged', mergedAt: new Date() };
    expect(await deliverPrReviewCallback(target)).toBe('fired');
    expect(fetchCalls[0]!.body).toMatchObject({ merged: true, prState: 'merged' });
  });

  it('an on=merge callback still fires when nothing can land any more', async () => {
    // Escalated to a human: no merge is coming, so a merge-waiter must be told.
    reviewTaskRow = completedReview('escalate', { url: 'https://example.test/hook', on: 'merge' });
    workerRow = { taskId: 'task-1', prLifecycleStatus: 'pr_open', mergedAt: null };
    expect(await deliverPrReviewCallback(target)).toBe('fired');
    expect(fetchCalls[0]!.body).toMatchObject({ state: 'escalated' });
  });

  it('reports failure without throwing when the endpoint rejects', async () => {
    reviewTaskRow = completedReview('approve');
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    expect(await deliverPrReviewCallback(target)).toBe('failed');
  });

  it('never throws when the DB read blows up', async () => {
    mockSelect.mockImplementationOnce(() => {
      throw new Error('connection terminated');
    });
    expect(await deliverPrReviewCallback(target)).toBe('skipped');
  });
});
