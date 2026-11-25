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
  it('patches tier and says it applies at the next claim when no agent is running', async () => {
    const api = okTask();
    const result = await handleBuilddAction(api as unknown as ApiFn, 'update_task', {
      taskId: TASK_ID, tier: 'premium',
    }, ctx);

    expect(JSON.parse(api.mock.calls[0][1].body)).toEqual({ tier: 'premium' });
    expect(result.content[0].text).toContain('Tier: premium');
    expect(result.content[0].text).toMatch(/no agent is running this task, so it takes effect on the next claim/);
  });

  it('re-tiering a task with a live worker warns which tier that worker is still running at', async () => {
    const message = 'Worker w-1 (running) is still running at standard, claude-sonnet-5-5; the new tier/model applies to the next attempt only. To rerun at it now, set status: pending.';
    const api = mock(() => Promise.resolve({
      id: TASK_ID, title: 'Pin me', status: 'in_progress', priority: 5,
      modelChange: { appliesTo: 'next_attempt', workerId: 'w-1', workerStatus: 'running', runningTier: 'standard', runningModel: 'claude-sonnet-5-5', message },
    }));
    const result = await handleBuilddAction(api as unknown as ApiFn, 'update_task', {
      taskId: TASK_ID, tier: 'premium',
    }, ctx);

    const text = result.content[0].text;
    expect(text).toContain('Tier: premium');
    expect(text).toContain(`WARNING: ${message}`);
    expect(text).not.toMatch(/Note: takes effect/);
  });

  it('re-tiering a task whose session resumes in place says so, without a warning', async () => {
    const message = 'Resuming in place: worker w-1 pauses at its next safe point and continues the same session on claude-opus-5-5 (it was at standard, claude-sonnet-5-5).';
    const api = mock(() => Promise.resolve({
      id: TASK_ID, title: 'Pin me', status: 'in_progress', priority: 5,
      modelChange: { appliesTo: 'resume_in_place', workerId: 'w-1', workerStatus: 'running', targetModel: 'claude-opus-5-5', message },
    }));
    const result = await handleBuilddAction(api as unknown as ApiFn, 'update_task', { taskId: TASK_ID, tier: 'premium' }, ctx);
    const text = result.content[0].text;
    expect(text).toContain(message);
    expect(text).not.toContain('WARNING');
  });

  it('a requeue says whether the session was kept or a new attempt started', async () => {
    const kept = mock(() => Promise.resolve({
      id: TASK_ID, title: 'Pin me', status: 'in_progress', priority: 5,
      requeue: { outcome: 'resumed_in_place', workerId: 'w-1', message: 'Pausing the agent at its next safe point, then resuming the same session.' },
    }));
    const a = await handleBuilddAction(kept as unknown as ApiFn, 'update_task', { taskId: TASK_ID, status: 'pending' }, ctx);
    expect(a.content[0].text).toContain('Restart: Pausing the agent at its next safe point, then resuming the same session.');

    const fresh = mock(() => Promise.resolve({
      id: TASK_ID, title: 'Pin me', status: 'pending', priority: 5,
      requeue: { outcome: 'new_attempt', workerId: 'w-1', reasonCode: 'runner_not_reporting', message: 'New attempt: the task starts again from its last pushed commit, because the runner holding the session stopped reporting and nothing was parked.' },
    }));
    const b = await handleBuilddAction(fresh as unknown as ApiFn, 'update_task', { taskId: TASK_ID, status: 'pending' }, ctx);
    expect(b.content[0].text).toContain('Restart: New attempt: the task starts again from its last pushed commit, because');
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
