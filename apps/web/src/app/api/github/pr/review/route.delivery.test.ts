process.env.NODE_ENV = 'production';

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

// GET /api/github/pr/review for a PR the workflow kernel owns (§7): state,
// verdict, round and open findings come from the delivery, with the real
// pr-review-request / pr-review-status underneath. Only the edges are stubbed.

const WORKSPACE = { id: 'ws-1', name: 'buildd', repo: 'buildd-ai/buildd', teamId: 'team-1', gitConfig: {} };

const mockWorkersFindFirst = mock(async (): Promise<any> => null);
const mockTasksFindFirst = mock(async (): Promise<any> => null);
// db.select()...limit(): the legacy reviewer-task lookups and the reviewer worker read.
const legacyReviewRows: any[] = [];
const selectChain: any = {
  from: () => selectChain,
  where: () => selectChain,
  orderBy: () => selectChain,
  limit: () => Promise.resolve(legacyReviewRows),
};
mock.module('@buildd/core/db', () => ({
  db: {
    query: { workers: { findFirst: mockWorkersFindFirst }, tasks: { findFirst: mockTasksFindFirst } },
    select: () => selectChain,
  },
}));

mock.module('@/lib/api-auth', () => ({ authenticateApiKey: () => ({ id: 'account-1', teamId: 'team-1' }) }));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => null }));
mock.module('@/lib/team-access', () => ({ getTeamWorkspaceIds: () => ['ws-1'], getUserTeamIds: async () => [] }));
mock.module('@/lib/workspace-resolver', () => ({ resolveWorkspace: () => WORKSPACE }));

const mockViews = mock(async (_ids: string[], ..._rest: unknown[]) => new Map<string, any>());
mock.module('@/lib/workflow/delivery-view', () => ({ getDeliveryViewsForTasks: mockViews }));

import { GET } from './route';
import { readPrReviewStatus } from '@/lib/pr-review-request';

const view = (over: Record<string, unknown> = {}) => ({
  state: 'CHANGES_REQUESTED',
  stateReason: null,
  headSha: 'sha-2',
  prNumber: 42,
  approvedCurrentHead: false,
  openFindings: 2,
  attempts: { review_fix: { n: 1, m: 3 } },
  rounds: [
    { id: 'r1', round: 1, headSha: 'sha-1', kind: 'full', status: 'superseded', verdict: null, effectiveVerdict: null, failureCount: 0, reviewerTaskId: 'rev-1' },
    { id: 'r2', round: 2, headSha: 'sha-2', kind: 'full', status: 'decided', verdict: 'request_changes', effectiveVerdict: 'request_changes', failureCount: 0, reviewerTaskId: 'rev-2' },
  ],
  ...over,
});

const get = () => new NextRequest('https://buildd.dev/api/github/pr/review?prNumber=42&workspaceId=buildd', {
  headers: new Headers({ authorization: 'Bearer bld_test' }),
});

beforeEach(() => {
  legacyReviewRows.length = 0;
  mockWorkersFindFirst.mockReset();
  mockWorkersFindFirst.mockResolvedValue({ id: 'w1', taskId: 'task-1', prLifecycleStatus: 'open', mergedAt: null });
  mockTasksFindFirst.mockReset();
  mockTasksFindFirst.mockResolvedValue({ missionId: null });
  mockViews.mockReset();
  mockViews.mockResolvedValue(new Map());
});

