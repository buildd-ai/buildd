import { describe, it, expect } from 'bun:test';
import { rankTopTasks } from './usage-extras';

const row = (taskId: string | null, costUsd: number | null, workspaceId = 'ws-a') => ({ taskId, costUsd, workspaceId });

describe('rankTopTasks', () => {
  it('sums every worker of a task and keeps the most expensive tasks first', () => {
    const top = rankTopTasks([row('t1', 2), row('t2', 5), row('t1', 4), row('t3', 1)], 2);
    expect(top).toEqual([
      { taskId: 't1', workspaceId: 'ws-a', costUsd: 6, workers: 2 },
      { taskId: 't2', workspaceId: 'ws-a', costUsd: 5, workers: 1 },
    ]);
  });

  it('ignores workers with no task or no cost', () => {
    expect(rankTopTasks([row(null, 9), row('t1', null), row('t2', 1)], 5)).toEqual([
      { taskId: 't2', workspaceId: 'ws-a', costUsd: 1, workers: 1 },
    ]);
  });
});
