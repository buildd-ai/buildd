import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { handleBuilddAction, type ActionContext, type ApiFn } from '../mcp-tools';

const WORKER_ID = 'worker-progress-1';

function makeContext(): ActionContext {
  return {
    workerId: WORKER_ID,
    workspaceId: 'workspace-1',
    getWorkspaceId: async () => 'workspace-1',
    getLevel: async () => 'worker',
    authType: 'api',
  };
}

describe('update_progress', () => {
  let mockApi: ReturnType<typeof mock>;

  beforeEach(() => {
    mockApi = mock(() => Promise.resolve({ status: 'running', progress: 25 }));
  });

  it('records progress, message, and plan through the worker PATCH endpoint', async () => {
    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'update_progress',
      {
        progress: 25,
        message: 'Regression test written',
        plan: '1. Add regression coverage\n2. Fix progress reporting',
      },
      makeContext(),
    );

    expect(mockApi).toHaveBeenCalledTimes(1);
    const [path, options] = mockApi.mock.calls[0];
    expect(path).toBe(`/api/workers/${WORKER_ID}`);
    expect(options.method).toBe('PATCH');
    expect(JSON.parse(options.body)).toEqual({
      status: 'running',
      progress: 25,
      appendMilestones: [
        {
          type: 'status',
          label: 'Regression test written',
          progress: 25,
          ts: expect.any(Number),
        },
        {
          type: 'plan',
          label: '1. Add regression coverage\n2. Fix progress reporting',
          progress: 25,
          ts: expect.any(Number),
        },
      ],
      currentAction: 'Regression test written',
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Progress updated: 25%');
    expect(result.content[0].text).toContain('Plan recorded');
  });
});
