import { expect, it, mock } from 'bun:test';
import { sampleFlowSeries } from '@/app/app/(protected)/health/insights/sample-series';
import { tasksInBand } from '@/components/insights/flow-chart-model';
import { bandTaskListHref } from '@/components/insights/usage-model';
const series = sampleFlowSeries('7d');
let allowed = true;
const load = mock(async () => series);
mock.module('./insights-flow-query', () => ({ loadFlowSeries: load }));
mock.module('./permissions', () => ({ can: async () => allowed }));
mock.module('next/navigation', () => ({ redirect: (url: string) => { throw new Error('redirect:' + url); } }));
const { insightsTaskListFilter } = await import('./insights-task-list-filter');
const input = { params: {}, workspaceIds: ['team-ws'], userId: 'user', teamId: 'team' };
it('returns no filter for ordinary requests and reproduces each selected band at the exact time', async () => {
  expect(await insightsTaskListFilter(input)).toBeNull();
  for (const band of ['running', 'waiting', 'review', 'merged', 'released', 'lost'] as const) {
    const index = series.buckets.length - 1;
    const params = Object.fromEntries(new URLSearchParams(bandTaskListHref(series, index, band).split('?')[1]));
    const result = await insightsTaskListFilter({ ...input, params });
    expect(result!.ids).toEqual(tasksInBand(series, index, band).map(t => t.key));
    expect(load).toHaveBeenLastCalledWith(input.workspaceIds, '7d', series.window.to);
    expect(result!.label).toContain(' · ');
  }
});
it('denies band filtering without team usage permission before reading worker totals', async () => {
  allowed = false;
  load.mockClear();
  const params = Object.fromEntries(new URLSearchParams(bandTaskListHref(series, 0, 'running').split('?')[1]));
  await expect(insightsTaskListFilter({ ...input, params })).rejects.toThrow('redirect:/app/health/insights');
  expect(load).not.toHaveBeenCalled();
});
