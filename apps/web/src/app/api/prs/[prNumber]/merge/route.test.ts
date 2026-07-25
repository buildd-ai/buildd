import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockGetUserWorkspaceIds = mock(() => Promise.resolve([] as string[]));
const mockWorkersFindFirst = mock(() => null as any);
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
      workers: { findFirst: mockWorkersFindFirst },
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
  tasks: { id: 'id' },
  workspaces: { id: 'id' },
  githubInstallations: { id: 'id' },
  missions: { id: 'id' },
}));

import { POST } from './route';

function makeRequest(prNumber = '42'): [NextRequest, { params: Promise<{ prNumber: string }> }] {
  const req = new NextRequest(`http://localhost/api/prs/${prNumber}/merge`, { method: 'POST' });
  return [req, { params: Promise.resolve({ prNumber }) }];
}

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

const workspace = {
  id: 'ws-1',
  repo: 'org/repo',
  githubInstallationId: 'inst-1',
  githubInstallation: { installationId: 'inst-1' },
};

describe('POST /api/prs/[prNumber]/merge', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetUserWorkspaceIds.mockReset();
    mockWorkersFindFirst.mockReset();
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

  it('returns 404 when PR not found', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindFirst.mockResolvedValue(null);
    const [req, ctx] = makeRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(404);
  });

  it('returns 409 when PR is closed', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindFirst.mockResolvedValue(closedWorker);
    const [req, ctx] = makeRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/closed/i);
  });

  it('merges open PR and returns 200', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindFirst.mockResolvedValue(openWorker);
    mockWorkspacesFindFirst.mockResolvedValue(workspace);
    mockMergePullRequest.mockResolvedValue({ merged: true, message: 'ok' });
    const updateWhere = mock(() => Promise.resolve());
    const updateSet = mock(() => ({ where: updateWhere }));
    mockWorkersUpdate.mockReturnValue({ set: updateSet });
    const [req, ctx] = makeRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    expect(mockMergePullRequest).toHaveBeenCalledTimes(1);
  });

  it('returns 400 for non-numeric prNumber', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    const [req, ctx] = makeRequest('not-a-number');
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
  });
});
