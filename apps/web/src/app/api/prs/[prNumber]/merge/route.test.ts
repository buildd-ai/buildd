import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockGetUserWorkspaceIds = mock(() => Promise.resolve([] as string[]));
const mockWorkersFindMany = mock(() => [] as any[]);
const mockWorkspacesFindFirst = mock(() => null as any);
const mockWorkspacesFindMany = mock(() => [] as any[]);
const mockWorkersUpdate = mock(() => ({ set: mock(() => ({ where: mock(() => Promise.resolve()) })) }));
const mockMergePullRequest = mock(() => Promise.resolve({ merged: true, message: 'ok' }));
const mockTriggerEvent = mock(() => Promise.resolve());
const mockCheckDependsOnResolved = mock(() => Promise.resolve());
const mockCheckAndUnblockDependentMissions = mock(() => Promise.resolve());
// P3 mission-PR branch-lifecycle gate: guardMissionPrMerge/finalizeMissionPrMerge
// (real, unmocked `@/lib/mission-pr`) read tasks/missions and delete the branch
// via githubApi — none of which this route needed before.
const mockGithubApi = mock(() => Promise.resolve({}) as any);
const mockTasksFindMany = mock(() => Promise.resolve([]) as any);
const mockMissionsFindFirst = mock(() => Promise.resolve(null) as any);
const mockInsertValues = mock((_table: any, _v: any) => Promise.resolve());
const mockAppendPrActivity = mock(() => Promise.resolve({ action: 'updated' } as any));
const mockSupersedeAncestorEscalations = mock(() => Promise.resolve());

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/team-access', () => ({ getUserWorkspaceIds: mockGetUserWorkspaceIds }));
mock.module('@/lib/github', () => ({ mergePullRequest: mockMergePullRequest, githubApi: mockGithubApi }));
mock.module('@/lib/task-dependencies', () => ({ checkDependsOnResolved: mockCheckDependsOnResolved }));
mock.module('@/lib/mission-dependency', () => ({ checkAndUnblockDependentMissions: mockCheckAndUnblockDependentMissions }));
mock.module('@/lib/pr-activity-comment', () => ({ appendPrActivity: mockAppendPrActivity }));
mock.module('@/lib/escalation-supersession', () => ({ supersedeAncestorEscalations: mockSupersedeAncestorEscalations }));
mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: { workspace: (id: string) => `workspace-${id}` },
  events: { WORKER_PROGRESS: 'worker:progress' },
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findMany: mockWorkersFindMany },
      workspaces: { findFirst: mockWorkspacesFindFirst, findMany: mockWorkspacesFindMany },
      tasks: { findMany: mockTasksFindMany },
      missions: { findFirst: mockMissionsFindFirst },
    },
    update: mockWorkersUpdate,
    insert: (table: any) => ({ values: (v: any) => mockInsertValues(table, v) }),
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
  workspaces: { id: 'id', name: 'name', repo: 'repo' },
  missionNotes: { __name: 'missionNotes' },
}));

import { POST } from './route';
import { MISSION_PR_TASK_PREFIX } from '@buildd/core/mission-integration';

function makeRequest(
  prNumber = '42',
  body?: Record<string, unknown>,
): [NextRequest, { params: Promise<{ prNumber: string }> }] {
  const req = new NextRequest(`http://localhost/api/prs/${prNumber}/merge`, {
    method: 'POST',
    ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}),
  });
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
    mockWorkspacesFindMany.mockReset();
    mockWorkspacesFindMany.mockResolvedValue([]);
    mockMergePullRequest.mockReset();
    mockTriggerEvent.mockReset();
    mockGithubApi.mockReset();
    mockGithubApi.mockResolvedValue({});
    mockTasksFindMany.mockReset();
    mockTasksFindMany.mockResolvedValue([]);
    mockMissionsFindFirst.mockReset();
    mockMissionsFindFirst.mockResolvedValue(null);
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

  it('rejects a workspaceId that does not resolve, instead of falling back to an unscoped search', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    // Caller only has access to ws-1, but a same-numbered PR also exists in ws-2
    // (a workspace the caller cannot access). A bogus/unresolved workspaceId must
    // NOT silently widen the search to every accessible workspace.
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkspacesFindMany.mockResolvedValue([{ id: 'ws-1', name: 'my-repo', repo: 'org/my-repo' }]);
    const [req, ctx] = makeRequest('42', { workspaceId: 'totally-unknown-workspace' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/not found|not accessible/i);
    expect(mockWorkersFindMany).not.toHaveBeenCalled();
    expect(mockMergePullRequest).not.toHaveBeenCalled();
  });

  it('resolves a workspaceId supplied as a repo name (not a UUID) and scopes the search to it', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1', 'ws-2']);
    mockWorkspacesFindMany.mockResolvedValue([
      { id: 'ws-1', name: 'my-repo', repo: 'org/my-repo' },
      { id: 'ws-2', name: 'other-repo', repo: 'org/other-repo' },
    ]);
    mockWorkersFindMany.mockResolvedValue([openWorker]);
    mockWorkspacesFindFirst.mockResolvedValue(workspace);
    mockMergePullRequest.mockResolvedValue({ merged: true, message: 'ok' });
    const updateWhere = mock(() => Promise.resolve());
    const updateSet = mock(() => ({ where: updateWhere }));
    mockWorkersUpdate.mockReturnValue({ set: updateSet });
    const [req, ctx] = makeRequest('42', { workspaceId: 'my-repo' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    expect(mockWorkersFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          args: expect.arrayContaining([expect.objectContaining({ b: ['ws-1'] })]),
        }),
      }),
    );
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

