import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { handleBuilddAction, type ActionContext, type ApiFn } from '../mcp-tools';

const WORKER_ID = '510a982f-61f6-4fde-b37c-b2bbdc6d1f03';
const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';

function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workerId: WORKER_ID,
    workspaceId: WORKSPACE_ID,
    getWorkspaceId: async () => WORKSPACE_ID,
    getLevel: async () => 'worker',
    ...overrides,
  };
}

describe('claim_task current assignment recovery', () => {
  let mockApi: ReturnType<typeof mock>;

  beforeEach(() => {
    mockApi = mock();
  });

  it('returns the calling worker assignment instead of claiming another task', async () => {
    mockApi.mockResolvedValue({
      id: WORKER_ID,
      status: 'running',
      branch: 'buildd/current-task',
      task: {
        id: 'task-current',
        title: 'Current task',
        description: 'Keep working on this task',
        status: 'assigned',
      },
    });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'claim_task',
      {},
      ctx(),
    );

    expect(mockApi).toHaveBeenCalledTimes(1);
    expect(mockApi.mock.calls[0][0]).toBe(`/api/workers/${WORKER_ID}`);
    expect(result.content[0].text).toContain('Current assignment');
    expect(result.content[0].text).toContain(WORKER_ID);
    expect(result.content[0].text).toContain('Current task');
    expect(result.content[0].text).toContain('buildd/current-task');
  });

  it('recovers the exact assignment before an ambiguous OAuth workspace guard', async () => {
    mockApi.mockResolvedValue({
      id: WORKER_ID,
      status: 'starting',
      branch: 'buildd/current-task',
      task: {
        id: 'task-current',
        title: 'Current task',
        status: 'assigned',
      },
    });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'claim_task',
      {},
      ctx({
        authType: 'oauth',
        workspaceId: undefined,
        getWorkspaceId: async () => null,
      }),
    );

    expect(result.isError).toBeFalsy();
    expect(mockApi).toHaveBeenCalledTimes(1);
    expect(mockApi.mock.calls[0][0]).toBe(`/api/workers/${WORKER_ID}`);
    expect(result.content[0].text).toContain('Current assignment');
  });

  it('continues to the claim endpoint when the contextual worker is terminal', async () => {
    mockApi
      .mockResolvedValueOnce({
        id: WORKER_ID,
        status: 'completed',
        task: { id: 'task-old', title: 'Old task', status: 'completed' },
      })
      .mockResolvedValueOnce({ workers: [] });

    const result = await handleBuilddAction(
      mockApi as unknown as ApiFn,
      'claim_task',
      {},
      ctx(),
    );

    expect(mockApi).toHaveBeenCalledTimes(2);
    expect(mockApi.mock.calls[1][0]).toBe('/api/workers/claim');
    expect(result.content[0].text).toContain('No tasks available to claim');
  });
});
