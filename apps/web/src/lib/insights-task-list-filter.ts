import { redirect } from 'next/navigation';
import { can } from './permissions';
import { loadFlowSeries } from './insights-flow-query';
import { parseBandFilter } from '@/components/insights/usage-model';
import { BAND_LABEL, tasksInBand } from '@/components/insights/flow-chart-model';
import type { TaskListFilterResolver } from './task-list-filters';

export const insightsTaskListFilter: TaskListFilterResolver = async ({ params, workspaceIds, userId, teamId }) => {
  const filter = parseBandFilter(params);
  if (!filter) return null;
  if (!(await can({ kind: 'user', userId }, 'view_team_usage', teamId))) redirect('/app/health/insights');
  const window = filter.to - filter.from <= 7 * 86400000 ? '7d' : '30d';
  const series = await loadFlowSeries(workspaceIds, window, filter.to);
  const index = Math.floor((filter.at - series.window.from) / series.bucketMs);
  const start = filter.band === 'released' || filter.band === 'lost' ? filter.from : series.buckets[index].start;
  return {
    ids: tasksInBand(series, index, filter.band).map(t => t.key).filter(key => !key.startsWith('worker:')),
    label: `${BAND_LABEL[filter.band]} · ${new Date(start).toLocaleString()} – ${new Date(series.buckets[index].end).toLocaleString()}`,
  };
};
