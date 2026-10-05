/**
 * The Insights headline as Home's stat strip: one cell per number, label above,
 * value, one short line below. Built from the series headline only.
 */
import type { FlowSeries } from '@/lib/insights-flow';
import { formatDuration, formatHours, formatShare } from './flow-chart-model';

export interface InsightsStat {
  id: string;
  label: string;
  value: string;
  detail: string;
}

/** The cells, in order. Pure so the set is tested without a DOM. */
export function insightsStats(headline: FlowSeries['headline']): InsightsStat[] {
  const settled = headline.shippedHours + headline.lostHours;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return [
    {
      id: 'shipped-share',
      label: 'Time shipped',
      value: settled > 0 ? formatShare(headline.shippedShare) : 'None',
      detail: settled > 0 ? `${formatHours(headline.shippedHours)} of ${formatHours(settled)}` : 'no finished work',
    },
    {
      id: 'tasks-shipped',
      label: 'Tasks shipped',
      value: String(headline.shippedTasks),
      detail: headline.releases > 0 ? `in ${plural(headline.releases, 'release', 'releases')}` : 'no releases',
    },
    {
      id: 'to-production',
      label: 'To production',
      value: headline.medianStartToProdMs != null ? formatDuration(headline.medianStartToProdMs) : 'None',
      detail: 'median to release',
    },
    {
      id: 'lost',
      label: 'Lost',
      value: formatHours(headline.lostHours),
      detail: 'failed or abandoned',
    },
  ];
}

export function InsightsStats({ headline }: { headline: FlowSeries['headline'] }) {
  const stats = insightsStats(headline);
  return (
    <section
      data-testid="insights-headline"
      className="card grid grid-cols-2 md:grid-cols-4 md:divide-x divide-border-default [&>*:nth-child(-n+2)]:border-b [&>*:nth-child(-n+2)]:border-border-default md:[&>*:nth-child(-n+2)]:border-b-0"
    >
      {stats.map(s => (
        <div key={s.id} data-testid={`insights-stat-${s.id}`} className="flex min-w-0 flex-col gap-1 px-4 py-3.5 md:px-5 md:py-4">
          <span className="text-eyebrow font-bold uppercase tracking-[2px] text-text-muted">{s.label}</span>
          <span className="text-display font-semibold text-text-primary" style={{ fontVariantNumeric: 'tabular-nums' }}>{s.value}</span>
          <span className="truncate text-meta text-text-muted">{s.detail}</span>
        </div>
      ))}
    </section>
  );
}
