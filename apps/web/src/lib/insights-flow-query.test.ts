import { expect, it, mock } from 'bun:test';
const findMany = mock(async () => [
  { id: 'worker', taskId: 'task', workspaceId: 'ws', status: 'completed', startedAt: new Date(1000), completedAt: new Date(2000), inputTokens: 100, outputTokens: 20, costUsd: '1.250000', task: { roleSlug: 'builder', tier: 'premium', context: { resolvedTier: { tier: 'budget' }, routingReason: 'budget_downshift' } } },
  { id: 'alias', taskId: 'alias', workspaceId: 'ws', status: 'completed', startedAt: new Date(1000), task: { predictedModel: 'sonnet' } },
]);
mock.module('@buildd/core/db', () => ({ db: { query: { workers: { findMany } } } }));
const { fetchFlowWorkerRows } = await import('./insights-flow-query');
it('selects recorded worker usage and resolves the routed tier before the requested tier', async () => {
  const rows = await fetchFlowWorkerRows(['ws'], new Date(0));
  expect(rows[0]).toMatchObject({ inputTokens: 100, outputTokens: 20, costUsd: 1.25, roleSlug: 'builder', tier: 'budget' });
  expect(rows[1].tier).toBe('standard');
  const options = findMany.mock.calls[0][0] as any;
  expect(options.columns).toMatchObject({ inputTokens: true, outputTokens: true, costUsd: true });
  expect(options.with.task.columns).toMatchObject({ context: true, predictedModel: true });
  findMany.mockClear();
  expect(await fetchFlowWorkerRows([], new Date())).toEqual([]);
  expect(findMany).not.toHaveBeenCalled();
});
