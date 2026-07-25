import { describe, expect, it, mock } from 'bun:test';
import {
  handleBuilddAction,
  type ActionContext,
  type ApiFn,
} from '../mcp-tools';

const WORKER_ID = 'worker-progress-1';

const context: ActionContext = {
  workerId: WORKER_ID,
  workspaceId: 'workspace-1',
  getWorkspaceId: async () => 'workspace-1',
  getLevel: async () => 'worker',
  authType: 'api',
};

describe('MCP update_progress', () => {
  it('records a plan through the worker PATCH endpoint with the progress update', async () => {
    const api = mock(async () => ({ status: 'running', progress: 25 }));

    const result = await handleBuilddAction(
      api as unknown as ApiFn,
      'update_progress',
      {
        progress: 25,
        message: 'Plan ready',
        plan: '1. Add regression test\n2. Fix progress routing',
      },
      context,
    );

    expect(api).toHaveBeenCalledTimes(1);
    expect(api.mock.calls[0]?.[0]).toBe(`/api/workers/${WORKER_ID}`);
    expect(api.mock.calls[0]?.[1]?.method).toBe('PATCH');

    const body = JSON.parse(String(api.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      status: 'running',
      progress: 25,
      currentAction: 'Plan ready',
    });
    expect(body.appendMilestones).toEqual([
      {
        type: 'plan',
        label: '1. Add regression test\n2. Fix progress routing',
        progress: 25,
        ts: expect.any(Number),
      },
      {
        type: 'status',
        label: 'Plan ready',
        progress: 25,
        ts: expect.any(Number),
      },
    ]);
    expect(result.content[0]?.text).toContain('Progress updated: 25% - Plan ready');
  });
});
