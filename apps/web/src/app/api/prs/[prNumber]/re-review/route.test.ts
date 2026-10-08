import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockResolveOpenWorkerForUser = mock(() => ({}) as any);
const mockWorkspacesFindFirst = mock(() => Promise.resolve(null) as any);
const mockMissionsFindFirst = mock(() => Promise.resolve(null) as any);
const mockResolvePolicy = mock(() => ({ tier: 'agent-review' as const }));
const mockListWorkspaceRoles = mock(() => Promise.resolve([{ slug: 'reviewer', isRole: true }]));
const mockPickReviewerRole = mock(() => ({ role: 'reviewer', source: 'default' as const }));
const mockCreateReviewerTask = mock(() => Promise.resolve({ id: 'review-task-1' }) as any);
const mockAnnounceTaskCreated = mock(() => Promise.resolve());
const mockAppendPrActivity = mock(() => Promise.resolve({ action: 'updated' } as any));
const mockSupersedeAncestorEscalations = mock(() => Promise.resolve());
const mockResolveReReviewPlan = mock(() => Promise.resolve({ kind: 'full' as const }));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/pr-resolve', () => ({ resolveOpenWorkerForUser: mockResolveOpenWorkerForUser }));
mock.module('@/lib/merge-policy', () => ({ resolvePolicy: mockResolvePolicy }));
mock.module('@/lib/pr-review-request', () => ({ listWorkspaceRoles: mockListWorkspaceRoles }));
mock.module('@/lib/pr-review-status', () => ({ pickReviewerRole: mockPickReviewerRole }));
mock.module('@/lib/reviewer', () => ({ createReviewerTask: mockCreateReviewerTask }));
// The dispatch authority's full surface: mock.module is process-global.
const mockWakeTask = mock(async (_taskId: string, _cause: string, _opts?: unknown) => {});
mock.module('@/lib/dispatch-authority', () => ({
  announceTaskCreated: mockAnnounceTaskCreated,
  wakeTask: mockWakeTask,
  wakeTasks: mock(async () => {}),
  kickDispatch: () => {},
  enqueueTaskDispatch: async () => {},
  drainDispatchOutbox: async () => ({ claimed: 0, delivered: 0, skipped: 0, failed: 0 }),
  deliverTaskDispatch: async () => 'pusher',
  routeForCause: () => ({ event: 'task.created', legacyDefault: true, legacyUnfilteredRunnerPreference: false }),
  webhookWants: () => false,
  primaryCause: (_causes: string[], fallback: string) => fallback,
  DISPATCH_DUE_QUEUE: 'dispatch',
  DRAIN_BATCH: 25,
  reseedDispatchTimer: async () => {},
}));
mock.module('@/lib/pr-activity-comment', () => ({ appendPrActivity: mockAppendPrActivity }));
mock.module('@/lib/escalation-supersession', () => ({ supersedeAncestorEscalations: mockSupersedeAncestorEscalations }));
mock.module('@/lib/pr-re-review', () => ({ resolveReReviewPlan: mockResolveReReviewPlan }));
const mockCarryForward = mock(async (_p: any) => ({ carried: false, reason: 'PR diff changed' }));
mock.module('@/lib/approval-carry-forward', () => ({ carryForwardApprovalIfUnchanged: mockCarryForward }));

// Workflow kernel (lib/workflow/seam.ts): a PR it owns is re-reviewed through
// T5. Default: not a kernel PR, so every legacy case runs unchanged.
const mockRequestKernelReview = mock(async (_p: any): Promise<any> => ({ handled: false }));
mock.module('@/lib/workflow/seam', () => ({ requestReview: mockRequestKernelReview }));
mock.module('@/lib/workflow/github-facts', () => ({
  workspaceRepo: async () => ({ installationId: 999, repoFullName: 'org/repo', gitConfig: null }),
}));

const WORKSPACES_TABLE = { __name: 'workspaces' };
const MISSIONS_TABLE = { __name: 'missions' };

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workspaces: { findFirst: mockWorkspacesFindFirst },
      missions: { findFirst: mockMissionsFindFirst },
    },
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workspaces: WORKSPACES_TABLE,
  missions: MISSIONS_TABLE,
}));

import { POST } from './route';

function makeRequest(prNumber = '42', body?: Record<string, unknown>) {
  const req = new NextRequest(`http://localhost/api/prs/${prNumber}/re-review`, {
    method: 'POST',
    ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}),
  });
  return [req, { params: Promise.resolve({ prNumber }) }] as const;
}

const openWorker = {
  id: 'w-1',
  taskId: 't-1',
  workspaceId: 'ws-1',
  branch: 'buildd/some-branch',
  prUrl: 'https://github.com/org/repo/pull/42',
  lastCommitSha: 'abc123',
  prBaseRef: 'dev',
  task: {
    id: 't-1',
    title: 'Fix the thing',
    description: 'Original description',
    backend: 'claude',
    missionId: null,
    pathManifest: ['a.ts'],
  },
};

