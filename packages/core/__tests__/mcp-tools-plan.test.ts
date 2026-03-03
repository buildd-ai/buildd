import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { handleBuilddAction, type ApiFn, type ActionContext } from '../mcp-tools';

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
      { taskId: 'plan-123' },
      createMockContext(),
    );

    expect(mockApi).toHaveBeenCalledTimes(1);
    expect(mockApi).toHaveBeenCalledWith('/api/tasks/plan-123/approve-plan', {
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

    await expect(
      handleBuilddAction(mockApi as unknown as ApiFn, 'approve_plan', { taskId: 'plan-123' }, ctx),
    ).rejects.toThrow('This operation requires an admin-level token');

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
      { taskId: 'plan-123' },
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
      { taskId: 'plan-123', feedback: 'Need more detail on step 2' },
      createMockContext(),
    );

    expect(mockApi).toHaveBeenCalledTimes(1);
    expect(mockApi).toHaveBeenCalledWith('/api/tasks/plan-123/reject-plan', {
      method: 'POST',
      body: JSON.stringify({ feedback: 'Need more detail on step 2' }),
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Plan rejected');
    expect(result.content[0].text).toContain('revised-task-456');
  });

  it('requires admin level', async () => {
    const ctx = createMockContext({ getLevel: async () => 'worker' });

    await expect(
      handleBuilddAction(
        mockApi as unknown as ApiFn,
        'reject_plan',
        { taskId: 'plan-123', feedback: 'Bad plan' },
        ctx,
      ),
    ).rejects.toThrow('This operation requires an admin-level token');

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
        { taskId: 'plan-123' },
        createMockContext(),
      ),
    ).rejects.toThrow('feedback is required');

    expect(mockApi).not.toHaveBeenCalled();
  });
});
