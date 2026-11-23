import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockAuth = mock(async (..._a: unknown[]): Promise<any> => ({ id: 'acct-1' }));
const mockUser = mock(async (): Promise<any> => null);
const mockReach = mock(async (..._a: unknown[]): Promise<string[]> => ['ws-1']);
const mockPrs = mock(async (_ids: string[]) => new Map<string, { prUrl: string }>());
let taskRows: any[] = [];
let workerRows: any[] = [];
let taskWhere: unknown = null;
let call = 0;

mock.module('@/lib/task-token-auth', () => ({
  authenticateTaskScopedCaller: mockAuth,
  taskScopeAllowsWorkspace: () => true,
}));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: mockUser }));
mock.module('@/lib/workspace-access', () => ({ listReachableWorkspaceIds: mockReach }));
mock.module('@/lib/workflow/task-pr', () => ({ taskPrsFor: mockPrs }));
mock.module('@buildd/core/db', () => ({
  db: {
    select: () => {
      const n = call++;
      const chain: any = {
        from: () => chain,
        where: (w: unknown) => { if (n % 2 === 0) taskWhere = w; return chain; },
        orderBy: () => (n % 2 === 0 ? { limit: async () => taskRows } : Promise.resolve(workerRows)),
      };
      return chain;
    },
  },
}));

const { GET } = await import('./route');
const req = (q: string) => new NextRequest(`http://localhost/api/tasks/thread-events${q}`, { headers: { authorization: 'Bearer bld_x' } });

beforeEach(() => {
  call = 0; taskRows = []; workerRows = []; taskWhere = null;
  mockAuth.mockResolvedValue({ id: 'acct-1' });
  mockUser.mockResolvedValue(null);
  mockReach.mockResolvedValue(['ws-1']);
  mockPrs.mockResolvedValue(new Map());
});

describe('GET /api/tasks/thread-events', () => {
  it('401 when unauthenticated', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await GET(req('?threadId=t'))).status).toBe(401);
  });
  it('400 for a missing or oversized threadId', async () => {
    expect((await GET(req(''))).status).toBe(400);
    expect((await GET(req(`?threadId=${'x'.repeat(129)}`))).status).toBe(400);
  });
  it('empty when the caller reaches no workspaces', async () => {
    mockReach.mockResolvedValue([]);
    const res = await GET(req('?threadId=t'));
    expect(await res.json()).toEqual({ events: [] });
    expect(taskWhere).toBeNull();
  });
  it('scopes the task query to reachable workspaces', async () => {
    await GET(req('?threadId=t'));
    expect(mockReach).toHaveBeenCalled();
    expect(taskWhere).not.toBeNull();
  });
  it('fans out events from task and worker state', async () => {
    taskRows = [
      { id: 'a', title: 'Waiting', status: 'in_progress' },
      { id: 'b', title: 'Opened', status: 'in_progress' },
      { id: 'c', title: 'Done', status: 'completed' },
      { id: 'd', title: 'Broke', status: 'failed' },
    ];
    workerRows = [
      { taskId: 'a', status: 'waiting_input' },
      { taskId: 'b', status: 'running' },
      { taskId: 'c', status: 'done' },
      { taskId: 'd', status: 'error' },
    ];
    mockPrs.mockResolvedValue(new Map([['b', { prUrl: 'https://github.com/o/r/pull/1' }], ['c', { prUrl: 'https://github.com/o/r/pull/2' }]]));
    const { events } = await (await GET(req('?threadId=t'))).json();
    const keys = events.map((e: any) => e.key);
    expect(keys).toEqual(['a:started', 'a:waiting_input', 'b:started', 'b:pr_opened', 'c:started', 'c:pr_opened', 'c:completed', 'd:started', 'd:failed']);
    expect(events.find((e: any) => e.key === 'b:pr_opened').text).toContain('pull/1');
  });
});
