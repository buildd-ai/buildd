import { describe, expect, it, mock } from 'bun:test';
import { handleBuilddAction, type ActionContext, type ApiFn } from '../mcp-tools';

const TASK_ID = '11111111-1111-1111-1111-111111111111';
const ctx: ActionContext = { workspaceId: 'ws-1', getWorkspaceId: async () => 'ws-1', getLevel: async () => 'worker' };

describe('update_task pause (task baf3809a)', () => {
  it('sends pause on its own and says the session is kept', async () => {
    const api = mock(() => Promise.resolve({ id: TASK_ID, paused: 'requested', workerId: 'w-1' }));
    const out = await handleBuilddAction(api as unknown as ApiFn, 'update_task', { taskId: TASK_ID, pause: true }, ctx);
    expect(api.mock.calls[0][0]).toBe(`/api/tasks/${TASK_ID}`);
    expect(JSON.parse(api.mock.calls[0][1].body)).toEqual({ pause: true });
    expect(JSON.stringify(out)).toMatch(/session is kept/);
  });

  it('refuses pause mixed with other edits, or anything but true', async () => {
    const api = mock(() => Promise.resolve({}));
    await expect(handleBuilddAction(api as unknown as ApiFn, 'update_task', { taskId: TASK_ID, pause: true, status: 'cancelled' }, ctx)).rejects.toThrow(/on its own/);
    await expect(handleBuilddAction(api as unknown as ApiFn, 'update_task', { taskId: TASK_ID, pause: false }, ctx)).rejects.toThrow(/pause must be true/);
    expect(api).not.toHaveBeenCalled();
  });
});
