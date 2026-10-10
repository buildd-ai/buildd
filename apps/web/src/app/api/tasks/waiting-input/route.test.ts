import { describe, it, expect, beforeEach, mock } from 'bun:test';

// Mock functions
const mockGetCurrentUser = mock(() => null as any);
const mockGetUserWorkspaceIds = mock(() => Promise.resolve([] as string[]));
const mockWorkersFindMany = mock(() => [] as any[]);
const mockTasksFindMany = mock(() => [] as any[]);

// Mock auth-helpers
mock.module('@/lib/auth-helpers', () => ({
  getCurrentUser: mockGetCurrentUser,
}));

// Mock team-access
mock.module('@/lib/team-access', () => ({
  getUserWorkspaceIds: mockGetUserWorkspaceIds,
}));

// Mock database
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findMany: mockWorkersFindMany },
      tasks: { findMany: mockTasksFindMany },
    },
  },
}));

mock.module('@buildd/core/db/schema', () => ({
  tasks: { id: 'id', status: 'status', workspaceId: 'workspaceId' },
  workers: { status: 'status', taskId: 'taskId', workspaceId: 'workspaceId' },
}));

mock.module('drizzle-orm', () => ({
  eq: (...args: any[]) => ({ type: 'eq', args }),
  inArray: (...args: any[]) => ({ type: 'inArray', args }),
}));

// Import route handler after mocks
const { GET } = await import('./route');

