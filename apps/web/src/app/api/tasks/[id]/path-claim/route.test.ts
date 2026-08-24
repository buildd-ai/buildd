import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const TASK_ID = '11111111-1111-1111-1111-111111111111';
const SIBLING_ID = '22222222-2222-2222-2222-222222222222';
const WORKSPACE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const MISSION_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const OTHER_MISSION_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockGetCurrentUser = mock(() => null as any);
const mockAccountsFindFirst = mock(() => null as any);
const mockTasksFindFirst = mock(() => null as any);
const mockReturning = mock(() => Promise.resolve([{ id: TASK_ID }]));
const mockTasksUpdate = mock(() => ({
  set: mock(() => ({
    where: mock(() => ({
      returning: mockReturning,
    })),
  })),
}));
const mockInsert = mock(() => ({
  values: mock(() => Promise.resolve([])),
}));
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));
const mockVerifyAccountWorkspaceAccess = mock(() => Promise.resolve(true));

// path-claim module mocks
const mockCheckPathClaimConflict = mock(async () => null as any);
const mockInsertClaims = mock(async () => [] as string[]);
const mockRegisterWaiter = mock(async () => ({ registered: true }));

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
      },
    },
    update: mockTasksUpdate,
    insert: mockInsert,
  },
}));

mock.module('@buildd/core/path-claim', () => ({
  checkPathClaimConflict: mockCheckPathClaimConflict,
  insertClaims: mockInsertClaims,
  registerWaiter: mockRegisterWaiter,
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

describe('POST /api/tasks/[id]/path-claim', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAccountsFindFirst.mockReset();
    mockTasksFindFirst.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();
    mockTasksUpdate.mockReset();
    mockReturning.mockReset();
    mockInsert.mockReset();
    mockCheckPathClaimConflict.mockReset();
    mockInsertClaims.mockReset();
    mockRegisterWaiter.mockReset();

    // Defaults
    mockAccountsFindFirst.mockResolvedValue({ id: 'acc-1' });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    mockCheckPathClaimConflict.mockResolvedValue(null); // no conflict
    mockInsertClaims.mockResolvedValue(['src/new.ts']);
    mockRegisterWaiter.mockResolvedValue({ registered: true });
    mockReturning.mockResolvedValue([{ id: TASK_ID }]);
    mockTasksUpdate.mockReturnValue({
      set: mock(() => ({
        where: mock(() => ({
          returning: mockReturning,
        })),
      })),
    });
    mockInsert.mockReturnValue({
      values: mock(() => Promise.resolve([])),
    });
  });

  // ── Auth / validation ───────────────────────────────────────────────────────

  it('returns 401 when unauthenticated', async () => {
    mockAccountsFindFirst.mockResolvedValue(null);
    const req = makeRequest(TASK_ID, { paths: ['src/foo.ts'] }, '');
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid UUID', async () => {
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

  // ── Wildcard guard ──────────────────────────────────────────────────────────

  it('returns 400 when paths includes "**" wildcard', async () => {
    mockTasksFindFirst.mockResolvedValue(makeActiveTask());
    const req = makeRequest(TASK_ID, { paths: ['**'] });
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Wildcard');
  });

  it('returns 400 when paths array contains "**" among specific paths', async () => {
    mockTasksFindFirst.mockResolvedValue(makeActiveTask());
    const req = makeRequest(TASK_ID, { paths: ['src/foo.ts', '**'] });
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });
    expect(res.status).toBe(400);
  });

  // ── Claim success ───────────────────────────────────────────────────────────

  it('claims unclaimed paths and extends pathManifest', async () => {
    mockTasksFindFirst.mockResolvedValue(makeActiveTask({ pathManifest: ['src/existing.ts'] }));

    const req = makeRequest(TASK_ID, { paths: ['src/new.ts'] });
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.claimed).toBe(true);
    expect(body.pathManifest).toContain('src/existing.ts');
    expect(body.pathManifest).toContain('src/new.ts');
  });

  it('inserts path_claims rows on successful claim', async () => {
    mockTasksFindFirst.mockResolvedValue(makeActiveTask({ pathManifest: null }));

    const req = makeRequest(TASK_ID, { paths: ['src/new.ts'] });
    await POST(req, { params: Promise.resolve({ id: TASK_ID }) });
    expect(mockInsertClaims).toHaveBeenCalledTimes(1);
    expect(mockInsertClaims).toHaveBeenCalledWith(WORKSPACE_ID, TASK_ID, ['src/new.ts']);
  });

  it('does not add duplicate paths already in manifest', async () => {
    mockTasksFindFirst.mockResolvedValue(makeActiveTask({ pathManifest: ['src/foo.ts'] }));

    const req = makeRequest(TASK_ID, { paths: ['src/foo.ts'] });
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.claimed).toBe(true);
    expect(body.pathManifest).toEqual(['src/foo.ts']);
    // No DB update needed for already-claimed paths
    expect(mockInsertClaims).not.toHaveBeenCalled();
  });

  it('initialises pathManifest from null when no existing manifest', async () => {
    mockTasksFindFirst.mockResolvedValue(makeActiveTask({ pathManifest: null }));

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

  it('returns 409 after all retries exhausted on concurrent modification', async () => {
    mockReturning.mockResolvedValue([]);
    mockTasksFindFirst
      .mockResolvedValueOnce(makeActiveTask({ pathManifest: null }))
      .mockResolvedValue(makeActiveTask({ pathManifest: null }));
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

  // ── Conflict / waiter registration ─────────────────────────────────────────

  it('returns 409 when paths overlap an active path_claims row', async () => {
    mockTasksFindFirst
      .mockResolvedValueOnce(makeActiveTask({ missionId: MISSION_ID })) // task
      .mockResolvedValueOnce({  // blocker
        id: SIBLING_ID,
        title: 'Sibling task',
        missionId: MISSION_ID,
      });
    mockCheckPathClaimConflict.mockResolvedValue({
      blockingTaskId: SIBLING_ID,
      blockingPath: 'src/shared.ts',
    });

    const req = makeRequest(TASK_ID, { paths: ['src/shared.ts'] });
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.claimed).toBe(false);
    expect(body.blockingTaskId).toBe(SIBLING_ID);
  });

  it('registers the requester as a waiter on 409', async () => {
    mockTasksFindFirst
      .mockResolvedValueOnce(makeActiveTask())
      .mockResolvedValueOnce({ id: SIBLING_ID, title: 'Sibling', missionId: null });
    mockCheckPathClaimConflict.mockResolvedValue({
      blockingTaskId: SIBLING_ID,
      blockingPath: 'src/shared.ts',
    });

    const req = makeRequest(TASK_ID, { paths: ['src/shared.ts'] });
    await POST(req, { params: Promise.resolve({ id: TASK_ID }) });
    expect(mockRegisterWaiter).toHaveBeenCalledWith(
      SIBLING_ID, TASK_ID, 'src/shared.ts', WORKSPACE_ID,
    );
  });

  it('returns deadlock flag when waiter registration detects a cycle', async () => {
    const cycleTaskIds = [TASK_ID, SIBLING_ID, TASK_ID];
    mockTasksFindFirst
      .mockResolvedValueOnce(makeActiveTask({ missionId: MISSION_ID }))
      .mockResolvedValueOnce({ id: SIBLING_ID, title: 'B', missionId: MISSION_ID });
    mockCheckPathClaimConflict.mockResolvedValue({
      blockingTaskId: SIBLING_ID,
      blockingPath: 'src/x.ts',
    });
    mockRegisterWaiter.mockResolvedValue({ deadlock: true, cycle: cycleTaskIds });
    mockInsert.mockReturnValue({ values: mock(() => Promise.resolve([])) });

    const req = makeRequest(TASK_ID, { paths: ['src/x.ts'] });
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.deadlock).toBe(true);
    expect(body.cycle).toEqual(cycleTaskIds);
  });

  it('cross-mission 409 message differs from same-mission', async () => {
    mockTasksFindFirst
      .mockResolvedValueOnce(makeActiveTask({ missionId: MISSION_ID }))
      .mockResolvedValueOnce({ id: SIBLING_ID, title: 'Cross', missionId: OTHER_MISSION_ID });
    mockCheckPathClaimConflict.mockResolvedValue({
      blockingTaskId: SIBLING_ID,
      blockingPath: 'src/shared.ts',
    });

    const req = makeRequest(TASK_ID, { paths: ['src/shared.ts'] });
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });
    const body = await res.json();
    expect(body.blockingMissionId).toBe(OTHER_MISSION_ID);
    expect(body.message).toContain('different mission');
  });

  // ── Wildcard sibling is not blocking ───────────────────────────────────────

  it('wildcard-manifest task does not block workspace (wildcard skipped by checkPathClaimConflict)', async () => {
    // checkPathClaimConflict already handles wildcard exclusion (tested in core tests).
    // From the route's POV: conflict=null means the claim succeeds even when a wildcard
    // task exists in the workspace.
    mockTasksFindFirst.mockResolvedValue(makeActiveTask());
    mockCheckPathClaimConflict.mockResolvedValue(null); // wildcard excluded by helper

    const req = makeRequest(TASK_ID, { paths: ['src/foo.ts'] });
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.claimed).toBe(true);
  });
});
