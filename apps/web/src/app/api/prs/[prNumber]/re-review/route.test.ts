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
const mockDispatchNewTask = mock(() => Promise.resolve());
const mockAppendPrActivity = mock(() => Promise.resolve({ action: 'updated' } as any));
const mockSupersedeAncestorEscalations = mock(() => Promise.resolve());

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/pr-resolve', () => ({ resolveOpenWorkerForUser: mockResolveOpenWorkerForUser }));
mock.module('@/lib/merge-policy', () => ({ resolvePolicy: mockResolvePolicy }));
mock.module('@/lib/pr-review-request', () => ({ listWorkspaceRoles: mockListWorkspaceRoles }));
mock.module('@/lib/pr-review-status', () => ({ pickReviewerRole: mockPickReviewerRole }));
mock.module('@/lib/reviewer', () => ({ createReviewerTask: mockCreateReviewerTask }));
mock.module('@/lib/task-dispatch', () => ({ dispatchNewTask: mockDispatchNewTask }));
mock.module('@/lib/pr-activity-comment', () => ({ appendPrActivity: mockAppendPrActivity }));
mock.module('@/lib/escalation-supersession', () => ({ supersedeAncestorEscalations: mockSupersedeAncestorEscalations }));

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
    mockDispatchNewTask.mockReset();
    mockAppendPrActivity.mockReset();
    mockSupersedeAncestorEscalations.mockReset();
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

    expect(mockDispatchNewTask).toHaveBeenCalledTimes(1);
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
    expect(mockDispatchNewTask).not.toHaveBeenCalled();
    expect(mockAppendPrActivity).not.toHaveBeenCalled();
    // Still closes a stale escalation note even when a live review already owns the PR.
    expect(mockSupersedeAncestorEscalations).toHaveBeenCalledWith(expect.anything(), 't-1', 42);
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
