import { expect, it, mock } from 'bun:test';
const findMany = mock(async () => [
  { id: 'w1', completedAt: new Date(1000), taskId: 't1', workspaceId: 'ws', inputTokens: 5, outputTokens: 1, costUsd: '1.5', turns: 2, resultMeta: null, mcpCalls: null, runner: 'mcp', costBasis: 'virtual', task: null },
]);
mock.module('@buildd/core/db', () => ({ db: { query: { workers: { findMany } } } }));
const { fetchUsageRows } = await import('./usage-stats-query');

it('reads each worker\'s cost basis and runner, so rollups can split by both', async () => {
  const rows = await fetchUsageRows({ workspaceIds: ['ws'], windowStart: new Date(0) });
  expect(rows[0]).toMatchObject({ costBasis: 'virtual', runner: 'mcp' });
  expect((findMany.mock.calls[0][0] as any).columns).toMatchObject({ costBasis: true, runner: true });
});
