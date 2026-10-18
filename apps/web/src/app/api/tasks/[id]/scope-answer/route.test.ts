import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

/** POST /api/tasks/[id]/scope-answer: a person answers a held mission scope decision. */

const TASK = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

let taskRow: any = null;
let currentUser: any = { id: 'u-1' };
let apiAccountRow: any = null;
let access = true;
let answerResult: any = { resolved: true, replayed: false, resolution: 'in_scope', scopeVersion: 1, cancelled: false };

const mockAnswer = mock((_p: any) => Promise.resolve(answerResult));
const mockCancelEffects = mock((_t: any) => Promise.resolve());

mock.module('drizzle-orm', () => ({ eq: (...a: any[]) => ({ a }) }));
mock.module('@buildd/core/db/schema', () => ({ tasks: { id: 'id' } }));
mock.module('@buildd/core/db', () => ({ db: { query: { tasks: { findFirst: () => Promise.resolve(taskRow) } } } }));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: () => Promise.resolve(currentUser) }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: () => Promise.resolve(apiAccountRow) }));
mock.module('@/lib/token-route-policy', () => ({ hasTokenRouteAdminAccess: () => true }));
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: () => Promise.resolve(access),
  verifyAccountWorkspaceAccess: () => Promise.resolve(access),
}));
mock.module('@/lib/workflow/kernel-client', () => ({ kernelPrincipalOf: ({ person }: any) => ({ kind: 'user', id: person }) }));
mock.module('@/modules', () => ({ MISSION_SCOPE_ANSWER: { answer: mockAnswer } }));
mock.module('@/lib/task-cancel', () => ({ applyTaskCancelSideEffects: mockCancelEffects }));

const { POST } = await import('./route');
const call = (body: unknown, id = TASK) => POST(
  new NextRequest(`http://localhost/api/tasks/${id}/scope-answer`, { method: 'POST', body: JSON.stringify(body) }),
  { params: Promise.resolve({ id }) },
);

beforeEach(() => {
  taskRow = { id: TASK, workspaceId: 'ws-1', missionId: 'm-1' };
  currentUser = { id: 'u-1' };
  apiAccountRow = null;
  access = true;
  answerResult = { resolved: true, replayed: false, resolution: 'in_scope', scopeVersion: 1, cancelled: false };
  mockAnswer.mockClear();
  mockCancelEffects.mockClear();
});

describe('POST /api/tasks/[id]/scope-answer', () => {
  it('401s without a session or key; 404s a non-UUID id', async () => {
    expect((await call({ answer: 'in_scope' }, 'abc')).status).toBe(404);
    currentUser = null;
    expect((await call({ answer: 'in_scope' })).status).toBe(401);
  });

  it("records the person's answer through the kernel door, for the task's own mission", async () => {
    const res = await call({ answer: 'amend_scope' });
    expect(res.status).toBe(200);
    expect(mockAnswer).toHaveBeenCalledWith({
      taskId: TASK, workspaceId: 'ws-1', missionId: 'm-1', answer: 'amend_scope', actor: 'human:u-1', principal: { kind: 'user', id: 'u-1' },
    });
    expect(mockCancelEffects).not.toHaveBeenCalled();
  });

  it('it belongs elsewhere: the cancelled task gets the cancel side effects', async () => {
    answerResult = { resolved: true, replayed: false, resolution: 'out_of_scope', scopeVersion: 1, cancelled: true };
    expect((await call({ answer: 'out_of_scope' })).status).toBe(200);
    expect(mockCancelEffects).toHaveBeenCalledWith({ id: TASK, workspaceId: 'ws-1', missionId: 'm-1' });
  });

  it('refuses an unknown answer, and withdrawn (buildd records that one, not a person)', async () => {
    expect((await call({ answer: 'maybe' })).status).toBe(400);
    expect((await call({ answer: 'withdrawn' })).status).toBe(400);
    expect(mockAnswer).not.toHaveBeenCalled();
  });

  it('refuses an API key or task token: only a person answers', async () => {
    currentUser = null;
    apiAccountRow = { id: 'acct-1', level: 'admin' };
    expect((await call({ answer: 'in_scope' })).status).toBe(403);
    apiAccountRow = { id: 'acct-1', taskScope: { taskId: TASK } };
    expect((await call({ answer: 'in_scope' })).status).toBe(403);
    expect(mockAnswer).not.toHaveBeenCalled();
  });

  it('a task not waiting on a decision, or outside a mission, is a 409; a task outside reach a 404', async () => {
    answerResult = { resolved: false, reason: 'no_decision' };
    expect((await call({ answer: 'in_scope' })).status).toBe(409);
    taskRow = { ...taskRow, missionId: null };
    expect((await call({ answer: 'in_scope' })).status).toBe(409);
    access = false;
    expect((await call({ answer: 'in_scope' })).status).toBe(404);
  });
});
