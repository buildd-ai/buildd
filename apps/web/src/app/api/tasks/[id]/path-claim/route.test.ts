import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const TASK_ID = '11111111-1111-1111-1111-111111111111';
const SIBLING_ID = '22222222-2222-2222-2222-222222222222';
const WORKSPACE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const MISSION_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const OTHER_MISSION_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const SIBLING_MISSION_ID = OTHER_MISSION_ID; // alias for readability in cross-mission tests

const mockGetCurrentUser = mock(() => null as any);
const mockAccountsFindFirst = mock(() => null as any);
const mockTasksFindFirst = mock(() => null as any);
const mockTasksFindMany = mock(() => Promise.resolve([] as any[]));
const mockPathClaimsFindMany = mock(() => Promise.resolve([] as any[]));
const mockReturning = mock(() => Promise.resolve([{ id: TASK_ID }]));
const mockTasksUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => ({
      returning: mockReturning,
    })),
  })),
}));
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));
const mockVerifyAccountWorkspaceAccess = mock(() => Promise.resolve(true));

// Mock for db.insert().values().onConflictDoNothing()
const mockInsertOnConflictDoNothing = mock(() => Promise.resolve([]));
const mockInsertValues = mock(() => ({ onConflictDoNothing: mockInsertOnConflictDoNothing }));
const mockDbInsert = mock(() => ({ values: mockInsertValues }));

mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

mock.module('@/lib/api-auth', () => ({
  authenticateApiKey: async (apiKey: string | null) => {
    if (!apiKey) return null;
    return mockAccountsFindFirst();
  },
}));

mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: {
        findFirst: mockTasksFindFirst,
        findMany: mockTasksFindMany,
      },
      pathClaims: {
        findMany: mockPathClaimsFindMany,
      },
    },
    update: mockTasksUpdate,
    insert: mockDbInsert,
  },
}));

import { POST } from './route';

function makeRequest(taskId: string, body: unknown, apiKey = 'bld_test') {
  return new NextRequest(`http://localhost/api/tasks/${taskId}/path-claim`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
}

function makeActiveTask(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    workspaceId: WORKSPACE_ID,
    missionId: null,
    status: 'in_progress',
    title: 'My task',
    pathManifest: null,
    ...overrides,
  };
}

function makeActiveClaim(overrides: Record<string, unknown> = {}) {
  return {
    taskId: SIBLING_ID,
    path: 'src/shared.ts',
    ...overrides,
  };
}

