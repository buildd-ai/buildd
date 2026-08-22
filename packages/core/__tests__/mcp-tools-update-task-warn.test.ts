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

describe('update_task — auto-delivery on description changes', () => {
  let mockApi: ReturnType<typeof mock>;

  beforeEach(() => {
    mockApi = mock();
  });

  it('auto-delivers to worker when description is changed and worker is running', async () => {
    mockApi
      .mockResolvedValueOnce(UPDATED_TASK)              // PATCH
      .mockResolvedValueOnce(TASK_WITH_RUNNING_WORKER)  // GET ?include=workers
      .mockResolvedValueOnce({ ok: true, message: 'sent' }) // POST instruct
      .mockResolvedValue({ id: 'note-1' });               // POST note (fire-and-forget)

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'update_task',
      { taskId: TASK_ID, description: 'New description' },
      ctx,
    );

    const responseText = result.content[0].text;
    // Should NOT show the "WARNING" fallback
    expect(responseText).not.toContain('WARNING');
    // Should confirm delivery
    expect(responseText).toContain('worker-abc');
    expect(responseText).toContain('auto-deliver');

    // Should have called the instruct endpoint
    const instructCalls = mockApi.mock.calls.filter(
      ([endpoint, opts]: [string, RequestInit]) =>
        endpoint.includes('/api/workers/worker-abc/instruct') && opts?.method === 'POST',
    );
    expect(instructCalls.length).toBe(1);
    const instructBody = JSON.parse(instructCalls[0][1].body as string);
    // Message should include the new description text
    expect(instructBody.message).toContain('New description');
    // Should be urgent
    expect(instructBody.priority).toBe('urgent');
  });

  it('auto-delivers when worker is in waiting_input state', async () => {
    mockApi
      .mockResolvedValueOnce(UPDATED_TASK)
      .mockResolvedValueOnce(TASK_WITH_WAITING_WORKER)
      .mockResolvedValueOnce({ ok: true, message: 'sent' })
      .mockResolvedValue({ id: 'note-1' });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'update_task',
      { taskId: TASK_ID, description: 'Changed' },
      ctx,
    );

    const responseText = result.content[0].text;
    expect(responseText).not.toContain('WARNING');
    expect(responseText).toContain('worker-xyz');

    const instructCalls = mockApi.mock.calls.filter(
      ([endpoint]: [string]) => endpoint.includes('/api/workers/worker-xyz/instruct'),
    );
    expect(instructCalls.length).toBe(1);
  });

  it('auto-delivers when worker is in assigned state', async () => {
    mockApi
      .mockResolvedValueOnce(UPDATED_TASK)
      .mockResolvedValueOnce(TASK_WITH_ASSIGNED_WORKER)
      .mockResolvedValueOnce({ ok: true, message: 'sent' })
      .mockResolvedValue({ id: 'note-1' });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'update_task',
      { taskId: TASK_ID, description: 'Changed' },
      ctx,
    );

    const responseText = result.content[0].text;
    expect(responseText).not.toContain('WARNING');

    const instructCalls = mockApi.mock.calls.filter(
      ([endpoint]: [string]) => endpoint.includes('/api/workers/worker-def/instruct'),
    );
    expect(instructCalls.length).toBe(1);
  });

  it('falls back to ready-to-send payload when auto-delivery fails', async () => {
    mockApi
      .mockResolvedValueOnce(UPDATED_TASK)              // PATCH
      .mockResolvedValueOnce(TASK_WITH_RUNNING_WORKER)  // GET ?include=workers
      .mockRejectedValueOnce(new Error('Pusher down'))  // POST instruct (fails)
      .mockResolvedValue({ id: 'note-1' });              // POST note

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'update_task',
      { taskId: TASK_ID, description: 'New description' },
      ctx,
    );

    const responseText = result.content[0].text;
    // Fallback to Option A: warning + ready-to-send payload
    expect(responseText).toContain('WARNING');
    expect(responseText).toContain('worker-abc');
    expect(responseText).toContain('send_agent_message');
  });

  it('does NOT deliver or warn when only title is changed (title is not injected into running agents)', async () => {
    mockApi.mockResolvedValue(UPDATED_TASK); // only the PATCH call

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'update_task',
      { taskId: TASK_ID, title: 'New Title' },
      ctx,
    );

    const responseText = result.content[0].text;
    expect(responseText).not.toContain('WARNING');
    // Should only make 1 API call (the PATCH) — no worker fetch, no instruct
    expect(mockApi.mock.calls.length).toBe(1);
  });

  it('does not deliver when only priority is changed (non-material)', async () => {
    mockApi.mockResolvedValue(UPDATED_TASK);

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'update_task',
      { taskId: TASK_ID, priority: 8 },
      ctx,
    );

    const responseText = result.content[0].text;
    expect(responseText).not.toContain('WARNING');
    expect(mockApi.mock.calls.length).toBe(1);
  });

  it('does not deliver when only status is changed (non-material)', async () => {
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

  it('does not deliver when only project is changed (non-material)', async () => {
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

  it('does not deliver when no active workers exist', async () => {
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
    // Should NOT call instruct endpoint
    const instructCalls = mockApi.mock.calls.filter(
      ([endpoint]: [string]) => endpoint.includes('/instruct'),
    );
    expect(instructCalls.length).toBe(0);
  });

  it('does not deliver when only terminal workers exist', async () => {
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
    const instructCalls = mockApi.mock.calls.filter(
      ([endpoint]: [string]) => endpoint.includes('/instruct'),
    );
    expect(instructCalls.length).toBe(0);
  });

  it('posts success note to task feed after auto-delivering', async () => {
    mockApi
      .mockResolvedValueOnce(UPDATED_TASK)
      .mockResolvedValueOnce(TASK_WITH_RUNNING_WORKER)
      .mockResolvedValueOnce({ ok: true, message: 'sent' })
      .mockResolvedValue({ id: 'note-1' });

    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'update_task',
      { taskId: TASK_ID, description: 'New description' },
      ctx,
    );

    const noteCalls = mockApi.mock.calls.filter(
      ([endpoint, opts]: [string, RequestInit]) =>
        endpoint === `/api/tasks/${TASK_ID}/notes` && opts?.method === 'POST',
    );
    expect(noteCalls.length).toBe(1);
    const noteBody = JSON.parse(noteCalls[0][1].body as string);
    // Success note should not be a warning
    expect(noteBody.type).not.toBe('warning');
  });

  it('posts success note to mission feed when task has missionId', async () => {
    const updatedWithMission = { ...UPDATED_TASK, missionId: 'mission-42' };
    mockApi
      .mockResolvedValueOnce(updatedWithMission)
      .mockResolvedValueOnce({ ...TASK_WITH_RUNNING_WORKER, missionId: 'mission-42' })
      .mockResolvedValueOnce({ ok: true, message: 'sent' })
      .mockResolvedValue({ id: 'note-1' });

    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'update_task',
      { taskId: TASK_ID, description: 'New description' },
      ctx,
    );

    const missionNoteCalls = mockApi.mock.calls.filter(
      ([endpoint, opts]: [string, RequestInit]) =>
        endpoint === '/api/missions/mission-42/notes' && opts?.method === 'POST',
    );
    expect(missionNoteCalls.length).toBe(1);
  });

  it('still succeeds even if note POST fails after auto-delivery', async () => {
    mockApi
      .mockResolvedValueOnce(UPDATED_TASK)
      .mockResolvedValueOnce(TASK_WITH_RUNNING_WORKER)
      .mockResolvedValueOnce({ ok: true, message: 'sent' })
      .mockRejectedValueOnce(new Error('Note service down'));

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'update_task',
      { taskId: TASK_ID, description: 'Changed' },
      ctx,
    );

    // Auto-delivery succeeded, result should be positive
    expect(result.content[0].text).not.toContain('WARNING');
    expect(result.content[0].text).toContain('worker-abc');
  });

  it('title-only update succeeds without worker check', async () => {
    mockApi.mockResolvedValueOnce(UPDATED_TASK);

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'update_task',
      { taskId: TASK_ID, title: 'Updated Title' },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Task updated');
    // Only the PATCH call
    expect(mockApi.mock.calls.length).toBe(1);
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
