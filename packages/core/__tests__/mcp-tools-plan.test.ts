import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { handleBuilddAction, type ApiFn, type ActionContext } from '../mcp-tools';

const PLAN_TASK_ID = '22222222-2222-2222-2222-222222222222';

function createMockContext(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workspaceId: 'ws-1',
    getWorkspaceId: async () => 'ws-1',
    getLevel: async () => 'admin',
    ...overrides,
  };
}

describe('approve_plan', () => {
  let mockApi: ReturnType<typeof mock>;

  beforeEach(() => {
    mockApi = mock();
  });

  it('calls approve-plan API and returns created task IDs', async () => {
    mockApi.mockResolvedValue({ tasks: ['task-1', 'task-2', 'task-3'] });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'approve_plan',
      { taskId: PLAN_TASK_ID },
      createMockContext(),
    );

    expect(mockApi).toHaveBeenCalledTimes(1);
    expect(mockApi).toHaveBeenCalledWith(`/api/tasks/${PLAN_TASK_ID}/approve-plan`, {
      method: 'POST',
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Plan approved');
    expect(result.content[0].text).toContain('3 child task(s)');
    expect(result.content[0].text).toContain('task-1');
    expect(result.content[0].text).toContain('task-2');
    expect(result.content[0].text).toContain('task-3');
  });

  it('requires admin level', async () => {
    const ctx = createMockContext({ getLevel: async () => 'worker' });
    const result = await handleBuilddAction(mockApi as unknown as ApiFn, 'approve_plan', { taskId: PLAN_TASK_ID }, ctx);
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('forbidden');
    expect(body.requiredLevel).toBe('admin');
    expect(mockApi).not.toHaveBeenCalled();
  });

  it('requires taskId param', async () => {
    await expect(
      handleBuilddAction(mockApi as unknown as ApiFn, 'approve_plan', {}, createMockContext()),
    ).rejects.toThrow('taskId is required');

    expect(mockApi).not.toHaveBeenCalled();
  });

  it('handles empty tasks array', async () => {
    mockApi.mockResolvedValue({ tasks: [] });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'approve_plan',
      { taskId: PLAN_TASK_ID },
      createMockContext(),
    );

    expect(result.content[0].text).toContain('0 child task(s)');
  });
});

describe('reject_plan', () => {
  let mockApi: ReturnType<typeof mock>;

  beforeEach(() => {
    mockApi = mock();
  });

  it('calls reject-plan API with feedback and returns new task ID', async () => {
    mockApi.mockResolvedValue({ taskId: 'revised-task-456' });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'reject_plan',
      { taskId: PLAN_TASK_ID, feedback: 'Need more detail on step 2' },
      createMockContext(),
    );

    expect(mockApi).toHaveBeenCalledTimes(1);
    expect(mockApi).toHaveBeenCalledWith(`/api/tasks/${PLAN_TASK_ID}/reject-plan`, {
      method: 'POST',
      body: JSON.stringify({ feedback: 'Need more detail on step 2' }),
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Plan rejected');
    expect(result.content[0].text).toContain('revised-task-456');
  });

  it('requires admin level', async () => {
    const ctx = createMockContext({ getLevel: async () => 'worker' });
    const result = await handleBuilddAction(mockApi as unknown as ApiFn, 'reject_plan', { taskId: PLAN_TASK_ID, feedback: 'Bad plan' }, ctx);
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toBe('forbidden');
    expect(body.requiredLevel).toBe('admin');
    expect(mockApi).not.toHaveBeenCalled();
  });

  it('requires taskId param', async () => {
    await expect(
      handleBuilddAction(
        mockApi as unknown as ApiFn,
        'reject_plan',
        { feedback: 'Bad plan' },
        createMockContext(),
      ),
    ).rejects.toThrow('taskId is required');

    expect(mockApi).not.toHaveBeenCalled();
  });

  it('requires feedback param', async () => {
    await expect(
      handleBuilddAction(
        mockApi as unknown as ApiFn,
        'reject_plan',
        { taskId: PLAN_TASK_ID },
        createMockContext(),
      ),
    ).rejects.toThrow('feedback is required');

    expect(mockApi).not.toHaveBeenCalled();
  });
});
