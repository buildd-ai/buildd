import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

/** POST /api/tasks/[id]/closed-pr: abandon a closed PR on a task with no mission. */

const TASK = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

let taskRow: any = null;
let currentUser: any = { id: 'u-1', email: 'owner@example.com' };
let apiAccountRow: any = null;
let access = true;

const mockAbandon = mock((_p: any) => Promise.resolve({ ok: true } as any));

mock.module('drizzle-orm', () => ({ eq: (...a: any[]) => ({ a }), desc: (a: any) => a }));
mock.module('@buildd/core/db/schema', () => ({ tasks: { id: 'id' }, workers: { startedAt: 's' } }));
mock.module('@buildd/core/db', () => ({ db: { query: { tasks: { findFirst: () => Promise.resolve(taskRow) } } } }));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: () => Promise.resolve(currentUser) }));
mock.module('@/lib/api-auth', () => ({ authenticateApiKey: () => Promise.resolve(apiAccountRow) }));
mock.module('@/lib/token-route-policy', () => ({ hasTokenRouteAdminAccess: () => true }));
mock.module('@/lib/team-access', () => ({
  verifyWorkspaceAccess: () => Promise.resolve(access),
  verifyAccountWorkspaceAccess: () => Promise.resolve(access),
}));
mock.module('@/lib/pr-supersession', () => ({ recordPrAbandonment: mockAbandon }));

const { POST } = await import('./route');
const call = (body: unknown, id = TASK) => POST(
  new NextRequest(`http://localhost/api/tasks/${id}/closed-pr`, { method: 'POST', body: JSON.stringify(body) }),
  { params: Promise.resolve({ id }) },
);

beforeEach(() => {
  taskRow = { id: TASK, workspaceId: 'ws-1', workers: [{ id: 'w-1', prUrl: 'https://github.com/org/repo/pull/132' }] };
  currentUser = { id: 'u-1', email: 'owner@example.com' };
  apiAccountRow = null;
  access = true;
  mockAbandon.mockClear();
});

describe('POST /api/tasks/[id]/closed-pr', () => {
  it('401s without a session or key', async () => {
    currentUser = null;
    expect((await call({ action: 'abandon', reason: 'x' })).status).toBe(401);
  });

  it('abandons a task with no mission as the signed-in person', async () => {
    const res = await call({ action: 'abandon', reason: ' throwaway test ' });
    expect(res.status).toBe(200);
    expect(mockAbandon).toHaveBeenCalledWith({
      workerId: 'w-1', reason: 'throwaway test', recordedBy: 'owner@example.com', actor: 'human:u-1',
    });
  });

  it('requires a reason', async () => {
    expect((await call({ action: 'abandon', reason: '  ' })).status).toBe(400);
    expect(mockAbandon).not.toHaveBeenCalled();
  });

  it('refuses an API key and a task token', async () => {
    currentUser = null;
    apiAccountRow = { id: 'a-1', name: 'runner' };
    expect((await call({ action: 'abandon', reason: 'x' })).status).toBe(403);
    apiAccountRow = { id: 'a-1', name: 'runner', taskScope: { taskId: TASK } };
    expect((await call({ action: 'abandon', reason: 'x' })).status).toBe(403);
    expect(mockAbandon).not.toHaveBeenCalled();
  });

  it('allows an OAuth session carrying the signed-in user', async () => {
    currentUser = null;
    apiAccountRow = { id: 'a-1', name: 'oauth', sessionUserId: 'u-9' };
    expect((await call({ action: 'abandon', reason: 'x' })).status).toBe(200);
    expect(mockAbandon.mock.calls[0][0].actor).toBe('human:u-9');
  });

  it('404s outside the caller’s workspaces and for a task with no PR', async () => {
    access = false;
    expect((await call({ action: 'abandon', reason: 'x' })).status).toBe(404);
    access = true;
    taskRow.workers = [];
    expect((await call({ action: 'abandon', reason: 'x' })).status).toBe(404);
  });

  it('passes a write refusal through', async () => {
    mockAbandon.mockResolvedValueOnce({ ok: false, error: 'merged', status: 409 });
    expect((await call({ action: 'abandon', reason: 'x' })).status).toBe(409);
  });
});
