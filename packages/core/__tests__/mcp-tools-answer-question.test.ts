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

describe('answer_question', () => {
  let mockApi: ReturnType<typeof mock>;

  beforeEach(() => {
    mockApi = mock();
  });

  it('requires admin level', async () => {
    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'answer_question',
      { taskId: TASK_ID, message: 'B' },
      ctx({ getLevel: async () => 'worker' }),
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe('forbidden');
    expect(mockApi).not.toHaveBeenCalled();
  });

  it('posts the answer to the respond route of the worker that holds the question', async () => {
    mockApi
      .mockResolvedValueOnce({
        id: TASK_ID,
        status: 'assigned',
        workers: [
          { id: 'old', status: 'superseded', waitingFor: null, createdAt: '2026-01-01T00:00:00Z' },
          { id: WORKER_ID, status: 'waiting_input', waitingFor: { type: 'question', prompt: 'A or B?' }, createdAt: '2026-01-02T00:00:00Z' },
        ],
      })
      .mockResolvedValueOnce({ path: 'resume', taskId: TASK_ID, message: 'Resuming.' });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'answer_question',
      { taskId: TASK_ID, message: 'B' },
      ctx(),
    );

    const [endpoint, init] = mockApi.mock.calls[1];
    expect(endpoint).toBe(`/api/workers/${WORKER_ID}/respond`);
    expect(JSON.parse(init.body)).toEqual({ message: 'B' });
    expect(result.content[0].text).toContain(WORKER_ID);
  });

  it('refuses when no worker is waiting on a question', async () => {
    mockApi.mockResolvedValueOnce({
      id: TASK_ID,
      status: 'assigned',
      workers: [{ id: WORKER_ID, status: 'running', waitingFor: null }],
    });
    await expect(
      handleBuilddAction(mockApi as unknown as ApiFn, 'answer_question', { taskId: TASK_ID, message: 'B' }, ctx()),
    ).rejects.toThrow('no agent waiting on a question');
    expect(mockApi).toHaveBeenCalledTimes(1);
  });

  it('send_agent_message to a worker parked on a question points at answer_question', async () => {
    mockApi.mockResolvedValueOnce({
      id: TASK_ID,
      status: 'assigned',
      workers: [{ id: WORKER_ID, status: 'waiting_input', waitingFor: { type: 'question', prompt: 'A or B?' } }],
    });
    await expect(
      handleBuilddAction(mockApi as unknown as ApiFn, 'send_agent_message', { taskId: TASK_ID, message: 'B', priority: 'urgent' }, ctx()),
    ).rejects.toThrow('answer_question');
    expect(mockApi).toHaveBeenCalledTimes(1);
  });
});
