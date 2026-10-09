'use client';

import { useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { FlowSeries, FlowWindow } from '@/lib/insights-flow';
import { FLOW_WINDOWS } from '@/lib/insights-flow';
import { FlowChart } from '@/components/insights/FlowChart';
import Link from 'next/link';
import { InsightsStats } from '@/components/insights/InsightsStats';
import Segmented from '@/components/ui/Segmented';

interface Props {
  series: FlowSeries & { truncated: boolean };
  window: FlowWindow;
}

export function InsightsClient({ series, window }: Props) {
  const { headline } = series;
  const empty = series.tasks.length === 0;

  return (
    <div className="max-w-2xl mx-auto px-4 pt-14 pb-24 md:pt-6" data-testid="insights-page">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="hidden md:block text-heading font-bold">Insights</h1>

        </div>
        <WindowPicker window={window} />
      </div>

      <div className="mt-5">
        <InsightsStats headline={headline} />
      </div>

      <section className="mt-5 card p-4">
        <h2 className="text-title font-semibold">Tasks by stage over time</h2>
        <div className="mt-3">
          {empty ? (
            <p className="py-8 text-center text-body text-text-muted" data-testid="insights-empty">No agent work in this window.</p>
          ) : (
            <FlowChart series={series} taskHref={key => `/app/tasks/${key}`} />
          )}
        </div>
        {series.truncated && (
          <p className="mt-2 text-meta text-status-warning">Partial window</p>
        )}
      </section>

      {/* Cost by billing basis lives on Usage, once. */}
      <p className="mt-5 text-meta text-text-muted">
        <Link href="/app/health/usage" data-testid="insights-cost-link" className="text-text-secondary hover:underline">Costs and usage by role are on Usage ›</Link>
      </p>


    </div>
  );
}

function WindowPicker({ window: current }: { window: FlowWindow }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const select = (value: FlowWindow) => {
    if (value === current) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set('window', value);
    startTransition(() => router.replace(`${pathname}?${params.toString()}`, { scroll: false }));
  };
  return (
    <div data-testid="insights-window-picker" className={`shrink-0 ${pending ? 'opacity-60' : ''}`}>
      <Segmented label="Window" items={FLOW_WINDOWS.map(value => ({ value, label: value }))} value={current} onChange={select} />
    </div>
  );
}
