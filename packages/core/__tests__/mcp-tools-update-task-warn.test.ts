import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { handleBuilddAction, type ApiFn, type ActionContext } from '../mcp-tools';

const MOCK_WS_ID = '00000000-0000-0000-0000-000000000001';
const TASK_ID = '11111111-1111-1111-1111-111111111111';

const ctx: ActionContext = {
  workspaceId: MOCK_WS_ID,
  getWorkspaceId: async () => MOCK_WS_ID,
  getLevel: async () => 'admin',
};

const UPDATED_TASK = {
  id: TASK_ID,
  title: 'My Task',
  status: 'running',
  priority: 5,
  missionId: null,
};

const TASK_WITH_RUNNING_WORKER = {
  ...UPDATED_TASK,
  workers: [{ id: 'worker-abc', status: 'running' }],
};

const TASK_WITH_WAITING_WORKER = {
  ...UPDATED_TASK,
  workers: [{ id: 'worker-xyz', status: 'waiting_input' }],
};

const TASK_WITH_ASSIGNED_WORKER = {
  ...UPDATED_TASK,
  workers: [{ id: 'worker-def', status: 'assigned' }],
};

const TASK_WITH_NO_WORKERS = {
  ...UPDATED_TASK,
  workers: [],
};

const TASK_WITH_TERMINAL_WORKERS = {
  ...UPDATED_TASK,
  workers: [
    { id: 'worker-old', status: 'completed' },
    { id: 'worker-err', status: 'failed' },
  ],
};

describe('update_task — active-worker warning on material edits', () => {
  let mockApi: ReturnType<typeof mock>;

  beforeEach(() => {
    mockApi = mock();
  });

  it('warns when description is changed and worker is running', async () => {
    mockApi
      .mockResolvedValueOnce(UPDATED_TASK)             // PATCH
      .mockResolvedValueOnce(TASK_WITH_RUNNING_WORKER) // GET ?include=workers
      .mockResolvedValue({ id: 'note-1' });             // POST note (fire-and-forget)

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'update_task',
      { taskId: TASK_ID, description: 'New description' },
      ctx,
    );

    const text = result.content[0].text;
    expect(text).toContain('WARNING');
    expect(text).toContain('worker-abc');
    expect(text).toContain('running');
    expect(text).toContain('PREVIOUS');
    expect(text).toContain('send_agent_message');
    expect(text).toContain(`taskId=${TASK_ID}`);
  });

  it('warns when title is changed and worker is waiting_input', async () => {
    mockApi
      .mockResolvedValueOnce(UPDATED_TASK)
      .mockResolvedValueOnce(TASK_WITH_WAITING_WORKER)
      .mockResolvedValue({ id: 'note-1' });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'update_task',
      { taskId: TASK_ID, title: 'New Title' },
      ctx,
    );

    const text = result.content[0].text;
    expect(text).toContain('WARNING');
    expect(text).toContain('worker-xyz');
    expect(text).toContain('waiting_input');
    expect(text).toContain('send_agent_message');
  });

  it('warns when worker is in assigned state', async () => {
    mockApi
      .mockResolvedValueOnce(UPDATED_TASK)
      .mockResolvedValueOnce(TASK_WITH_ASSIGNED_WORKER)
      .mockResolvedValue({ id: 'note-1' });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'update_task',
      { taskId: TASK_ID, description: 'Changed' },
      ctx,
    );

    const text = result.content[0].text;
    expect(text).toContain('WARNING');
    expect(text).toContain('worker-def');
    expect(text).toContain('assigned');
  });

  it('does not warn when only priority is changed (non-material)', async () => {
    mockApi.mockResolvedValue(UPDATED_TASK); // only the PATCH call

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'update_task',
      { taskId: TASK_ID, priority: 8 },
      ctx,
    );

    const text = result.content[0].text;
    expect(text).not.toContain('WARNING');
    // Should only make 1 API call (the PATCH) — no worker fetch
    expect(mockApi.mock.calls.length).toBe(1);
  });

  it('does not warn when only status is changed (non-material)', async () => {
    mockApi.mockResolvedValue(UPDATED_TASK);

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'update_task',
      { taskId: TASK_ID, status: 'pending' },
      ctx,
    );

    expect(result.content[0].text).not.toContain('WARNING');
    expect(mockApi.mock.calls.length).toBe(1);
  });

  it('does not warn when only project is changed (non-material)', async () => {
    mockApi.mockResolvedValue(UPDATED_TASK);

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'update_task',
      { taskId: TASK_ID, project: 'apps/web' },
      ctx,
    );

    expect(result.content[0].text).not.toContain('WARNING');
    expect(mockApi.mock.calls.length).toBe(1);
  });

  it('does not warn when no active workers exist', async () => {
    mockApi
      .mockResolvedValueOnce(UPDATED_TASK)
      .mockResolvedValueOnce(TASK_WITH_NO_WORKERS);

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'update_task',
      { taskId: TASK_ID, description: 'Changed' },
      ctx,
    );

    expect(result.content[0].text).not.toContain('WARNING');
  });

  it('does not warn when only terminal workers exist', async () => {
    mockApi
      .mockResolvedValueOnce(UPDATED_TASK)
      .mockResolvedValueOnce(TASK_WITH_TERMINAL_WORKERS);

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'update_task',
      { taskId: TASK_ID, description: 'Changed' },
      ctx,
    );

    expect(result.content[0].text).not.toContain('WARNING');
  });

  it('posts warning note to task feed when material edit hits active worker', async () => {
    mockApi
      .mockResolvedValueOnce(UPDATED_TASK)
      .mockResolvedValueOnce(TASK_WITH_RUNNING_WORKER)
      .mockResolvedValue({ id: 'note-1' });

    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'update_task',
      { taskId: TASK_ID, description: 'New description' },
      ctx,
    );

    // Third call should be the note POST
    const noteCalls = mockApi.mock.calls.filter(
      ([endpoint, opts]) => endpoint === `/api/tasks/${TASK_ID}/notes` && opts?.method === 'POST',
    );
    expect(noteCalls.length).toBe(1);
    const noteBody = JSON.parse(noteCalls[0][1].body);
    expect(noteBody.type).toBe('warning');
  });

  it('posts warning note to mission feed when task has missionId', async () => {
    const updatedWithMission = { ...UPDATED_TASK, missionId: 'mission-42' };
    mockApi
      .mockResolvedValueOnce(updatedWithMission)
      .mockResolvedValueOnce({ ...TASK_WITH_RUNNING_WORKER, missionId: 'mission-42' })
      .mockResolvedValue({ id: 'note-1' });

    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'update_task',
      { taskId: TASK_ID, description: 'New description' },
      ctx,
    );

    const missionNoteCalls = mockApi.mock.calls.filter(
      ([endpoint, opts]) => endpoint === '/api/missions/mission-42/notes' && opts?.method === 'POST',
    );
    expect(missionNoteCalls.length).toBe(1);
  });

  it('still succeeds even if note POST fails', async () => {
    mockApi
      .mockResolvedValueOnce(UPDATED_TASK)
      .mockResolvedValueOnce(TASK_WITH_RUNNING_WORKER)
      .mockRejectedValueOnce(new Error('Note service down'));

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'update_task',
      { taskId: TASK_ID, description: 'Changed' },
      ctx,
    );

    // Should still return the warning text even if note posting failed
    expect(result.content[0].text).toContain('WARNING');
  });
});

