import { describe, expect, it, mock } from 'bun:test';
import { handleBuilddAction, type ActionContext, type ApiFn } from '../mcp-tools';

const TASK_ID = '11111111-1111-1111-1111-111111111111';

const ctx: ActionContext = {
  workspaceId: 'ws-1',
  getWorkspaceId: async () => 'ws-1',
  getLevel: async () => 'worker',
};

const cancelled = () => mock(() => Promise.resolve({
  id: TASK_ID, title: 'Daily finance digest', status: 'cancelled', priority: 5,
}));

describe('update_task cancel needs an explicit abort for a live worker', () => {
  it('forwards abort: true with the cancel', async () => {
    const api = cancelled();
    await handleBuilddAction(api as unknown as ApiFn, 'update_task', {
      taskId: TASK_ID, status: 'cancelled', abort: true,
    }, ctx);
    expect(JSON.parse(api.mock.calls[0][1].body)).toEqual({ status: 'cancelled', abort: true });
  });

  it('sends no abort flag unless asked', async () => {
    const api = cancelled();
    await handleBuilddAction(api as unknown as ApiFn, 'update_task', { taskId: TASK_ID, status: 'cancelled' }, ctx);
    expect(JSON.parse(api.mock.calls[0][1].body)).toEqual({ status: 'cancelled' });
  });

  it('refuses abort on anything but a cancel', async () => {
    const api = cancelled();
    await expect(handleBuilddAction(api as unknown as ApiFn, 'update_task', {
      taskId: TASK_ID, title: 'x', abort: true,
    }, ctx)).rejects.toThrow(/abort only applies to status: cancelled/);
    expect(api).not.toHaveBeenCalled();
  });
});
