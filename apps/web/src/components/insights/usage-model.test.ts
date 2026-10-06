import { expect, it } from 'bun:test';
import { usageByRole, summarizeBand, bandTaskListHref, parseBandFilter } from './usage-model';
import { sampleFlowSeries } from '@/app/app/(protected)/health/insights/sample-series';
it('attributes worker totals to their own role and tier, excludes outside-window workers and keeps unknown tiers', () => {
  const rows = [
    { role: 'builder', tier: 'standard', tokens: 120, costUsd: 2, hours: 1 },
    { role: 'reviewer', tier: 'premium', tokens: 80, costUsd: 3, hours: 2 },
    { role: 'builder', tier: null, tokens: 10, costUsd: 0, hours: 0 },
  ];
  const groups = usageByRole(rows);
  expect(groups[0].role).toBe('builder');
  expect(groups[0].tokens).toBe(130);
  expect(groups[0].tiers.map(t => t.tier)).toEqual(['standard', 'unknown']);
  expect(groups[1].costUsd).toBe(3);
  expect(usageByRole([])).toEqual([]);
});
it('summarizes the entire band but limits recent tasks, with consistent band/time links', () => {
  const s = sampleFlowSeries('7d');
  const tasks = Array.from({ length: 40 }, (_, i) => ({ ...s.tasks[0], key: String(i), role: i % 2 ? 'builder' : 'reviewer', workspaceId: 'ws', shippedAt: s.window.from + i }));
  s.tasks = tasks;
  s.workspaceNames = { ws: 'Workspace' };
  const summary = summarizeBand(s, s.buckets.length - 1, 'released');
  expect(summary.total).toBe(40);
  expect(summary.roles[0].count).toBe(20);
  expect(summary.workspaces[0].count).toBe(40);
  expect(summary.outcomes).toEqual([{ label: 'Released', count: 40 }]);
  expect(summary.recent).toHaveLength(5);
  expect(summary.recent[0].key).toBe('39');
  const params = new URLSearchParams(bandTaskListHref(s, s.buckets.length - 1, 'released').split('?')[1]);
  expect(parseBandFilter(Object.fromEntries(params))).toEqual({ band: 'released', from: s.window.from, to: s.window.to, at: s.buckets.at(-1)!.start });
  expect(parseBandFilter({ band: 'invalid', from: '0', to: '1', at: '0' })).toBeNull();
});

it('builds usage from worker rows once, preserving retry roles and all recorded tiers', async () => {
  const { buildFlowSeries } = await import('@/lib/insights-flow');
  const from = 10000000, to = from + 3600000;
  const worker = (id: string, role: string, tier: string | null, start = from) => ({
    workerId: id, taskId: id, parentTaskId: id === 'retry' ? 'root' : null, roleSlug: role, tier,
    taskTitle: id, taskStatus: 'completed', workspaceId: 'ws', missionId: null,
    status: 'completed', startedAt: start, completedAt: to, updatedAt: to,
    prNumber: null, mergedAt: null, prLifecycleStatus: null, prLastCheckedAt: null,
    prSupersededAt: null, prAbandonedAt: null,
    inputTokens: 100, outputTokens: 20, costUsd: 1,
  });
  const root = worker('root', 'builder', 'standard');
  const s = buildFlowSeries({ window: { from, to }, now: to, bucketMs: 3600000,
    workers: [root, root, worker('retry', 'reviewer', 'premium'), worker('plus', 'builder', 'premium-plus'), worker('budget', 'builder', 'budget'), worker('older', 'builder', null, from - 3600000), worker('future', 'builder', 'standard', to)],
    releases: [], releaseTasks: [], releaseWorkspaceIds: [],
  });
  const groups = usageByRole(s.usage!);
  expect(groups[0].tokens).toBe(360);
  expect(groups[0].costUsd).toBe(3);
  expect(groups[0].hours).toBe(4);
  expect(groups[0].tiers.map(t => t.tier)).toEqual(['standard', 'premium-plus', 'budget', 'unknown']);
  expect(groups[1].role).toBe('reviewer');
  expect(groups[1].tokens).toBe(120);
});
