import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const TASK_ID = '11111111-1111-1111-1111-111111111111';
const SIBLING_ID = '22222222-2222-2222-2222-222222222222';
const WORKSPACE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const mockGetCurrentUser = mock(() => null as any);
const mockAccountsFindFirst = mock(() => null as any);
const mockTasksFindFirst = mock(() => null as any);
const mockTasksFindMany = mock(() => Promise.resolve([] as any[]));
const mockTasksUpdate = mock(() => ({
  set: mock(() => ({ where: mock(() => Promise.resolve()) })),
}));
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));
const mockVerifyAccountWorkspaceAccess = mock(() => Promise.resolve(true));

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
    },
    update: mockTasksUpdate,
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
    mockTasksFindMany.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();
    mockTasksUpdate.mockReset();

    // Default: authenticated API key account
    mockAccountsFindFirst.mockResolvedValue({ id: 'acc-1' });
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    mockTasksFindMany.mockResolvedValue([]);
    mockTasksUpdate.mockReturnValue({
      set: mock(() => ({ where: mock(() => Promise.resolve()) })),
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
    mockTasksFindMany.mockResolvedValue([]); // no siblings

    const req = makeRequest(TASK_ID, { paths: ['src/new.ts'] });
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.claimed).toBe(true);
    expect(body.pathManifest).toContain('src/existing.ts');
    expect(body.pathManifest).toContain('src/new.ts');
  });

  it('returns 409 when paths overlap a sibling task', async () => {
    mockTasksFindFirst.mockResolvedValue(makeActiveTask());
    mockTasksFindMany.mockResolvedValue([
      {
        id: SIBLING_ID,
        title: 'Sibling task',
        pathManifest: ['src/shared.ts'],
      },
    ]);

    const req = makeRequest(TASK_ID, { paths: ['src/shared.ts'] });
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.claimed).toBe(false);
    expect(body.blockingTaskId).toBe(SIBLING_ID);
    expect(body.blockingTaskTitle).toBe('Sibling task');
  });

  it('returns 409 for directory-prefix overlap with sibling', async () => {
    mockTasksFindFirst.mockResolvedValue(makeActiveTask());
    mockTasksFindMany.mockResolvedValue([
      {
        id: SIBLING_ID,
        title: 'Sibling task',
        pathManifest: ['apps/web/src/lib'],
      },
    ]);

    // Requesting a file inside the sibling's directory
    const req = makeRequest(TASK_ID, { paths: ['apps/web/src/lib/foo.ts'] });
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.claimed).toBe(false);
    expect(body.blockingTaskId).toBe(SIBLING_ID);
  });

  it('skips sibling with null pathManifest', async () => {
    mockTasksFindFirst.mockResolvedValue(makeActiveTask());
    mockTasksFindMany.mockResolvedValue([
      { id: SIBLING_ID, title: 'Sibling', pathManifest: null },
    ]);

    const req = makeRequest(TASK_ID, { paths: ['src/foo.ts'] });
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.claimed).toBe(true);
  });

  it('does not add duplicate paths already in manifest', async () => {
    mockTasksFindFirst.mockResolvedValue(makeActiveTask({ pathManifest: ['src/foo.ts'] }));
    mockTasksFindMany.mockResolvedValue([]);

    const req = makeRequest(TASK_ID, { paths: ['src/foo.ts'] });
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.claimed).toBe(true);
    // manifest should not grow; update should not be called
    expect(body.pathManifest).toEqual(['src/foo.ts']);
  });

  it('initialises pathManifest from null when no existing manifest', async () => {
    mockTasksFindFirst.mockResolvedValue(makeActiveTask({ pathManifest: null }));
    mockTasksFindMany.mockResolvedValue([]);

    const req = makeRequest(TASK_ID, { paths: ['src/new.ts'] });
    const res = await POST(req, { params: Promise.resolve({ id: TASK_ID }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.claimed).toBe(true);
    expect(body.pathManifest).toEqual(['src/new.ts']);
  });
});
