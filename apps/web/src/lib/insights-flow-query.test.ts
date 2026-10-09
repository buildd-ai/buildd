import { expect, it, mock } from 'bun:test';
const findMany = mock(async () => [
  { id: 'worker', taskId: 'task', workspaceId: 'ws', status: 'completed', startedAt: new Date(1000), completedAt: new Date(2000), inputTokens: 100, outputTokens: 20, costUsd: '1.250000', costBasis: 'real', runner: 'mcp', task: { roleSlug: 'builder', tier: 'premium', routingContext: { resolvedTier: { tier: 'budget' }, routingReason: 'budget_downshift' } } },
  { id: 'alias', taskId: 'alias', workspaceId: 'ws', status: 'completed', startedAt: new Date(1000), task: { predictedModel: 'sonnet' } },
]);
mock.module('@buildd/core/db', () => ({ db: { query: { workers: { findMany } } } }));
const { fetchFlowWorkerRows, loadFlowUsage } = await import('./insights-flow-query');
it('selects recorded worker usage and resolves the routed tier before the requested tier', async () => {
  const rows = await fetchFlowWorkerRows(['ws'], new Date(0));
  expect(rows[0]).toMatchObject({ inputTokens: 100, outputTokens: 20, costUsd: 1.25, roleSlug: 'builder', tier: 'budget' });
  expect(rows[1].tier).toBe('standard');
  expect(rows[0]).toMatchObject({ costBasis: 'real', runner: 'mcp' });
  expect(rows[1]).toMatchObject({ costBasis: null, runner: null });
  const options = findMany.mock.calls[0][0] as any;
  expect(options.columns).toMatchObject({ inputTokens: true, outputTokens: true, costUsd: true, costBasis: true, runner: true });
  expect(options.with.task.columns).toMatchObject({ predictedModel: true });
  findMany.mockClear();
  expect(await fetchFlowWorkerRows([], new Date())).toEqual([]);
  expect(findMany).not.toHaveBeenCalled();
});

// A 30-day window reads thousands of workers; selecting the whole `tasks.context`
// blob for each pushed the response past Neon's 64 MB HTTP cap (507) and the
// page failed to render. Only the keys `deriveTaskModel` reads may leave the DB.
it('never selects the whole task context, only the routing keys the tier needs', async () => {
  await fetchFlowWorkerRows(['ws'], new Date(0));
  const task = (findMany.mock.calls[0][0] as any).with.task;
  expect(task.columns.context).toBeUndefined();
  const { PgDialect } = await import('drizzle-orm/pg-core');
  const { tasks } = await import('@buildd/core/db/schema');
  const { sql } = await import('drizzle-orm');
  const extras = task.extras(tasks, { sql });
  const rendered = new PgDialect().sqlToQuery(extras.routingContext.getSQL()).sql;
  for (const key of ['model', 'resolvedTier', 'routingReason', 'routingInferred', 'routingInferredReason']) {
    expect(rendered).toContain(`'${key}'`);
  }
  expect(rendered).not.toMatch(/"context"\s*(as|,|$)/);
  findMany.mockClear();
  expect(await fetchFlowWorkerRows([], new Date())).toEqual([]);
  expect(findMany).not.toHaveBeenCalled();
});

it('loads the moved role counters without release queries and preserves cost basis and routed tier', async () => {
  const data = await loadFlowUsage(['ws'], '7d', 3000);
  expect(data.truncated).toBe(false);
  expect(data.rows[0]).toMatchObject({ role: 'builder', tier: 'budget', tokens: 120, costUsd: 1.25, basis: 'real', executor: 'interactive' });
  expect(data.rows[0].hours).toBeCloseTo(1000 / 3_600_000);
  expect(await loadFlowUsage([], '7d', 3000)).toEqual({ rows: [], truncated: false });
});