describe('GET /api/github/pr/review — delivery-owned PR', () => {
  it('reads the kernel round when no legacy reviewer task exists', async () => {
    mockViews.mockResolvedValue(new Map([['task-1', view()]]));
    const json = await (await GET(get())).json();
    expect(json.status.state).not.toBe('not_requested');
    expect(json.status).toMatchObject({
      state: 'changes_requested',
      verdict: 'request-changes',
      iteration: 1,
      maxIterations: 3,
      openFindings: 2,
      reviewHeadSha: 'sha-2',
      reviewTaskId: 'rev-2',
    });
    expect(mockViews.mock.calls[0]![3]).toEqual({ withFindings: true });
  });

  it('reports a round in flight as reviewing, not not_requested', async () => {
    mockViews.mockResolvedValue(new Map([['task-1', view({
      state: 'AWAITING_REVIEW',
      rounds: [{ id: 'r1', round: 1, headSha: 'sha-1', status: 'reviewing', verdict: null, effectiveVerdict: null, reviewerTaskId: null }],
    })]]));
    expect((await (await GET(get())).json()).status.state).toBe('reviewing');
  });

  it('a queued round after many pushes reports the fix budget used, never "round 11 of 3"', async () => {
    const rounds = Array.from({ length: 11 }, (_, i) => ({
      id: `r${i + 1}`, round: i + 1, headSha: `sha-${i + 1}`, kind: 'full',
      status: i === 10 ? 'queued' : 'superseded', verdict: null, effectiveVerdict: null, reviewerTaskId: null,
    }));
    mockViews.mockResolvedValue(new Map([['task-1', view({ state: 'AWAITING_REVIEW', openFindings: 0, attempts: { review_fix: { n: 2, m: 3 } }, rounds })]]));
    const { status } = await (await GET(get())).json();
    expect(status).toMatchObject({ state: 'queued', iteration: 2, maxIterations: 3 });
  });

  it('a queued round does not repeat an older round\'s summary as if it described this head', async () => {
    legacyReviewRows.push({ id: 'old', status: 'completed', result: { structuredOutput: { verdict: 'approve', summary: 'The prior approval stands.' } }, context: { prNumber: 42, headSha: 'sha-1' } });
    mockViews.mockResolvedValue(new Map([['task-1', view({
      state: 'AWAITING_REVIEW',
      rounds: [{ id: 'r2', round: 2, headSha: 'sha-2', status: 'queued', verdict: null, effectiveVerdict: null, reviewerTaskId: null }],
    })]]));
    const { status } = await (await GET(get())).json();
    expect(status).toMatchObject({ state: 'queued', verdict: null, summary: null, reviewHeadSha: 'sha-2' });
  });

  it('lets the effective verdict win and holds an escalated delivery as escalated', async () => {
    mockViews.mockResolvedValue(new Map([['task-1', view({
      state: 'ESCALATED',
      stateReason: 'review_escalated',
      rounds: [{ id: 'r1', round: 1, headSha: 'sha-1', status: 'decided', verdict: 'approve', effectiveVerdict: 'escalate', reviewerTaskId: null }],
    })]]));
    const { status } = await (await GET(get())).json();
    expect(status).toMatchObject({ state: 'escalated', verdict: 'escalate', terminal: true });
  });

  it('falls back to the legacy reviewer task when the PR has no delivery', async () => {
    legacyReviewRows.push({ id: 'legacy-1', status: 'pending', result: null, context: { prNumber: 42 } });
    const { status } = await (await GET(get())).json();
    expect(status).toMatchObject({ state: 'queued', reviewTaskId: 'legacy-1', openFindings: null });
  });

  it('is not_requested only when there is neither a delivery nor a reviewer task', async () => {
    expect((await (await GET(get())).json()).status.state).toBe('not_requested');
  });
});

describe('readPrReviewStatus with the delivery its caller already read', () => {
  it('uses a known delivery for the owning task instead of reading it again', async () => {
    const status = await readPrReviewStatus({
      workspaceId: 'ws-1', prNumber: 42,
      knownDelivery: { taskId: 'task-1', view: Promise.resolve(view() as any) },
    });
    expect(mockViews).not.toHaveBeenCalled();
    expect(status).toMatchObject({ state: 'changes_requested', reviewTaskId: 'rev-2' });
  });

  it('a known "no delivery" is used too: the legacy reviewer task answers, with no delivery read', async () => {
    legacyReviewRows.push({ id: 'legacy-1', status: 'pending', result: null, context: { prNumber: 42 } });
    const status = await readPrReviewStatus({ workspaceId: 'ws-1', prNumber: 42, knownDelivery: { taskId: 'task-1', view: Promise.resolve(null) } });
    expect(mockViews).not.toHaveBeenCalled();
    expect(status).toMatchObject({ state: 'queued', reviewTaskId: 'legacy-1' });
  });

  it('reads the delivery itself when the PR belongs to another task, or the known read failed', async () => {
    mockViews.mockResolvedValue(new Map([['task-1', view()]]));
    await readPrReviewStatus({ workspaceId: 'ws-1', prNumber: 42, knownDelivery: { taskId: 'other-task', view: Promise.resolve(null) } });
    expect(mockViews).toHaveBeenCalledTimes(1);
    const failed = Promise.reject(new Error('read failed'));
    failed.catch(() => {});
    const status = await readPrReviewStatus({ workspaceId: 'ws-1', prNumber: 42, knownDelivery: { taskId: 'task-1', view: failed } });
    expect(mockViews).toHaveBeenCalledTimes(2);
    expect(status.state).toBe('changes_requested');
  });
});