// ── P3: mission-PR branch-lifecycle gate — the human-triggered merge path ────
describe('POST /api/prs/[prNumber]/merge — mission-PR branch-lifecycle gate (P3)', () => {
  const BRANCH = 'mission/checkout-arc-1a2b3c4d';

  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetUserWorkspaceIds.mockReset();
    mockWorkersFindMany.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockWorkspacesFindMany.mockReset();
    mockWorkspacesFindMany.mockResolvedValue([]);
    mockMergePullRequest.mockReset();
    mockMergePullRequest.mockResolvedValue({ merged: true, message: 'ok' });
    mockTriggerEvent.mockReset();
    mockGithubApi.mockReset();
    mockGithubApi.mockResolvedValue({});
    mockTasksFindMany.mockReset();
    mockMissionsFindFirst.mockReset();
    mockMissionsFindFirst.mockResolvedValue({ workingBranch: BRANCH, integrationBranchEnabled: true });
    const updateWhere = mock(() => Promise.resolve());
    const updateSet = mock(() => ({ where: updateWhere }));
    mockWorkersUpdate.mockReturnValue({ set: updateSet });
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkspacesFindFirst.mockResolvedValue(workspace);
  });

  const missionPrWorker = {
    ...openWorker,
    task: { id: 't-own', missionId: 'mission-1', status: 'completed', title: `${MISSION_PR_TASK_PREFIX}Checkout arc`, taskClass: 'bookkeeping' },
  };

  it('refuses to merge the mission PR while a sibling task PR is still open', async () => {
    mockTasksFindMany.mockResolvedValue([
      { id: 't-2', title: 'Task 2', status: 'completed', mode: 'execution', taskClass: 'work' },
    ]);
    // Two workers.findMany calls happen in sequence: the route's own
    // matchingWorkers lookup first, then evaluateMissionWorkState's (scoped to
    // the mission's deliverable tasks) inside the P3 guard.
    mockWorkersFindMany.mockResolvedValueOnce([missionPrWorker]).mockResolvedValueOnce([
      { taskId: 't-2', prUrl: 'u2', prNumber: 7, prBaseRef: BRANCH, mergedAt: null, prLifecycleStatus: 'pr_open', startedAt: new Date(), createdAt: new Date() },
    ]);

    const [req, ctx] = makeRequest();
    const res = await POST(req, ctx);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('still open');
    expect(mockMergePullRequest).not.toHaveBeenCalled();
  });

  it('merges the mission PR and deletes the integration branch once every task PR has landed', async () => {
    mockTasksFindMany.mockResolvedValue([
      { id: 't-2', title: 'Task 2', status: 'completed', mode: 'execution', taskClass: 'work' },
    ]);
    mockWorkersFindMany.mockResolvedValueOnce([missionPrWorker]).mockResolvedValueOnce([
      { taskId: 't-2', prUrl: 'u2', prNumber: 7, prBaseRef: BRANCH, mergedAt: new Date(), prLifecycleStatus: 'merged', startedAt: new Date(), createdAt: new Date() },
    ]);

    const [req, ctx] = makeRequest();
    const res = await POST(req, ctx);

    expect(res.status).toBe(200);
    expect(mockMergePullRequest).toHaveBeenCalledTimes(1);
    expect(mockGithubApi).toHaveBeenCalledWith(
      workspace.githubRepo.installation.installationId,
      `/repos/${workspace.githubRepo.fullName}/git/refs/heads/${encodeURIComponent(BRANCH)}`,
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('does not gate an ordinary task PR merge', async () => {
    mockWorkersFindMany.mockResolvedValue([openWorker]);

    const [req, ctx] = makeRequest();
    const res = await POST(req, ctx);

    expect(res.status).toBe(200);
    expect(mockMergePullRequest).toHaveBeenCalledTimes(1);
    expect(mockGithubApi).not.toHaveBeenCalledWith(
      expect.anything(), expect.stringContaining('/git/refs/heads/'), expect.objectContaining({ method: 'DELETE' }),
    );
  });
});

// ── "Merge anyway" — override recorded only on a successful merge ──────────
describe('POST /api/prs/[prNumber]/merge — override (Merge anyway)', () => {
  const workerWithMission = {
    ...openWorker,
    task: { id: 't-1', missionId: 'mission-1', status: 'completed' },
  };

  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetUserWorkspaceIds.mockReset();
    mockWorkersFindMany.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockWorkspacesFindMany.mockReset();
    mockWorkspacesFindMany.mockResolvedValue([]);
    mockMergePullRequest.mockReset();
    mockMergePullRequest.mockResolvedValue({ merged: true, message: 'ok' });
    mockTriggerEvent.mockReset();
    mockGithubApi.mockReset();
    mockGithubApi.mockResolvedValue({});
    mockTasksFindMany.mockReset();
    mockTasksFindMany.mockResolvedValue([]);
    mockMissionsFindFirst.mockReset();
    mockMissionsFindFirst.mockResolvedValue(null);
    mockInsertValues.mockReset();
    mockInsertValues.mockResolvedValue(undefined);
    mockAppendPrActivity.mockReset();
    mockAppendPrActivity.mockResolvedValue({ action: 'updated' } as any);
    mockSupersedeAncestorEscalations.mockReset();
    mockSupersedeAncestorEscalations.mockResolvedValue(undefined as any);
    const updateWhere = mock(() => Promise.resolve());
    const updateSet = mock(() => ({ where: updateWhere }));
    mockWorkersUpdate.mockReturnValue({ set: updateSet });
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkspacesFindFirst.mockResolvedValue(workspace);
  });

  it('records the override note, PR activity, and supersession once the merge succeeds', async () => {
    mockWorkersFindMany.mockResolvedValue([workerWithMission]);
    const [req, ctx] = makeRequest('42', { override: true, escalationReason: 'Touches packages/core/db/schema.ts' });
    const res = await POST(req, ctx);

    expect(res.status).toBe(200);
    expect(mockSupersedeAncestorEscalations).toHaveBeenCalledWith(expect.anything(), 't-1', 42);
    expect(mockAppendPrActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        prNumber: 42,
        entry: expect.objectContaining({
          kind: 'human_override_merge',
          detail: expect.stringContaining('Touches packages/core/db/schema.ts'),
        }),
      }),
    );
    const noteCall = mockInsertValues.mock.calls.find(([, v]) => v?.type === 'decision');
    expect(noteCall?.[1]).toEqual(
      expect.objectContaining({
        missionId: 'mission-1',
        taskId: 't-1',
        authorType: 'user',
        actorLabel: 'max@example.com',
        title: expect.stringContaining('human override'),
        body: expect.stringContaining('Touches packages/core/db/schema.ts'),
      }),
    );
  });

  it('does not record anything when the merge itself fails (still red/conflicted)', async () => {
    mockWorkersFindMany.mockResolvedValue([workerWithMission]);
    mockMergePullRequest.mockResolvedValue({ merged: false, message: 'Method Not Allowed' });
    const [req, ctx] = makeRequest('42', { override: true, escalationReason: 'Touches packages/core/db/schema.ts' });
    const res = await POST(req, ctx);

    expect(res.status).toBe(422);
    expect(mockInsertValues).not.toHaveBeenCalled();
    expect(mockAppendPrActivity).not.toHaveBeenCalled();
    expect(mockSupersedeAncestorEscalations).not.toHaveBeenCalled();
  });

  it('does not touch the audit trail on a plain merge (no override flag)', async () => {
    mockWorkersFindMany.mockResolvedValue([workerWithMission]);
    const [req, ctx] = makeRequest();
    const res = await POST(req, ctx);

    expect(res.status).toBe(200);
    expect(mockInsertValues).not.toHaveBeenCalled();
    expect(mockAppendPrActivity).not.toHaveBeenCalled();
    expect(mockSupersedeAncestorEscalations).not.toHaveBeenCalled();
  });
});
