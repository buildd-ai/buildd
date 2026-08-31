import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockAuthenticateApiKey = mock(() => null as any);
const mockVerifyWorkspaceAccess = mock(() => Promise.resolve(null as any));
const mockVerifyAccountWorkspaceAccess = mock(() => Promise.resolve(false));
const mockTasksFindFirst = mock(() => null as any);
const mockNotesFindFirst = mock(() => null as any);
const mockTriggerEvent = mock(() => Promise.resolve());

const mockInsertReturning = mock(() => [{ id: 'reply-1', authorType: 'user', title: 'Use JWT' }] as any[]);
const mockInsertValues = mock(() => ({ returning: mockInsertReturning }));
const mockInsert = mock(() => ({ values: mockInsertValues }));

const mockUpdateWhere = mock(() => Promise.resolve());
const mockUpdateSet = mock(() => ({ where: mockUpdateWhere }));
const mockUpdate = mock(() => ({ set: mockUpdateSet }));

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: mockAuthenticateApiKey }));
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: mockVerifyWorkspaceAccess,
  verifyAccountWorkspaceAccess: mockVerifyAccountWorkspaceAccess,
}));
mock.module('@/lib/pusher', () => ({
  triggerEvent: mockTriggerEvent,
  channels: { task: (id: string) => `task-${id}`, mission: (id: string) => `mission-${id}` },
  events: { MISSION_NOTE_POSTED: 'mission:note-posted' },
}));

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: { findFirst: mockTasksFindFirst },
      missionNotes: { findFirst: mockNotesFindFirst },
    },
    insert: mockInsert,
    update: () => mockUpdate(),
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (field: any, value: any) => ({ field, value, type: 'eq' }),
  and: (...conditions: any[]) => ({ conditions, type: 'and' }),
  isNull: (field: any) => ({ field, type: 'isNull' }),
}));

mock.module('@buildd/core/db/schema', () => ({
  missionNotes: { id: 'missionNotes.id', taskId: 'missionNotes.taskId', missionId: 'missionNotes.missionId' },
  tasks: { id: 'tasks.id' },
}));

import { POST } from './route';

const params = Promise.resolve({ id: 'task-1', noteId: 'note-1' });

function createRequest(body?: any, apiKey?: string): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
  return new NextRequest('http://localhost:3000/api/tasks/task-1/notes/note-1/reply', {
    method: 'POST',
    headers: new Headers(headers),
    body: JSON.stringify(body ?? {}),
  });
}

const taskScopedQuestion = {
  id: 'note-1',
  missionId: null,
  taskId: 'task-1',
  workerId: 'worker-9',
  type: 'question',
  status: 'open',
};

describe('POST /api/tasks/[id]/notes/[noteId]/reply', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockAuthenticateApiKey.mockReset();
    mockVerifyWorkspaceAccess.mockReset();
    mockVerifyAccountWorkspaceAccess.mockReset();
    mockTasksFindFirst.mockReset();
    mockNotesFindFirst.mockReset();
    mockTriggerEvent.mockClear();
    mockInsert.mockClear();
    mockInsertValues.mockClear();
    mockInsertReturning.mockClear();
    mockUpdate.mockClear();
    mockUpdateSet.mockClear();
    mockUpdateWhere.mockClear();

    mockInsertReturning.mockReturnValue([{ id: 'reply-1', authorType: 'user', title: 'Use JWT' }]);
    mockInsertValues.mockReturnValue({ returning: mockInsertReturning });
    mockInsert.mockReturnValue({ values: mockInsertValues });
    mockUpdateWhere.mockReturnValue(Promise.resolve());
    mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
    mockUpdate.mockReturnValue({ set: mockUpdateSet });

    mockGetCurrentUser.mockResolvedValue({ id: 'user-1' });
    mockAuthenticateApiKey.mockResolvedValue(null);
    mockVerifyWorkspaceAccess.mockResolvedValue({ teamId: 'team-1', role: 'owner' });
    mockTasksFindFirst.mockResolvedValue({ id: 'task-1', workspaceId: 'ws-1', missionId: null });
    mockNotesFindFirst.mockResolvedValue({ ...taskScopedQuestion });
  });

  it('returns 401 when unauthenticated', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    mockAuthenticateApiKey.mockResolvedValue(null);

    const res = await POST(createRequest({ title: 'Use JWT' }), { params });
    expect(res.status).toBe(401);
  });

  it('returns 404 when the note does not belong to the task', async () => {
    mockNotesFindFirst.mockResolvedValue(null);

    const res = await POST(createRequest({ title: 'Use JWT' }), { params });
    expect(res.status).toBe(404);
  });

  it('returns 400 when title is missing', async () => {
    const res = await POST(createRequest({}), { params });
    expect(res.status).toBe(400);
  });

  it('marks the parent question answered and posts the reply', async () => {
    const res = await POST(createRequest({ title: 'Use JWT' }), { params });

    expect(res.status).toBe(201);
    expect(mockUpdateSet.mock.calls[0][0].status).toBe('answered');
    expect(mockTriggerEvent).toHaveBeenCalledTimes(1);
  });

  // C7 regression: the reply carried nothing that tied it to the asking worker,
  // so the runner's note-delivery selection (question -> reply by workerId /
  // scope) could never find it. A reply must inherit its parent's scope.
  it('inherits the parent note scope (mission, task, worker) onto the reply', async () => {
    await POST(createRequest({ title: 'Use JWT' }), { params });

    const values = mockInsertValues.mock.calls[0][0] as any;
    expect(values.taskId).toBe('task-1');
    expect(values.missionId).toBeNull();
    expect(values.workerId).toBe('worker-9');
    expect(values.replyTo).toBe('note-1');
    expect(values.type).toBe('reply');
    expect(values.authorType).toBe('user');
  });

  // C7 regression: the parent lookup demanded `missionId IS NULL`, while the
  // only note-delivery path selects notes with a NON-NULL missionId. Notes that
  // carry both (e.g. reviewer_escalated, dead-PR shutdown) hang off a task but
  // belong to a mission — replying to one 404'd, so a reply that WOULD have been
  // delivered could not be written at all.
  it('accepts a mission-scoped note attached to the task and keeps its mission scope', async () => {
    mockTasksFindFirst.mockResolvedValue({ id: 'task-1', workspaceId: 'ws-1', missionId: 'mission-1' });
    mockNotesFindFirst.mockResolvedValue({
      ...taskScopedQuestion,
      missionId: 'mission-1',
    });

    const res = await POST(createRequest({ title: 'Merge it' }), { params });

    expect(res.status).toBe(201);
    const values = mockInsertValues.mock.calls[0][0] as any;
    // Same scope as the question, so the delivery selection matches it.
    expect(values.missionId).toBe('mission-1');
    expect(values.taskId).toBe('task-1');
  });

  it('does not restrict the parent lookup to task-scoped notes', async () => {
    await POST(createRequest({ title: 'Use JWT' }), { params });

    const where = JSON.stringify(mockNotesFindFirst.mock.calls[0][0]);
    expect(where).toContain('missionNotes.taskId');
    expect(where).not.toContain('isNull');
  });
});
