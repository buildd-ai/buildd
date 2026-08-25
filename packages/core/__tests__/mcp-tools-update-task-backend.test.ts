import { describe, expect, it, mock } from 'bun:test';
import { handleBuilddAction, type ActionContext, type ApiFn } from '../mcp-tools';

const TASK_ID = '11111111-1111-1111-1111-111111111111';

const ctx: ActionContext = {
  workspaceId: 'ws-1',
  getWorkspaceId: async () => 'ws-1',
  getLevel: async () => 'worker',
};

const okTask = (backend: string | null) => mock(() => Promise.resolve({
  id: TASK_ID, title: 'Daily finance digest', status: 'pending', priority: 5, backend,
}));

describe('update_task backend switch', () => {
  it('patches the backend and reports the provider it moved to', async () => {
    const api = okTask('claude');
    const result = await handleBuilddAction(api as unknown as ApiFn, 'update_task', {
      taskId: TASK_ID, backend: 'claude',
    }, ctx);

    expect(JSON.parse(api.mock.calls[0][1].body)).toEqual({ backend: 'claude' });
    expect(result.content[0].text).toContain('Backend: Claude');
  });

  it('clears the override when passed null', async () => {
    const api = okTask(null);
    const result = await handleBuilddAction(api as unknown as ApiFn, 'update_task', {
      taskId: TASK_ID, backend: null,
    }, ctx);

    expect(JSON.parse(api.mock.calls[0][1].body)).toEqual({ backend: null });
    expect(result.content[0].text).toContain('default (mission/role/workspace)');
  });

  it('rejects a provider the runner cannot dispatch', async () => {
    const api = okTask('claude');
    await expect(handleBuilddAction(api as unknown as ApiFn, 'update_task', {
      taskId: TASK_ID, backend: 'openrouter',
    }, ctx)).rejects.toThrow(/claude, codex/);
    expect(api).not.toHaveBeenCalled();
  });
});
