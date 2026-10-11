import { expect, it, mock } from 'bun:test';
const findMany = mock(async () => [
  { id: 'w1', completedAt: new Date(1000), taskId: 't1', workspaceId: 'ws', inputTokens: 5, outputTokens: 1, costUsd: '1.5', turns: 2, resultMeta: null, mcpCalls: null, runner: 'mcp', costBasis: 'virtual', task: null },
]);
const subWhere = mock((w: unknown) => ({ subquery: w }));
const select = mock(() => ({ from: () => ({ where: subWhere }) }));
mock.module('@buildd/core/db', () => ({ db: { query: { workers: { findMany } }, select } }));

/** Whether `v` appears anywhere inside a drizzle condition (cycle-safe). */
function holds(obj: unknown, v: string, seen = new WeakSet<object>()): boolean {
  if (obj === v) return true;
  if (!obj || typeof obj !== 'object' || seen.has(obj as object)) return false;
  seen.add(obj as object);
  return Object.values(obj as Record<string, unknown>).some((x) => holds(x, v, seen));
}
const { fetchUsageRows } = await import('./usage-stats-query');

it('reads each worker\'s cost basis and runner, so rollups can split by both', async () => {
  const rows = await fetchUsageRows({ workspaceIds: ['ws'], windowStart: new Date(0) });
  expect(rows[0]).toMatchObject({ costBasis: 'virtual', runner: 'mcp' });
  expect((findMany.mock.calls[0][0] as any).columns).toMatchObject({ costBasis: true, runner: true });
});

it('narrows to one person\'s tasks when asked, and reads every task otherwise', async () => {
  subWhere.mockClear();
  await fetchUsageRows({ workspaceIds: ['ws'], windowStart: new Date(0) });
  expect(subWhere).not.toHaveBeenCalled();
  await fetchUsageRows({ workspaceIds: ['ws'], windowStart: new Date(0), forUserId: 'user-fixture' });
  expect(subWhere).toHaveBeenCalledTimes(1);
  expect(holds(subWhere.mock.calls[0][0], 'user-fixture')).toBe(true);
});
