import { describe, expect, it, mock } from 'bun:test';
import { handleBuilddAction, type ActionContext, type ApiFn } from '../mcp-tools';

const TASK_ID = '11111111-1111-1111-1111-111111111111';

const ctx: ActionContext = {
  workspaceId: 'ws-1',
  getWorkspaceId: async () => 'ws-1',
  getLevel: async () => 'worker',
};

const okTask = () => mock(() => Promise.resolve({
  id: TASK_ID, title: 'Pin me', status: 'pending', priority: 5,
}));

describe('update_task tier / model pin', () => {
  it('patches tier and says it applies at the next claim or retry', async () => {
    const api = okTask();
    const result = await handleBuilddAction(api as unknown as ApiFn, 'update_task', {
      taskId: TASK_ID, tier: 'premium',
    }, ctx);

    expect(JSON.parse(api.mock.calls[0][1].body)).toEqual({ tier: 'premium' });
    expect(result.content[0].text).toContain('Tier: premium');
    expect(result.content[0].text).toMatch(/next claim or retry/);
  });

  it('patches a model id', async () => {
    const api = okTask();
    const result = await handleBuilddAction(api as unknown as ApiFn, 'update_task', {
      taskId: TASK_ID, model: 'claude-opus-4-8',
    }, ctx);

    expect(JSON.parse(api.mock.calls[0][1].body)).toEqual({ model: 'claude-opus-4-8' });
    expect(result.content[0].text).toContain('Model: claude-opus-4-8');
  });

  it('forwards null to clear either pin', async () => {
    const api = okTask();
    const result = await handleBuilddAction(api as unknown as ApiFn, 'update_task', {
      taskId: TASK_ID, tier: null, model: null,
    }, ctx);

    expect(JSON.parse(api.mock.calls[0][1].body)).toEqual({ tier: null, model: null });
    expect(result.content[0].text).toContain('routing decides');
  });

  it('rejects an out-of-vocabulary tier without calling the API', async () => {
    const api = okTask();
    await expect(handleBuilddAction(api as unknown as ApiFn, 'update_task', {
      taskId: TASK_ID, tier: 'opus',
    }, ctx)).rejects.toThrow(/premium-plus, premium, standard, budget/);
    expect(api).not.toHaveBeenCalled();
  });

  it('rejects a model that is not Anthropic-shaped without calling the API', async () => {
    const api = okTask();
    await expect(handleBuilddAction(api as unknown as ApiFn, 'update_task', {
      taskId: TASK_ID, model: 'gpt-something',
    }, ctx)).rejects.toThrow(/model/);
    expect(api).not.toHaveBeenCalled();
  });
});
