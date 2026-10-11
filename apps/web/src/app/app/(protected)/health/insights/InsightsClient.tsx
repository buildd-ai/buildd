'use client';

import { useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { FlowSeries, FlowWindow } from '@/lib/insights-flow';
import { FLOW_WINDOWS } from '@/lib/insights-flow';
import Link from 'next/link';
import { ShippedChart } from '@/components/insights/ShippedChart';
import { dayBars, shippingSentence, stallSentences, timeRows } from '@/components/insights/insights-summary';
import { formatDuration, formatShare } from '@/components/insights/flow-chart-model';
import { countOf } from '@/lib/plural';
import Segmented from '@/components/ui/Segmented';

interface Props {
  series: FlowSeries & { truncated: boolean };
  window: FlowWindow;
}

/** Insights in words first: is the team shipping more, and what slowed work down. */
export function InsightsClient({ series, window }: Props) {
  const empty = series.tasks.length === 0;
  const rows = timeRows(series);
  const stalls = stallSentences(series);

  return (
    <div className="max-w-2xl mx-auto px-4 pt-14 pb-24 md:pt-6" data-testid="insights-page">
      <div className="flex items-start justify-between gap-3">
        <h1 className="hidden md:block text-heading font-bold">Insights</h1>
        <div className="ml-auto"><WindowPicker window={window} /></div>
      </div>

      {empty ? (
        <p className="mt-6 py-8 text-center text-body text-text-muted" data-testid="insights-empty">No agent work in this window.</p>
      ) : (
        <>
          <section className="mt-5" data-testid="insights-shipping">
            <h2 className="section-label">Shipping</h2>
            <p className="mt-2 text-lede text-text-primary" data-testid="insights-shipping-sentence">{shippingSentence(series, window)}</p>
            <div className="mt-4">
              <ShippedChart days={dayBars(series, window)} previousLabel={window === '7d' ? 'Last week' : 'The 30 days before'} />
            </div>
          </section>

          <section className="mt-8" data-testid="insights-time">
            <h2 className="section-label">What slowed work down</h2>
            {stalls.length > 0 && (
              <ul className="mt-2 space-y-1 text-body text-text-primary" data-testid="insights-stalls">
                {stalls.map(s => <li key={s}>{s}</li>)}
              </ul>
            )}
            <ul className="mt-4 divide-y divide-border-default border-y border-border-default">
              {rows.map(r => {
                const body = (
                  <>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className={`text-body ${r.ms > 0 ? 'text-text-primary' : 'text-text-muted'}`}>{r.label}</span>
                      <span className="shrink-0 font-mono text-meta text-text-secondary">{r.ms > 0 ? `${formatDuration(r.ms)} · ${formatShare(r.share)}` : '0h'}</span>
                    </div>
                    <div className="mt-1.5 h-2 bg-surface-3" aria-hidden>
                      <span className="block h-2" style={{ width: `${r.share * 100}%`, background: 'var(--flow-running)' }} />
                    </div>
                    {r.tasks > 0 && <p className="mt-1 text-meta text-text-muted">{countOf(r.tasks, 'task')} ›</p>}
                  </>
                );
                return (
                  <li key={r.category} data-testid={`insights-time-${r.category}`}>
                    {r.tasks > 0
                      ? <Link href={r.href} className="block py-3 min-h-[44px] hover:bg-surface-2">{body}</Link>
                      : <div className="py-3">{body}</div>}
                  </li>
                );
              })}
            </ul>
          </section>
        </>
      )}

      {series.truncated && <p className="mt-2 text-meta text-status-warning">Partial window</p>}

      {/* Cost by billing basis lives on Usage, once. */}
      <p className="mt-6 text-meta text-text-muted">
        <Link href="/app/health/usage" data-testid="insights-cost-link" className="text-text-secondary hover:underline">Costs and usage by agent are on Usage ›</Link>
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
