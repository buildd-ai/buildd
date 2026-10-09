import { describe, expect, it, mock } from 'bun:test';
import { handleBuilddAction, type ActionContext, type ApiFn } from '../mcp-tools';

const TASK_ID = '11111111-1111-1111-1111-111111111111';

const ctx: ActionContext = {
  workspaceId: 'ws-1',
  getWorkspaceId: async () => 'ws-1',
  getLevel: async () => 'worker',
};

const taskStartingAt = (startAt: string | null) => mock(() => Promise.resolve({
  id: TASK_ID, title: 'Daily finance digest', status: 'pending', priority: 5, startAt,
}));

describe('update_task reschedule', () => {
  it('forwards startIn and reports the new start time', async () => {
    const at = '2030-01-01T12:00:00.000Z';
    const api = taskStartingAt(at);
    const result = await handleBuilddAction(api as unknown as ApiFn, 'update_task', {
      taskId: TASK_ID, startIn: '4h',
    }, ctx);
    expect(JSON.parse(api.mock.calls[0][1].body)).toEqual({ startIn: '4h' });
    expect(result.content[0].text).toContain(`Starts at: ${at}`);
  });

  it('forwards startAt: null as start as soon as possible', async () => {
    const api = taskStartingAt(null);
    const result = await handleBuilddAction(api as unknown as ApiFn, 'update_task', {
      taskId: TASK_ID, startAt: null,
    }, ctx);
    expect(JSON.parse(api.mock.calls[0][1].body)).toEqual({ startAt: null });
    expect(result.content[0].text).toContain('Starts: as soon as possible');
  });

  it('forwards an ISO startAt unchanged', async () => {
    const at = '2030-01-01T12:00:00.000Z';
    const api = taskStartingAt(at);
    await handleBuilddAction(api as unknown as ApiFn, 'update_task', { taskId: TASK_ID, startAt: at }, ctx);
    expect(JSON.parse(api.mock.calls[0][1].body)).toEqual({ startAt: at });
  });
});