describe('create_task — status line reflects actual task state', () => {
  it('shows Queued when status is pending', async () => {
    const api = async (_path: string, _opts?: RequestInit) =>
      ({ id: 'task-new', title: 'Test', priority: 5, status: 'pending' });

    const result = await handleBuilddAction(
      api as ApiFn,
      'create_task',
      { title: 'Test', description: 'Desc' },
      ctx,
    );

    expect(result.content[0].text).toContain('Queued');
    expect(result.content[0].text).not.toContain('Assigned');
  });

  it('shows Assigned when status is assigned', async () => {
    const api = async (_path: string, _opts?: RequestInit) =>
      ({ id: 'task-new', title: 'Test', priority: 5, status: 'assigned' });

    const result = await handleBuilddAction(
      api as ApiFn,
      'create_task',
      { title: 'Test', description: 'Desc' },
      ctx,
    );

    expect(result.content[0].text).toContain('Assigned');
    expect(result.content[0].text).not.toContain('Queued');
  });

  it('still shows Deferred when startAt is set, regardless of status', async () => {
    const api = async (_path: string, _opts?: RequestInit) =>
      ({
        id: 'task-new',
        title: 'Later',
        priority: 0,
        status: 'pending',
        startAt: '2027-01-01T00:00:00.000Z',
        context: { startResolution: 'relative' },
      });

    const result = await handleBuilddAction(
      api as ApiFn,
      'create_task',
      { title: 'Later', description: 'Wait', startIn: '3h' },
      ctx,
    );

    expect(result.content[0].text).toContain('Deferred');
    expect(result.content[0].text).not.toContain('Queued');
    expect(result.content[0].text).not.toContain('Assigned');
  });
});