const workspaceRow = {
  id: 'ws-1',
  teamId: 'team-1',
  gitConfig: null,
  githubRepo: { fullName: 'org/repo', installation: { installationId: 999 } },
};

describe('POST /api/prs/[prNumber]/re-review', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockResolveOpenWorkerForUser.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockWorkspacesFindFirst.mockResolvedValue(workspaceRow);
    mockMissionsFindFirst.mockReset();
    mockResolvePolicy.mockReset();
    mockResolvePolicy.mockReturnValue({ tier: 'agent-review' as const });
    mockListWorkspaceRoles.mockReset();
    mockListWorkspaceRoles.mockResolvedValue([{ slug: 'reviewer', isRole: true }]);
    mockPickReviewerRole.mockReset();
    mockPickReviewerRole.mockReturnValue({ role: 'reviewer', source: 'default' as const });
    mockCreateReviewerTask.mockReset();
    mockCreateReviewerTask.mockResolvedValue({ id: 'review-task-1' });
    mockAnnounceTaskCreated.mockReset();
    mockWakeTask.mockReset();
    mockAppendPrActivity.mockReset();
    mockSupersedeAncestorEscalations.mockReset();
    mockResolveReReviewPlan.mockReset();
    mockResolveReReviewPlan.mockResolvedValue({ kind: 'full' as const });
    mockRequestKernelReview.mockReset();
    mockRequestKernelReview.mockResolvedValue({ handled: false });
  });

  describe('workflow kernel PR', () => {
    const current = { state: 'FIXING', version: 6, head: 'h1', round: 1 };

    it('is T5 on the live head: a forced human request, never the runner-reported lastCommitSha', async () => {
      mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
      // No recorded head at all: the legacy path would 422; the kernel reads GitHub.
      mockResolveOpenWorkerForUser.mockResolvedValue({ ...openWorker, lastCommitSha: null });
      mockRequestKernelReview.mockResolvedValue({ handled: true, result: { result: 'applied', transitionId: 't', deliveryId: 'd', version: 7, decision: {} } });
      const [req, ctx] = makeRequest();
      const res = await POST(req, ctx);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, dispatched: true, kernel: true });
      expect(mockRequestKernelReview).toHaveBeenCalledWith(expect.objectContaining({
        workspaceId: 'ws-1', repoFullName: 'org/repo', prNumber: 42, installationId: 999, forced: true, actor: 'human:u-1',
      }));
      expect(mockCreateReviewerTask).not.toHaveBeenCalled();
      expect(mockSupersedeAncestorEscalations).toHaveBeenCalledWith(expect.anything(), 't-1', 42);
    });

    it('a round already in flight is the existing review, not a second one', async () => {
      mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
      mockResolveOpenWorkerForUser.mockResolvedValue(openWorker);
      mockRequestKernelReview.mockResolvedValue({ handled: true, result: { result: 'rejected', reason: 'review_in_flight', current } });
      const [req, ctx] = makeRequest();
      expect(await (await POST(req, ctx)).json()).toEqual({ ok: true, alreadyRequested: true, kernel: true });
      expect(mockCreateReviewerTask).not.toHaveBeenCalled();
    });

    it('a request the transition table refuses (e.g. a fix is running) is a 409 carrying the current view', async () => {
      mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
      mockResolveOpenWorkerForUser.mockResolvedValue(openWorker);
      mockRequestKernelReview.mockResolvedValue({ handled: true, result: { result: 'rejected', reason: 'state_not_allowed', current } });
      const [req, ctx] = makeRequest();
      const res = await POST(req, ctx);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'state_not_allowed', current, kernel: true });
      expect(mockCreateReviewerTask).not.toHaveBeenCalled();
    });
  });

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const [req, ctx] = makeRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(401);
  });

  it('returns 400 for a non-numeric prNumber', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
    const [req, ctx] = makeRequest('not-a-number');
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
  });

  it('propagates a resolver error (e.g. PR not found)', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
    mockResolveOpenWorkerForUser.mockResolvedValue({ error: 'PR not found or already merged', status: 404 });
    const [req, ctx] = makeRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(404);
  });

  it('returns 422 when the PR has no recorded head commit', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
    mockResolveOpenWorkerForUser.mockResolvedValue({ ...openWorker, lastCommitSha: null });
    const [req, ctx] = makeRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(422);
  });

  it('returns 422 when the workspace has no GitHub installation', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
    mockResolveOpenWorkerForUser.mockResolvedValue(openWorker);
    mockWorkspacesFindFirst.mockResolvedValue({ ...workspaceRow, githubRepo: null });
    const [req, ctx] = makeRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(422);
  });

  it('dispatches a fresh reviewer task and closes any stale escalation', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
    mockResolveOpenWorkerForUser.mockResolvedValue(openWorker);
    const [req, ctx] = makeRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, dispatched: true, reviewTaskId: 'review-task-1' });

    expect(mockCreateReviewerTask).toHaveBeenCalledTimes(1);
    const created = mockCreateReviewerTask.mock.calls[0][0] as any;
    expect(created.originalTaskId).toBe('t-1');
    expect(created.prNumber).toBe(42);
    expect(created.headSha).toBe('abc123');
    expect(created.reviewerRole).toBe('reviewer');

    expect(mockAnnounceTaskCreated).toHaveBeenCalledTimes(1);
    expect(mockWakeTask).toHaveBeenCalledWith((mockAnnounceTaskCreated.mock.calls[0] as any[])[0].id, 'task.created');
    expect(mockAppendPrActivity).toHaveBeenCalledTimes(1);
    expect(mockSupersedeAncestorEscalations).toHaveBeenCalledWith(expect.anything(), 't-1', 42);
  });

  it('does not dispatch again when createReviewerTask reports a live dedup', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
    mockResolveOpenWorkerForUser.mockResolvedValue(openWorker);
    mockCreateReviewerTask.mockResolvedValue({ id: 'review-task-1', deduplicated: true });
    const [req, ctx] = makeRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, dispatched: false, reviewTaskId: 'review-task-1' });
    expect(mockAnnounceTaskCreated).not.toHaveBeenCalled();
    expect(mockWakeTask).not.toHaveBeenCalled();
    expect(mockAppendPrActivity).not.toHaveBeenCalled();
    // Still closes a stale escalation note even when a live review already owns the PR.
    expect(mockSupersedeAncestorEscalations).toHaveBeenCalledWith(expect.anything(), 't-1', 42);
  });

  it('dispatches a DELTA review with the prior verdict when one exists at a different SHA', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
    mockResolveOpenWorkerForUser.mockResolvedValue(openWorker);
    const priorVerdict = {
      headSha: 'old-sha',
      verdict: 'approve' as const,
      confidence: 0.9,
      summary: 'Looks good',
      feedback: null,
      escalationReason: null,
    };
    mockResolveReReviewPlan.mockResolvedValue({ kind: 'delta' as const, priorVerdict });
    const [req, ctx] = makeRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);

    expect(mockResolveReReviewPlan).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      prNumber: 42,
      currentHeadSha: 'abc123',
    });
    expect(mockCreateReviewerTask).toHaveBeenCalledTimes(1);
    const created = mockCreateReviewerTask.mock.calls[0][0] as any;
    expect(created.priorVerdict).toEqual(priorVerdict);
    // baseRef must reach buildDeltaReviewerContext, or it falls back to the
    // weaker pulls/files bound, which misattributes base-history churn (like
    // an already-merged migration) to this PR — see PR #2907.
    expect(created.baseRef).toBe('dev');

    // The PR activity entry says this was a delta, not a full re-read.
    const activity = mockAppendPrActivity.mock.calls[0][0] as any;
    // Short and public-safe: no requester email, just "manual · since <sha>".
    expect(activity.entry.detail).toContain('manual · since');
    expect(activity.entry.detail).not.toContain('@');
  });

  it('carries an approval forward instead of dispatching when only the base moved', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
    mockResolveOpenWorkerForUser.mockResolvedValue(openWorker);
    mockResolveReReviewPlan.mockResolvedValue({
      kind: 'delta' as const,
      priorVerdict: { headSha: 'old-sha', verdict: 'approve' as const, confidence: 0.9, summary: 'ok', feedback: null, escalationReason: null },
    });
    mockCarryForward.mockResolvedValueOnce({ carried: true, reason: 'PR diff unchanged' });
    const [req, ctx] = makeRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, carriedForward: true, reason: 'PR diff unchanged' });
    expect(mockCarryForward.mock.calls.at(-1)![0]).toMatchObject({ prNumber: 42, headSha: 'abc123', baseRef: 'dev' });
    expect(mockCreateReviewerTask).not.toHaveBeenCalled();
  });

  it('returns the in-flight review instead of stacking a second one', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
    mockResolveOpenWorkerForUser.mockResolvedValue(openWorker);
    mockResolveReReviewPlan.mockResolvedValue({ kind: 'in_flight' as const, reviewTaskId: 'live-review-1' });
    const [req, ctx] = makeRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, alreadyRequested: true, reviewTaskId: 'live-review-1' });
    expect(mockCreateReviewerTask).not.toHaveBeenCalled();
    expect(mockAnnounceTaskCreated).not.toHaveBeenCalled();
    expect(mockWakeTask).not.toHaveBeenCalled();
  });

  it('returns 400 when the workspace has no reviewer role available', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
    mockResolveOpenWorkerForUser.mockResolvedValue(openWorker);
    mockPickReviewerRole.mockReturnValue({ role: null, error: 'Workspace has no roles' });
    const [req, ctx] = makeRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
  });
});
