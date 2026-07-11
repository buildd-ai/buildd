import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { handleBuilddAction, type ApiFn, type ActionContext } from '../mcp-tools';

const WS_ID = '00000000-0000-0000-0000-000000000001';
const TASK_ID = '11111111-1111-1111-1111-111111111111';
const WORKER_ID = '22222222-2222-2222-2222-222222222222';

function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workspaceId: WS_ID,
    getWorkspaceId: async () => WS_ID,
    getLevel: async () => 'admin',
    ...overrides,
  };
}

describe('send_agent_message', () => {
  let mockApi: ReturnType<typeof mock>;

  beforeEach(() => {
    mockApi = mock();
  });

  it('requires admin level', async () => {
    await expect(
      handleBuilddAction(
        mockApi as unknown as ApiFn,
        'send_agent_message',
        { taskId: TASK_ID, message: 'hello' },
        ctx({ getLevel: async () => 'worker' }),
      ),
    ).rejects.toThrow('admin-level token');
  });

  it('requires taskId and message', async () => {
    await expect(
      handleBuilddAction(
        mockApi as unknown as ApiFn,
        'send_agent_message',
        { taskId: TASK_ID },
        ctx(),
      ),
    ).rejects.toThrow('taskId and message are required');
  });

  // Key regression test: task.status stays 'assigned' while a worker is live.
  // send_agent_message must use worker.status, not task.status, to decide liveness.
  it('succeeds when task.status is "assigned" but worker.status is "idle"', async () => {
    mockApi
      .mockResolvedValueOnce({
        id: TASK_ID,
        status: 'assigned',
        workers: [{ id: WORKER_ID, status: 'idle', branch: 'buildd/abc-fix' }],
      })
      .mockResolvedValueOnce({ ok: true, message: 'queued' });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'send_agent_message',
      { taskId: TASK_ID, message: 'Please focus on the auth module.' },
      ctx(),
    );

    // Should have called the task endpoint with include=workers
    const [taskEndpoint] = mockApi.mock.calls[0];
    expect(taskEndpoint).toContain('include=workers');

    // Should have called the instruct endpoint
    const [instructEndpoint] = mockApi.mock.calls[1];
    expect(instructEndpoint).toContain(`/api/workers/${WORKER_ID}/instruct`);

    expect(result.content[0].text).toContain(WORKER_ID);
  });

  it('succeeds when worker.status is "running"', async () => {
    mockApi
      .mockResolvedValueOnce({
        id: TASK_ID,
        status: 'assigned',
        workers: [{ id: WORKER_ID, status: 'running', branch: 'buildd/abc-fix' }],
      })
      .mockResolvedValueOnce({ ok: true, message: 'queued' });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'send_agent_message',
      { taskId: TASK_ID, message: 'Stop and write tests first.' },
      ctx(),
    );

    const [instructEndpoint] = mockApi.mock.calls[1];
    expect(instructEndpoint).toContain(`/api/workers/${WORKER_ID}/instruct`);
    expect(result.content[0].text).toContain(WORKER_ID);
  });

  it('succeeds when worker.status is "waiting_input"', async () => {
    mockApi
      .mockResolvedValueOnce({
        id: TASK_ID,
        status: 'assigned',
        workers: [{ id: WORKER_ID, status: 'waiting_input', branch: 'buildd/abc-fix' }],
      })
      .mockResolvedValueOnce({ ok: true, message: 'queued' });

    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'send_agent_message',
      { taskId: TASK_ID, message: 'Use option B.' },
      ctx(),
    );

    const [instructEndpoint] = mockApi.mock.calls[1];
    expect(instructEndpoint).toContain(`/api/workers/${WORKER_ID}/instruct`);
  });

  it('passes message body and priority to the instruct endpoint', async () => {
    mockApi
      .mockResolvedValueOnce({
        id: TASK_ID,
        status: 'assigned',
        workers: [{ id: WORKER_ID, status: 'idle' }],
      })
      .mockResolvedValueOnce({ ok: true, message: 'sent instantly' });

    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'send_agent_message',
      { taskId: TASK_ID, message: 'Urgent redirect!', priority: 'urgent' },
      ctx(),
    );

    const [, opts] = mockApi.mock.calls[1];
    const body = JSON.parse(opts.body);
    expect(body.message).toBe('Urgent redirect!');
    expect(body.priority).toBe('urgent');
  });

  it('throws with "pending" hint when task has no workers', async () => {
    mockApi.mockResolvedValueOnce({
      id: TASK_ID,
      status: 'pending',
      workers: [],
    });

    await expect(
      handleBuilddAction(
        mockApi as unknown as ApiFn,
        'send_agent_message',
        { taskId: TASK_ID, message: 'hello' },
        ctx(),
      ),
    ).rejects.toThrow(/pending/i);
  });

  it('throws with "no active worker" hint when all workers are terminal', async () => {
    mockApi.mockResolvedValueOnce({
      id: TASK_ID,
      status: 'completed',
      workers: [
        { id: WORKER_ID, status: 'completed' },
        { id: 'other-worker', status: 'failed' },
      ],
    });

    await expect(
      handleBuilddAction(
        mockApi as unknown as ApiFn,
        'send_agent_message',
        { taskId: TASK_ID, message: 'hello' },
        ctx(),
      ),
    ).rejects.toThrow(/no active worker/i);
  });

  it('picks the first (latest) non-terminal worker when multiple workers exist', async () => {
    const NEW_WORKER_ID = '33333333-3333-3333-3333-333333333333';
    mockApi
      .mockResolvedValueOnce({
        id: TASK_ID,
        status: 'assigned',
        workers: [
          // Latest worker (non-terminal) should be picked
          { id: NEW_WORKER_ID, status: 'running' },
          // Older worker (terminal) should be skipped
          { id: WORKER_ID, status: 'failed' },
        ],
      })
      .mockResolvedValueOnce({ ok: true, message: 'queued' });

    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'send_agent_message',
      { taskId: TASK_ID, message: 'Keep going.' },
      ctx(),
    );

    const [instructEndpoint] = mockApi.mock.calls[1];
    expect(instructEndpoint).toContain(NEW_WORKER_ID);
    expect(instructEndpoint).not.toContain(WORKER_ID);
  });
});