describe('GET /api/tasks/waiting-input', () => {
  beforeEach(() => {
    mockGetCurrentUser.mockReset();
    mockGetUserWorkspaceIds.mockReset();
    mockWorkersFindMany.mockReset();
    mockTasksFindMany.mockReset();
  });

  it('returns 401 when not authenticated', async () => {
    mockGetCurrentUser.mockReturnValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('Unauthorized');
  });

  it('returns empty tasks when user has no workspaces', async () => {
    mockGetCurrentUser.mockReturnValue({ id: 'user-1', email: 'test@test.com' });
    mockGetUserWorkspaceIds.mockResolvedValue([]);

    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tasks).toEqual([]);
  });

  it('returns empty tasks when no workers are waiting_input', async () => {
    mockGetCurrentUser.mockReturnValue({ id: 'user-1', email: 'test@test.com' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindMany.mockReturnValue([]);

    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tasks).toEqual([]);
  });

  it('returns waiting tasks with waitingFor data', async () => {
    mockGetCurrentUser.mockReturnValue({ id: 'user-1', email: 'test@test.com' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindMany.mockReturnValue([
      {
        taskId: 'task-1',
        workspaceId: 'ws-1',
        waitingFor: { type: 'question', prompt: 'Which database?', disposition: 'ask' },
      },
    ]);
    mockTasksFindMany.mockReturnValue([
      {
        id: 'task-1',
        title: 'Setup database',
        status: 'running',
        workspaceId: 'ws-1',
        missionId: 'mission-1',
      },
    ]);

    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0]).toEqual({
      id: 'task-1',
      title: 'Setup database',
      workspaceId: 'ws-1',
      missionId: 'mission-1',
      waitingFor: { type: 'question', prompt: 'Which database?', disposition: 'ask' },
      answerSent: false,
      actionUrl: 'https://buildd.dev/app/tasks/task-1/respond',
    });
  });

  // An answer on the resume path clears waitingFor but leaves the worker
  // waiting_input until the runner resumes it: the task is answered, not waiting.
  it('marks a task whose question was answered but whose worker has not resumed', async () => {
    mockGetCurrentUser.mockReturnValue({ id: 'user-1', email: 'test@test.com' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindMany.mockReturnValue([
      { taskId: 'task-1', workspaceId: 'ws-1', waitingFor: null },
    ]);
    mockTasksFindMany.mockReturnValue([
      { id: 'task-1', title: 'Setup database', status: 'running', workspaceId: 'ws-1', missionId: null },
    ]);

    const data = await (await GET()).json();
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0]).toMatchObject({ id: 'task-1', answerSent: true, waitingFor: null });
  });

  it('a task with a worker still asking is not answered, even beside an answered one', async () => {
    mockGetCurrentUser.mockReturnValue({ id: 'user-1', email: 'test@test.com' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindMany.mockReturnValue([
      { taskId: 'task-1', workspaceId: 'ws-1', waitingFor: null },
      { taskId: 'task-1', workspaceId: 'ws-1', waitingFor: { type: 'question', prompt: 'Again?', disposition: 'ask' } },
    ]);
    mockTasksFindMany.mockReturnValue([
      { id: 'task-1', title: 'Setup database', status: 'running', workspaceId: 'ws-1', missionId: null },
    ]);

    const data = await (await GET()).json();
    expect(data.tasks[0]).toMatchObject({ answerSent: false, waitingFor: { prompt: 'Again?' } });
  });

  // Needs You admission (@buildd/core/needs-you): only a park whose
  // disposition hands it to a person reaches the banner and phone Home.
  it('drops parks with no disposition, a recovered blocker, and a hold before its deadline', async () => {
    mockGetCurrentUser.mockReturnValue({ id: 'user-1', email: 'test@test.com' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    const ahead = new Date(Date.now() + 10 * 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    mockWorkersFindMany.mockReturnValue([
      { taskId: 'task-legacy', workspaceId: 'ws-1', waitingFor: { type: 'question', prompt: 'Undisposed?' } },
      { taskId: 'task-recovered', workspaceId: 'ws-1', waitingFor: { type: 'question', prompt: 'Merge conflict?', disposition: 'recovered', repairTaskId: 'r-1' } },
      { taskId: 'task-held', workspaceId: 'ws-1', waitingFor: { type: 'question', prompt: 'Later?', disposition: 'hold', resurfaceAt: ahead } },
      { taskId: 'task-due', workspaceId: 'ws-1', waitingFor: { type: 'question', prompt: 'Now?', disposition: 'hold', resurfaceAt: past } },
      { taskId: 'task-perm', workspaceId: 'ws-1', waitingFor: { type: 'permission', prompt: 'Allow Bash?', disposition: 'ask' } },
    ]);
    // Like the DB: only the tasks the admitted workers name come back.
    mockTasksFindMany.mockImplementation(((args: any) => (args.where.args[1] as string[]).map(id => (
      { id, title: id, status: 'running', workspaceId: 'ws-1', missionId: null }
    ))) as any);

    const data = await (await GET()).json();
    expect(data.tasks.map((t: any) => t.id).sort()).toEqual(['task-due', 'task-perm']);
    mockTasksFindMany.mockReset();
  });

  it('excludes completed/failed tasks', async () => {
    mockGetCurrentUser.mockReturnValue({ id: 'user-1', email: 'test@test.com' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindMany.mockReturnValue([
      {
        taskId: 'task-1',
        workspaceId: 'ws-1',
        waitingFor: { type: 'question', prompt: 'Test?', disposition: 'ask' },
      },
    ]);
    mockTasksFindMany.mockReturnValue([
      {
        id: 'task-1',
        title: 'Completed task',
        status: 'completed',
        workspaceId: 'ws-1',
      },
    ]);

    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tasks).toHaveLength(0);
  });

  it('excludes cancelled tasks with a retained waiting worker', async () => {
    mockGetCurrentUser.mockReturnValue({ id: 'user-1' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindMany.mockReturnValue([{ taskId: 'task-1', workspaceId: 'ws-1', waitingFor: { type: 'question', prompt: 'Test?', disposition: 'ask' } }]);
    mockTasksFindMany.mockReturnValue([{ id: 'task-1', title: 'Cancelled task', status: 'cancelled', workspaceId: 'ws-1' }]);
    expect((await (await GET()).json()).tasks).toEqual([]);
  });

  it('includes actionUrl pointing to respond page', async () => {
    mockGetCurrentUser.mockReturnValue({ id: 'user-1', email: 'test@test.com' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindMany.mockReturnValue([
      {
        taskId: 'task-1',
        workspaceId: 'ws-1',
        waitingFor: { type: 'question', prompt: 'Which database?', disposition: 'ask' },
      },
    ]);
    mockTasksFindMany.mockReturnValue([
      {
        id: 'task-1',
        title: 'Setup database',
        status: 'running',
        workspaceId: 'ws-1',
      },
    ]);

    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].actionUrl).toMatch(/\/app\/tasks\/task-1\/respond$/);
  });

  it('filters workers to user workspaces only', async () => {
    mockGetCurrentUser.mockReturnValue({ id: 'user-1', email: 'test@test.com' });
    mockGetUserWorkspaceIds.mockResolvedValue(['ws-1']);
    mockWorkersFindMany.mockReturnValue([
      {
        taskId: 'task-1',
        workspaceId: 'ws-1',
        waitingFor: { type: 'question', prompt: 'Yes?', disposition: 'ask' },
      },
      {
        taskId: 'task-2',
        workspaceId: 'ws-other', // Not user's workspace
        waitingFor: { type: 'question', prompt: 'No?', disposition: 'ask' },
      },
    ]);
    mockTasksFindMany.mockReturnValue([
      {
        id: 'task-1',
        title: 'My task',
        status: 'running',
        workspaceId: 'ws-1',
      },
    ]);

    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].id).toBe('task-1');
  });
});
