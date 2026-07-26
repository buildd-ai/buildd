import { describe, expect, it, mock } from 'bun:test';
import { handleBuilddAction, type ActionContext, type ApiFn } from '../mcp-tools';

const ctx: ActionContext = {
  workspaceId: 'ws-1',
  getWorkspaceId: async () => 'ws-1',
  getLevel: async () => 'worker',
};

describe('update_task loop maxLoops', () => {
  it('patches maxLoops and explains that active workers need send_agent_message', async () => {
    const api = mock(() => Promise.resolve({
      id: 'task-1',
      title: 'Looping',
      status: 'in_progress',
      priority: 5,
      loopConfig: { exitCondition: { type: 'command', command: 'bun test' }, maxLoops: 8 },
    }));

    const result = await handleBuilddAction(
      api as unknown as ApiFn,
      'update_task',
      { taskId: 'task-1', maxLoops: 8 },
      ctx,
    );

    expect(JSON.parse(api.mock.calls[0][1].body)).toEqual({ maxLoops: 8 });
    expect(result.content[0].text).toContain('Max loops: 8');
    expect(result.content[0].text).toContain('send_agent_message');
  });
});
