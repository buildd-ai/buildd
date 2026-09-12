import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetCurrentUser = mock(() => null as any);
const mockResolveOpenWorkerForUser = mock(() => ({}) as any);
const mockMissionNotesFindMany = mock(() => Promise.resolve([] as any[]));
const mockTasksFindFirst = mock(() => Promise.resolve(null) as any);
const mockWorkspacesFindFirst = mock(() => Promise.resolve(null) as any);
const mockDispatchNewTask = mock(() => Promise.resolve());
const mockAppendPrActivity = mock(() => Promise.resolve({ action: 'updated' } as any));
const mockSupersedeAncestorEscalations = mock(() => Promise.resolve());

const mockTasksValues = mock((_v: any) => {});
const mockTasksReturning = mock(() => Promise.resolve([{ id: 'apply-task-1' }]) as any);
const mockMissionNotesValues = mock((_v: any) => Promise.resolve());

mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockGetCurrentUser }));
mock.module('@/lib/pr-resolve', () => ({ resolveOpenWorkerForUser: mockResolveOpenWorkerForUser }));
mock.module('@/lib/task-dispatch', () => ({ dispatchNewTask: mockDispatchNewTask }));
mock.module('@/lib/pr-activity-comment', () => ({ appendPrActivity: mockAppendPrActivity }));
mock.module('@/lib/escalation-supersession', () => ({ supersedeAncestorEscalations: mockSupersedeAncestorEscalations }));

const TASKS_TABLE = { __name: 'tasks' };
const MISSION_NOTES_TABLE = { __name: 'missionNotes' };
const WORKSPACES_TABLE = { __name: 'workspaces' };

mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      missionNotes: { findMany: mockMissionNotesFindMany },
      tasks: { findFirst: mockTasksFindFirst },
      workspaces: { findFirst: mockWorkspacesFindFirst },
    },
    insert: (table: any) => {
      if (table === TASKS_TABLE) {
        return {
          values: (v: any) => {
            mockTasksValues(v);
            return { onConflictDoNothing: () => ({ returning: mockTasksReturning }) };
          },
        };
      }
      return { values: (v: any) => mockMissionNotesValues(v) };
    },
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (a: any, b: any) => ({ type: 'eq', a, b }),
  and: (...args: any[]) => ({ type: 'and', args }),
  inArray: (a: any, b: any) => ({ type: 'inArray', a, b }),
}));

mock.module('@buildd/core/db/schema', () => ({
  tasks: TASKS_TABLE,
  missionNotes: MISSION_NOTES_TABLE,
  workspaces: WORKSPACES_TABLE,
}));

import { POST } from './route';

function makeRequest(prNumber = '42', body?: Record<string, unknown>) {
  const req = new NextRequest(`http://localhost/api/prs/${prNumber}/apply-recommendation`, {
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
  task: { id: 't-1', title: 'Fix the thing', description: 'Original description', missionId: 'mis-1', pathManifest: ['a.ts'] },
};

const escalatedNote = {
  taskId: 't-1',
  type: 'reviewer_escalated',
  title: 'PR #42 escalated: touches schema.ts',
  body: 'touches schema.ts\n\n**Recommended next step:** Guard the null-overwrite in heartbeat/route.ts.',
  status: 'open',
  createdAt: new Date('2026-09-11T07:00:00Z'),
};

describe('POST /api/prs/[prNumber]/apply-recommendation', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockResolveOpenWorkerForUser.mockReset();
    mockMissionNotesFindMany.mockReset();
    mockMissionNotesFindMany.mockResolvedValue([escalatedNote]);
    mockTasksFindFirst.mockReset();
    mockWorkspacesFindFirst.mockReset();
    mockWorkspacesFindFirst.mockResolvedValue({ id: 'ws-1' });
    mockTasksValues.mockReset();
    mockTasksReturning.mockReset();
    mockTasksReturning.mockResolvedValue([{ id: 'apply-task-1' }]);
    mockMissionNotesValues.mockReset();
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

  it('returns 409 when there is no open reviewer recommendation to apply', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
    mockResolveOpenWorkerForUser.mockResolvedValue(openWorker);
    mockMissionNotesFindMany.mockResolvedValue([]);
    const [req, ctx] = makeRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(409);
  });

  it('dispatches a fix task carrying the recommendation verbatim and closes the escalation', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
    mockResolveOpenWorkerForUser.mockResolvedValue(openWorker);
    const [req, ctx] = makeRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, dispatched: true, taskId: 'apply-task-1' });
    expect(mockDispatchNewTask).toHaveBeenCalledTimes(1);
    expect(mockSupersedeAncestorEscalations).toHaveBeenCalledWith(expect.anything(), 't-1', 42);

    const inserted = mockTasksValues.mock.calls[0][0];
    expect(inserted.description).toContain('Guard the null-overwrite in heartbeat/route.ts.');
    expect(inserted.parentTaskId).toBe('t-1');
    expect(inserted.reviewerRetryPrNumber).toBe(42);
    expect(inserted.reviewerRetryHeadSha).toBe('abc123');
    expect(inserted.context.iteration).toBe(0);
    expect(inserted.context.baseBranch).toBe('buildd/some-branch');
    expect(inserted.creationSource).toBe('dashboard');
  });

  it('frames corrections as the authoritative instruction ahead of the recommendation', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
    mockResolveOpenWorkerForUser.mockResolvedValue(openWorker);
    const [req, ctx] = makeRequest('42', { corrections: 'Only do point 1, skip point 2.' });
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);

    const inserted = mockTasksValues.mock.calls[0][0];
    const correctionIdx = inserted.description.indexOf('Only do point 1, skip point 2.');
    const recommendationIdx = inserted.description.indexOf('Guard the null-overwrite in heartbeat/route.ts.');
    expect(correctionIdx).toBeGreaterThan(-1);
    expect(recommendationIdx).toBeGreaterThan(-1);
    expect(correctionIdx).toBeLessThan(recommendationIdx);
    expect(inserted.context.corrections).toBe('Only do point 1, skip point 2.');
  });

  it('returns the existing task id on a duplicate (double-tap) dispatch', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', email: 'max@example.com' });
    mockResolveOpenWorkerForUser.mockResolvedValue(openWorker);
    mockTasksReturning.mockResolvedValue([]);
    mockTasksFindFirst.mockResolvedValue({ id: 'existing-task-1' });
    const [req, ctx] = makeRequest();
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, dispatched: false, taskId: 'existing-task-1' });
    expect(mockDispatchNewTask).not.toHaveBeenCalled();
    expect(mockSupersedeAncestorEscalations).not.toHaveBeenCalled();
  });
});
