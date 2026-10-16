import { redirect } from 'next/navigation';
import { can } from './permissions';
import { loadFlowSeries } from './insights-flow-query';
import { parseBandFilter } from '@/components/insights/usage-model';
import { BAND_LABEL, tasksInBand } from '@/components/insights/flow-chart-model';
import { parseSplitFilter, tasksWithTime, TIME_LABEL } from '@/components/insights/insights-summary';
import type { TaskListFilterResolver } from './task-list-filters';

const windowOf = (from: number, to: number) => (to - from <= 7 * 86400000 ? '7d' : '30d');

export const insightsTaskListFilter: TaskListFilterResolver = async ({ params, workspaceIds, userId, teamId }) => {
  const filter = parseBandFilter(params);
  const split = filter ? null : parseSplitFilter(params);
  if (!filter && !split) return null;
  if (!(await can({ kind: 'user', userId }, 'view_team_usage', teamId))) redirect('/app/health/insights');
  // A row of "What slowed work down?": every task that spent time in it.
  if (split) {
    const series = await loadFlowSeries(workspaceIds, windowOf(split.from, split.to), split.to);
    return {
      ids: tasksWithTime(series, split.category).map(t => t.key).filter(key => !key.startsWith('worker:')),
      label: `${TIME_LABEL[split.category]} · ${new Date(split.from).toLocaleString()} – ${new Date(split.to).toLocaleString()}`,
    };
  }
  if (!filter) return null;
  const series = await loadFlowSeries(workspaceIds, windowOf(filter.from, filter.to), filter.to);
  const index = Math.floor((filter.at - series.window.from) / series.bucketMs);
  const start = filter.band === 'released' || filter.band === 'lost' ? filter.from : series.buckets[index].start;
  return {
    ids: tasksInBand(series, index, filter.band).map(t => t.key).filter(key => !key.startsWith('worker:')),
    label: `${BAND_LABEL[filter.band]} · ${new Date(start).toLocaleString()} – ${new Date(series.buckets[index].end).toLocaleString()}`,
  };
};
