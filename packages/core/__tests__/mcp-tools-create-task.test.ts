import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { handleBuilddAction, type ApiFn, type ActionContext } from '../mcp-tools';

const MOCK_WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';

function createMockContext(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workspaceId: MOCK_WORKSPACE_ID,
    getWorkspaceId: async () => MOCK_WORKSPACE_ID,
    getLevel: async () => 'worker',
    ...overrides,
  };
}

describe('create_task — parentTaskId support', () => {
  let mockApi: ReturnType<typeof mock>;

  beforeEach(() => {
    mockApi = mock();
    mockApi.mockResolvedValue({ id: 'task-new', title: 'Test Task', priority: 5 });
  });

  it('passes parentTaskId to API when provided', async () => {
    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_task',
      {
        title: 'Retry: fix tests',
        description: 'Retry of previous attempt',
        parentTaskId: 'task-original-123',
      },
      createMockContext(),
    );

    expect(mockApi).toHaveBeenCalledTimes(1);
    const [endpoint, opts] = mockApi.mock.calls[0];
    expect(endpoint).toBe('/api/tasks');
    const body = JSON.parse(opts.body);
    expect(body.parentTaskId).toBe('task-original-123');
  });

  it('does not include parentTaskId when not provided', async () => {
    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_task',
      {
        title: 'Normal task',
        description: 'No parent',
      },
      createMockContext(),
    );

    const body = JSON.parse(mockApi.mock.calls[0][1].body);
    expect(body.parentTaskId).toBeUndefined();
  });

  it('passes baseBranch in context when provided', async () => {
    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_task',
      {
        title: 'Retry: fix tests',
        description: 'Continue from previous branch',
        parentTaskId: 'task-original-123',
        baseBranch: 'buildd/abc12345-fix-tests',
      },
      createMockContext(),
    );

    const body = JSON.parse(mockApi.mock.calls[0][1].body);
    expect(body.parentTaskId).toBe('task-original-123');
    expect(body.context.baseBranch).toBe('buildd/abc12345-fix-tests');
  });

  it('passes verificationCommand in context when provided', async () => {
    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_task',
      {
        title: 'Task with verification',
        description: 'Will be verified',
        verificationCommand: 'bun test && bun run build',
      },
      createMockContext(),
    );

    const body = JSON.parse(mockApi.mock.calls[0][1].body);
    expect(body.context.verificationCommand).toBe('bun test && bun run build');
  });

  it('passes iteration metadata in context when provided', async () => {
    await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_task',
      {
        title: 'Retry attempt 3',
        description: 'Third attempt',
        parentTaskId: 'task-original',
        baseBranch: 'buildd/abc-fix',
        iteration: 3,
        maxIterations: 5,
        failureContext: 'Tests failed: 2 assertions in worker.test.ts',
      },
      createMockContext(),
    );

    const body = JSON.parse(mockApi.mock.calls[0][1].body);
    expect(body.parentTaskId).toBe('task-original');
    expect(body.context.baseBranch).toBe('buildd/abc-fix');
    expect(body.context.iteration).toBe(3);
    expect(body.context.maxIterations).toBe(5);
    expect(body.context.failureContext).toBe('Tests failed: 2 assertions in worker.test.ts');
  });

  it('mentions parentTaskId in response when set', async () => {
    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'create_task',
      {
        title: 'Retry task',
        description: 'retry',
        parentTaskId: 'task-parent',
      },
      createMockContext(),
    );

    expect(result.content[0].text).toContain('Parent: task-parent');
  });
});