describe('POST /api/tasks/[id]/path-claim', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAccountsFindFirst.mockReset();
    mockTasksFindFirst.mockReset();
    mockTasksFindMany.mockReset();
    mockPathClaimsFindMany.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();
    mockTasksUpdate.mockReset();
    mockReturning.mockReset();
    mockDbInsert.mockReset();
    mockInsertValues.mockReset();
    mockInsertOnConflictDoNothing.mockReset();

    // Default: authenticated API key account, CAS succeeds, no active claims
    mockAccountsFindFirst.mockResolvedValue({ id: 'acc-1' });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    mockTasksFindMany.mockResolvedValue([]);
    mockPathClaimsFindMany.mockResolvedValue([]);
    mockReturning.mockResolvedValue([{ id: TASK_ID }]);
    mockInsertOnConflictDoNothing.mockResolvedValue([]);
    mockInsertValues.mockReturnValue({ onConflictDoNothing: mockInsertOnConflictDoNothing });
    mockDbInsert.mockReturnValue({ values: mockInsertValues });
    mockTasksUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => ({
          returning: mockReturning,
        })),
      })),
    });
  });

  it('returns 401 when unauthenticated', async () => {
    mockAccountsFindFirst.mockResolvedValue(null);
    const req = makeRequest(TASK_ID, { paths: ['src/foo.ts'] }, '');
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid UUID', async () => {
    mockTasksFindFirst.mockResolvedValue(null);
    const req = makeRequest('not-a-uuid', { paths: ['src/foo.ts'] });
    const res = await POST(req, { params: Promise.resolve({ id: 'not-a-uuid' }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('UUID');
  });

  it('returns 400 for missing paths', async () => {
    mockTasksFindFirst.mockResolvedValue(makeActiveTask());
    const req = makeRequest(TASK_ID, {});
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });
    expect(res.status).toBe(400);
  });

  it('returns 400 for empty paths array', async () => {
    mockTasksFindFirst.mockResolvedValue(makeActiveTask());
    const req = makeRequest(TASK_ID, { paths: [] });
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });
    expect(res.status).toBe(400);
  });

  it('returns 400 when paths contains the wildcard sentinel **', async () => {
    mockTasksFindFirst.mockResolvedValue(makeActiveTask());
    const req = makeRequest(TASK_ID, { paths: ['**'] });
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('**');
  });

  it('returns 404 when task not found', async () => {
    mockTasksFindFirst.mockResolvedValue(null);
    const req = makeRequest(TASK_ID, { paths: ['src/foo.ts'] });
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });
    expect(res.status).toBe(404);
  });

  it('returns 404 when account has no workspace access', async () => {
    mockTasksFindFirst.mockResolvedValue(makeActiveTask());
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(false);
    const req = makeRequest(TASK_ID, { paths: ['src/foo.ts'] });
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });
    expect(res.status).toBe(404);
  });

  it('returns 400 for non-active task status', async () => {
    mockTasksFindFirst.mockResolvedValue(makeActiveTask({ status: 'completed' }));
    const req = makeRequest(TASK_ID, { paths: ['src/foo.ts'] });
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('completed');
  });

  it('claims unclaimed paths and extends pathManifest', async () => {
    mockTasksFindFirst.mockResolvedValue(makeActiveTask({ pathManifest: ['src/existing.ts'] }));
    mockPathClaimsFindMany.mockResolvedValue([]); // no active claims

    const req = makeRequest(TASK_ID, { paths: ['src/new.ts'] });
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.claimed).toBe(true);
    expect(body.pathManifest).toContain('src/existing.ts');
    expect(body.pathManifest).toContain('src/new.ts');
  });

  it('inserts a path_claims row for each new path on success', async () => {
    mockTasksFindFirst.mockResolvedValue(makeActiveTask({ pathManifest: null }));
    mockPathClaimsFindMany.mockResolvedValue([]);

    const req = makeRequest(TASK_ID, { paths: ['src/a.ts', 'src/b.ts'] });
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });
    expect(res.status).toBe(200);

    // db.insert should have been called (for path_claims rows)
    expect(mockDbInsert).toHaveBeenCalled();
    const insertedValues = mockInsertValues.mock.calls[0][0];
    expect(insertedValues).toHaveLength(2);
    expect(insertedValues[0].path).toBe('src/a.ts');
    expect(insertedValues[1].path).toBe('src/b.ts');
    expect(insertedValues[0].taskId).toBe(TASK_ID);
    expect(insertedValues[0].workspaceId).toBe(WORKSPACE_ID);
  });

  it('does not insert path_claims rows for paths already in the manifest', async () => {
    mockTasksFindFirst.mockResolvedValue(makeActiveTask({ pathManifest: ['src/existing.ts'] }));
    mockPathClaimsFindMany.mockResolvedValue([]);

    const req = makeRequest(TASK_ID, { paths: ['src/existing.ts'] });
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });
    expect(res.status).toBe(200);
    // No new paths — insert should not be called
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  // --- path_claims-based overlap detection ---

  it('returns 409 when an active path_claim overlaps the requested path', async () => {
    mockTasksFindFirst
      .mockResolvedValueOnce(makeActiveTask({ missionId: MISSION_ID })) // current task
      .mockResolvedValueOnce({                                           // blocking task lookup
        id: SIBLING_ID,
        title: 'Sibling task',
        missionId: MISSION_ID,
      });
    mockPathClaimsFindMany.mockResolvedValue([
      makeActiveClaim({ taskId: SIBLING_ID, path: 'src/shared.ts' }),
    ]);

    const req = makeRequest(TASK_ID, { paths: ['src/shared.ts'] });
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.claimed).toBe(false);
    expect(body.blockingTaskId).toBe(SIBLING_ID);
  });

  it('returns 409 when a cross-mission sibling holds an active path_claim', async () => {
    mockTasksFindFirst
      .mockResolvedValueOnce(makeActiveTask({ missionId: MISSION_ID }))
      .mockResolvedValueOnce({
        id: SIBLING_ID,
        title: 'Cross-mission task',
        missionId: SIBLING_MISSION_ID,
      });
    mockPathClaimsFindMany.mockResolvedValue([
      makeActiveClaim({ taskId: SIBLING_ID, path: 'src/shared.ts' }),
    ]);

    const req = makeRequest(TASK_ID, { paths: ['src/shared.ts'] });
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.claimed).toBe(false);
    expect(body.blockingTaskId).toBe(SIBLING_ID);
    expect(body.blockingTaskTitle).toBe('Cross-mission task');
  });

  it('409 response carries blockingMissionId when the blocker is in a different mission', async () => {
    mockTasksFindFirst
      .mockResolvedValueOnce(makeActiveTask({ missionId: MISSION_ID }))
      .mockResolvedValueOnce({
        id: SIBLING_ID,
        title: 'Cross-mission task',
        missionId: SIBLING_MISSION_ID,
      });
    mockPathClaimsFindMany.mockResolvedValue([
      makeActiveClaim({ taskId: SIBLING_ID, path: 'src/shared.ts' }),
    ]);

    const req = makeRequest(TASK_ID, { paths: ['src/shared.ts'] });
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });
    const body = await res.json();
    expect(body.blockingMissionId).toBe(SIBLING_MISSION_ID);
    expect(body.message).toContain('different mission');
  });

  it('409 response carries null blockingMissionId for same-mission blockers', async () => {
    mockTasksFindFirst
      .mockResolvedValueOnce(makeActiveTask({ missionId: MISSION_ID }))
      .mockResolvedValueOnce({
        id: SIBLING_ID,
        title: 'Sibling task',
        missionId: MISSION_ID,
      });
    mockPathClaimsFindMany.mockResolvedValue([
      makeActiveClaim({ taskId: SIBLING_ID, path: 'src/shared.ts' }),
    ]);

    const req = makeRequest(TASK_ID, { paths: ['src/shared.ts'] });
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });
    const body = await res.json();
    expect(body.message).not.toContain('different mission');
    expect(body.message).toContain('dependsOn');
  });

  it('registers a waiter row in path_claim_waiters on 409', async () => {
    mockTasksFindFirst
      .mockResolvedValueOnce(makeActiveTask({ missionId: MISSION_ID }))
      .mockResolvedValueOnce({
        id: SIBLING_ID,
        title: 'Sibling task',
        missionId: MISSION_ID,
      });
    mockPathClaimsFindMany.mockResolvedValue([
      makeActiveClaim({ taskId: SIBLING_ID, path: 'src/shared.ts' }),
    ]);

    const req = makeRequest(TASK_ID, { paths: ['src/shared.ts'] });
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });
    expect(res.status).toBe(409);

    // Should have inserted a waiter row
    expect(mockDbInsert).toHaveBeenCalled();
    const waiterValues = mockInsertValues.mock.calls[0][0];
    expect(Array.isArray(waiterValues)).toBe(true);
    const waiter = waiterValues[0];
    expect(waiter.blockingTaskId).toBe(SIBLING_ID);
    expect(waiter.waitingTaskId).toBe(TASK_ID);
    expect(waiter.workspaceId).toBe(WORKSPACE_ID);
    expect(waiter.blockedPath).toBe('src/shared.ts');
  });

  it('returns 409 for directory-prefix overlap via path_claims', async () => {
    mockTasksFindFirst
      .mockResolvedValueOnce(makeActiveTask())
      .mockResolvedValueOnce({
        id: SIBLING_ID,
        title: 'Sibling task',
        missionId: null,
      });
    mockPathClaimsFindMany.mockResolvedValue([
      makeActiveClaim({ taskId: SIBLING_ID, path: 'apps/web/src/lib' }),
    ]);

    const req = makeRequest(TASK_ID, { paths: ['apps/web/src/lib/foo.ts'] });
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.blockingTaskId).toBe(SIBLING_ID);
  });

  it('does not block when the only active claim belongs to the caller', async () => {
    mockTasksFindFirst.mockResolvedValue(makeActiveTask({ pathManifest: null }));
    // path_claims query excludes the caller's own claims (taskId != callerTaskId)
    mockPathClaimsFindMany.mockResolvedValue([]);

    const req = makeRequest(TASK_ID, { paths: ['src/mine.ts'] });
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.claimed).toBe(true);
  });

  it('does not block on released claims (releasedAt set)', async () => {
    // The route queries path_claims WHERE releasedAt IS NULL, so released claims
    // are already filtered by the DB. This test verifies the mock path (empty result).
    mockTasksFindFirst.mockResolvedValue(makeActiveTask({ pathManifest: null }));
    mockPathClaimsFindMany.mockResolvedValue([]); // released claims filtered by DB

    const req = makeRequest(TASK_ID, { paths: ['src/released.ts'] });
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.claimed).toBe(true);
  });

  it('does not add duplicate paths already in manifest', async () => {
    mockTasksFindFirst.mockResolvedValue(makeActiveTask({ pathManifest: ['src/foo.ts'] }));
    mockPathClaimsFindMany.mockResolvedValue([]);

    const req = makeRequest(TASK_ID, { paths: ['src/foo.ts'] });
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.claimed).toBe(true);
    expect(body.pathManifest).toEqual(['src/foo.ts']);
    // No insert since path is already in manifest
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it('initialises pathManifest from null when no existing manifest', async () => {
    mockTasksFindFirst.mockResolvedValue(makeActiveTask({ pathManifest: null }));
    mockPathClaimsFindMany.mockResolvedValue([]);

    const req = makeRequest(TASK_ID, { paths: ['src/new.ts'] });
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.claimed).toBe(true);
    expect(body.pathManifest).toEqual(['src/new.ts']);
  });

  it('retries and succeeds when CAS update conflicts on first attempt', async () => {
    mockReturning
      .mockResolvedValueOnce([])       // attempt 0: lost the race
      .mockResolvedValueOnce([{ id: TASK_ID }]); // attempt 1: wins
    mockTasksFindFirst
      .mockResolvedValueOnce(makeActiveTask({ pathManifest: null }))   // initial read
      .mockResolvedValueOnce(makeActiveTask({ pathManifest: null }));  // re-read after CAS fail
    mockPathClaimsFindMany.mockResolvedValue([]);
    mockTasksUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => ({
          returning: mockReturning,
        })),
      })),
    });

    const req = makeRequest(TASK_ID, { paths: ['src/new.ts'] });
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.claimed).toBe(true);
  });

  it('returns 409 after all retries are exhausted on concurrent modification', async () => {
    mockReturning.mockResolvedValue([]);
    mockTasksFindFirst
      .mockResolvedValueOnce(makeActiveTask({ pathManifest: null }))
      .mockResolvedValue(makeActiveTask({ pathManifest: null }));
    mockPathClaimsFindMany.mockResolvedValue([]);
    mockTasksUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => ({
          returning: mockReturning,
        })),
      })),
    });

    const req = makeRequest(TASK_ID, { paths: ['src/new.ts'] });
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('Concurrent');
  });
});
