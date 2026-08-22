import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockGetUserWorkspaceIds = mock(() => Promise.resolve([] as string[]));
const mockWorkersFindMany = mock(() => [] as any[]);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockWorkersUpdate = mock(() => ({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) }));
const mockMergePullRequest = mock(() => Promise.resolve({ merged: true, message: 'ok' }));
const mockTriggerEvent = mock(() => Promise.resolve());
const mockCheckDependsOnResolved = mock(() => Promise.resolve());
const mockCheckAndUnblockDependentMissions = mock(() => Promise.resolve());

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/team-access', () => ({ getUserWorkspaceIds: mockGetUserWorkspaceIds }));
mock.module('@/lib/github', () => ({ mergePullRequest: mockMergePullRequest }));
mock.module('@/lib/task-dependencies', () => ({ checkDependsOnResolved: mockCheckDependsOnResolved }));
mock.module('@/lib/mission-dependency', () => ({ checkAndUnblockDependentMissions: mockCheckAndUnblockDependentMissions }));
mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: { workspace: (id: string) => `workspace-${id}` },
  events: { WORKER_PROGRESS: 'worker:progress' },
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findMany: mockWorkersFindMany },
      workspaces: { findFirst: mockWorkspacesFindFirst },
    },
    update: mockWorkersUpdate,
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
  and: (...args: any[]) => ({ type: 'and', args }),
  inArray: (a: any, b: any) => ({ type: 'inArray', a, b }),
  isNotNull: (a: any) => ({ type: 'isNotNull', a }),
  isNull: (a: any) => ({ type: 'isNull', a }),
}));

mock.module('@buildd/core/db/schema', () => ({
  workers: {
    workspaceId: 'workspaceId',
    prNumber: 'prNumber',
    prUrl: 'prUrl',
    mergedAt: 'mergedAt',
    prLifecycleStatus: 'prLifecycleStatus',
    id: 'id',
  },
  workspaces: { id: 'id' },
}));

import { POST } from './route';

function makeRequest(prNumber = '42'): [NextRequest, { params: Promise<{ prNumber: string }> }] {
  const req = new NextRequest(`http://localhost/api/prs/${prNumber}/merge`, { method: 'POST' });
  return [req, { params: Promise.resolve({ prNumber }) }];
}

// A workspace resolved via githubRepo → installation (modern path)
const workspace = {
  id: 'ws-1',
  githubRepo: {
    fullName: 'org/repo',
    installation: { installationId: 12345678 },
  },
};

const openWorker = {
  id: 'w-1',
  taskId: 't-1',
  workspaceId: 'ws-1',
  prUrl: 'https://github.com/org/repo/pull/42',
  prNumber: 42,
  prLifecycleStatus: 'pr_open',
  task: { id: 't-1', missionId: null, status: 'completed' },
};

const closedWorker = { ...openWorker, prLifecycleStatus: 'closed' };

describe('POST /api/prs/[prNumber]/merge', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetUserWorkspaceIds.mockReset();
    mockWorkersFindMany.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockMergePullRequest.mockReset();
    mockTriggerEvent.mockReset();
  });

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const [req, ctx] = makeRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(401);
  });

  it('returns 400 for non-numeric prNumber', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    const [req, ctx] = makeRequest('not-a-number');
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
  });

  it('returns 404 when no matching worker', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindMany.mockResolvedValue([]);
    const [req, ctx] = makeRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(404);
  });

  it('returns 409 when PR is closed', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindMany.mockResolvedValue([closedWorker]);
    const [req, ctx] = makeRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/closed/i);
  });

  it('returns 409 when prNumber is ambiguous across workspaces', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1', 'ws-2']);
    // Same PR number, different workspace IDs
    mockWorkersFindMany.mockResolvedValue([
      { ...openWorker, workspaceId: 'ws-1' },
      { ...openWorker, id: 'w-2', workspaceId: 'ws-2', prUrl: 'https://github.com/org/other/pull/42' },
    ]);
    const [req, ctx] = makeRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/multiple workspaces/i);
    expect(body.candidates).toEqual(expect.arrayContaining(['ws-1', 'ws-2']));
    expect(mockMergePullRequest).not.toHaveBeenCalled();
  });

  it('resolves repo via githubRepo (modern path) and merges open PR', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindMany.mockResolvedValue([openWorker]);
    mockWorkspacesFindFirst.mockResolvedValue(workspace);
    mockMergePullRequest.mockResolvedValue({ merged: true, message: 'ok' });
    const updateWhere = mock(() => Promise.resolve());
    const updateSet = mock(() => ({ where: updateWhere }));
    mockWorkersUpdate.mockReturnValue({ set: updateSet });
    const [req, ctx] = makeRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    // Verify the modern installationId (numeric) and fullName were used
    expect(mockMergePullRequest).toHaveBeenCalledWith(
      workspace.githubRepo.installation.installationId,
      workspace.githubRepo.fullName,
      42,
      'squash',
    );
  });

  it('returns 422 when workspace has no GitHub installation', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindMany.mockResolvedValue([openWorker]);
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1', githubRepo: null });
    const [req, ctx] = makeRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/no GitHub installation/i);
    expect(mockMergePullRequest).not.toHaveBeenCalled();
  });

  it('maps GitHub "Not Found" to an actionable error message', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindMany.mockResolvedValue([openWorker]);
    mockWorkspacesFindFirst.mockResolvedValue(workspace);
    mockMergePullRequest.mockResolvedValue({ merged: false, message: 'Not Found' });
    const [req, ctx] = makeRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(422);
    const body = await res.json();
    // Must NOT surface the bare "Not Found" string
    expect(body.error).not.toBe('Not Found');
    // Must mention something actionable
    expect(body.error).toMatch(/buildd App|contents: write|access/i);
  });

  it('maps GitHub 405 to branch-protection guidance', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindMany.mockResolvedValue([openWorker]);
    mockWorkspacesFindFirst.mockResolvedValue(workspace);
    mockMergePullRequest.mockResolvedValue({ merged: false, message: 'Method Not Allowed' });
    const [req, ctx] = makeRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/mergeable state|branch protection/i);
  });

  it('succeeds when multiple workers share the same prNumber in the same workspace', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    // Two workers in the same workspace for the same PR (retry scenario)
    mockWorkersFindMany.mockResolvedValue([
      { ...openWorker, id: 'w-1' },
      { ...openWorker, id: 'w-2' },
    ]);
    mockWorkspacesFindFirst.mockResolvedValue(workspace);
    mockMergePullRequest.mockResolvedValue({ merged: true, message: 'ok' });
    const updateWhere = mock(() => Promise.resolve());
    const updateSet = mock(() => ({ where: updateWhere }));
    mockWorkersUpdate.mockReturnValue({ set: updateSet });
    const [req, ctx] = makeRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
  });
});
