/**
 * GET /api/tasks/[id]/notes — a task's own notes, whether or not the task
 * belongs to a mission (docs/design/mission-feed-mobile-continuity.md S6: the
 * task page drops its `!task.missionId` gates, so a mission task shows the
 * questions scoped to it). Predicates are stubbed so the WHERE clause is
 * observable rather than swallowed by a mocked db.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));
const mockVerifyAccountWorkspaceAccess = mock(() => Promise.resolve(false));
const mockTasksFindFirst = mock(() => null as any);
const mockNotesFindMany = mock((_args: any) => [] as any[]);
const mockWorkersFindFirst = mock(() => null as any);
const mockNotesInsertValues = mock((vals: any) => ({ returning: () => [{ id: 'note-1', ...vals }] }));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
}));
mock.module('@/lib/pusher', () => ({
  triggerEvent: mock(() => Promise.resolve()),
  channels: { task: (id: string) => `task-${id}` },
  events: { MISSION_NOTE_POSTED: 'mission:note-posted' },
}));
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: { findFirst: mockTasksFindFirst },
      missionNotes: { findMany: mockNotesFindMany },
      workspaces: { findFirst: mock(() => null) },
      workers: { findFirst: mockWorkersFindFirst },
    },
    insert: () => ({ values: mockNotesInsertValues }),
  },
}));
mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ type: 'eq', field, value }),
  and: (...conditions: any[]) => ({ type: 'and', conditions }),
  isNull: (field: any) => ({ type: 'isNull', field }),
  asc: (field: any) => ({ type: 'asc', field }),
}));
mock.module('@buildd/core/db/schema', () => ({
  missionNotes: { taskId: 'missionNotes.taskId', missionId: 'missionNotes.missionId', createdAt: 'missionNotes.createdAt' },
  tasks: { id: 'tasks.id' },
  workspaces: { id: 'workspaces.id' },
  accounts: { id: 'accounts.id' },
}));

import { GET, POST } from './route';

const params = Promise.resolve({ id: '55555555-5555-4555-8555-555555555555' });
const req = () => new NextRequest('http://localhost:3000/api/tasks/55555555-5555-4555-8555-555555555555/notes');

/** Every leaf predicate in a stubbed where tree. */
function leaves(node: any): any[] {
  if (!node) return [];
  if (node.type === 'and') return node.conditions.flatMap(leaves);
  return [node];
}

describe('GET /api/tasks/[id]/notes', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockTasksFindFirst.mockReset();
    mockNotesFindMany.mockReset();
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockNotesFindMany.mockResolvedValue([]);
  });

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const res = await GET(req(), { params });
    expect(res.status).toBe(401);
  });

  it('404s a non-UUID id (e.g. a short 8-hex id) without querying the db', async () => {
    const res = await GET(req(), { params: Promise.resolve({ id: 'a1b2c3d4' }) });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain('UUID');
    expect(mockTasksFindFirst).not.toHaveBeenCalled();
  });

  it('returns 404 without workspace access', async () => {
    mockTasksFindFirst.mockResolvedValue({ id: '55555555-5555-4555-8555-555555555555', workspaceId: 'ws-1', missionId: null });
    mockVerifyWorkspaceAccess.mockResolvedValue(null);
    const res = await GET(req(), { params });
    expect(res.status).toBe(404);
  });

  it('scopes to the task and does not exclude mission-scoped notes', async () => {
    mockTasksFindFirst.mockResolvedValue({ id: '55555555-5555-4555-8555-555555555555', workspaceId: 'ws-1', missionId: 'mission-1' });
    const note = { id: 'n1', taskId: '55555555-5555-4555-8555-555555555555', missionId: 'mission-1', type: 'question', status: 'open' };
    mockNotesFindMany.mockResolvedValue([note]);

    const res = await GET(req(), { params });
    expect(res.status).toBe(200);
    expect((await res.json()).notes).toEqual([note]);

    const where = leaves(mockNotesFindMany.mock.calls[0][0].where);
    expect(where).toContainEqual({ type: 'eq', field: 'missionNotes.taskId', value: '55555555-5555-4555-8555-555555555555' });
    expect(where.some(p => p.type === 'isNull' && p.field === 'missionNotes.missionId')).toBe(false);
  });
});

describe('POST /api/tasks/[id]/notes', () => {
  const TASK = '55555555-5555-4555-8555-555555555555';
  const OTHER = '66666666-6666-4666-8666-666666666666';
  const SCOPED = { id: 'acct-1', level: 'worker', taskScope: { taskId: TASK, workspaceId: 'ws-1', expiresAt: Date.now() + 60_000 } };
  const post = (id: string, body: Record<string, unknown>) =>
    POST(new NextRequest(`http://localhost:3000/api/tasks/${id}/notes`, {
      method: 'POST',
      headers: { authorization: 'Bearer bld_test', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }), { params: Promise.resolve({ id }) });

  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockResolvedValue(true);
    mockTasksFindFirst.mockReset();
    mockTasksFindFirst.mockImplementation(async () => ({ id: TASK, workspaceId: 'ws-1', missionId: null }));
    mockWorkersFindFirst.mockReset();
    mockNotesInsertValues.mockClear();
  });

  it('a task token posts a note on its own task, attributed to its own worker', async () => {
    mockAuthenticateApiKey.mockResolvedValue(SCOPED);
    mockWorkersFindFirst.mockResolvedValue({ taskId: TASK, accountId: 'acct-1' });
    const res = await post(TASK, { type: 'update', title: 'Progress', workerId: 'worker-own' });
    expect(res.status).toBe(201);
    expect(mockNotesInsertValues).toHaveBeenCalledTimes(1);
  });

  it("a task token is refused another task's notes, before any lookup or write", async () => {
    mockAuthenticateApiKey.mockResolvedValue(SCOPED);
    const res = await post(OTHER, { type: 'update', title: 'Elsewhere' });
    expect(res.status).toBe(404);
    expect(mockTasksFindFirst).not.toHaveBeenCalled();
    expect(mockNotesInsertValues).not.toHaveBeenCalled();
  });

  it("a task token may not attribute its note to another task's worker", async () => {
    mockAuthenticateApiKey.mockResolvedValue(SCOPED);
    mockWorkersFindFirst.mockResolvedValue({ taskId: OTHER, accountId: 'acct-1' });
    const res = await post(TASK, { type: 'question', title: 'Which?', workerId: 'worker-other' });
    expect(res.status).toBe(403);
    expect(mockNotesInsertValues).not.toHaveBeenCalled();
  });

  it('an account key posts on any task its workspace access covers, any worker named', async () => {
    mockAuthenticateApiKey.mockResolvedValue({ id: 'acct-1', level: 'worker' });
    mockTasksFindFirst.mockImplementation(async () => ({ id: OTHER, workspaceId: 'ws-2', missionId: null }));
    const res = await post(OTHER, { type: 'update', title: 'Progress', workerId: 'worker-any' });
    expect(res.status).toBe(201);
    expect(mockWorkersFindFirst).not.toHaveBeenCalled();
  });
});
