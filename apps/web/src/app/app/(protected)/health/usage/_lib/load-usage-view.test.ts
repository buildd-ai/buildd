import { beforeEach, expect, it, mock } from 'bun:test';

const flow = mock(async (_workspaceIds: string[], _window: string, _now: number) => ({ rows: [], truncated: false }));
const budget = mock(async (_teamId: string, _workspaceIds: string[]) => ({ monthly: { spentUsd: 5 } }));
let allowed = true;
mock.module('@/lib/permissions', () => ({ can: async () => allowed }));
mock.module('@/lib/budget-forecast', () => ({ getBudgetForecast: budget }));
mock.module('@/lib/insights-flow-query', () => ({ loadFlowUsage: flow }));
mock.module('next/headers', () => ({ cookies: async () => ({ get: () => ({ value: 'active-team' }) }) }));
mock.module('@/lib/team-access', () => ({ resolveActiveTeamId: async () => 'active-team' }));
mock.module('@buildd/core/db', () => ({ db: {
  select: () => ({ from: () => ({ where: async () => [{ id: 'ws-a', name: 'A' }, { id: 'ws-b', name: 'B' }] }) }),
} }));
mock.module('@/lib/usage-stats-query', () => ({ USAGE_ROW_LIMIT: 5000, fetchUsageRows: async () => [] }));
mock.module('@/lib/action-events', () => ({
  ACTION_EVENTS_CAPTURED_SINCE: '2026-09-01', ACTION_EVENTS_ROW_LIMIT: 5000,
  fetchActionEvents: async () => [], countWorkersInWindow: async () => 0,
}));
const { loadUsageView } = await import('./load-usage-view');
const load = (workspace?: string, window = '7d', includeInternals = false) => loadUsageView({ userId: 'user', teamIds: ['active-team'], searchParams: { workspace, window }, includeInternals });
beforeEach(() => { allowed = true; flow.mockClear(); budget.mockClear(); });

it('loads role counters for the authorised workspace and clamps the same window as Usage', async () => {
  const result = await load('ws-b', '24h');
  expect(result.kind).toBe('ok');
  expect(flow.mock.calls[0]?.slice(0, 2)).toEqual([['ws-b'], '7d']);
  expect(budget.mock.calls[0]?.slice(0, 2)).toEqual(['active-team', ['ws-b']]);
  if (result.kind === 'ok') expect(result.monthly).toEqual({ spentUsd: 5 });
});

it('ignores a workspace outside the team', async () => {
  await load('foreign');
  expect(flow.mock.calls[0]?.[0]).toEqual(['ws-a', 'ws-b']);
});

it('preserves the permission on the role table after moving it from Insights', async () => {
  allowed = false;
  const result = await load();
  expect(flow).not.toHaveBeenCalled();
  if (result.kind === 'ok') expect(result.roleUsage).toBeNull();
});

it('does not load either moved panel for Operator', async () => {
  await load(undefined, '7d', true);
  expect(flow).not.toHaveBeenCalled();
  expect(budget).not.toHaveBeenCalled();
});
