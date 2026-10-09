'use client';

import { useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { FlowSeries, FlowWindow } from '@/lib/insights-flow';
import { FLOW_WINDOWS } from '@/lib/insights-flow';
import { FlowChart } from '@/components/insights/FlowChart';
import { formatHours } from '@/components/insights/flow-chart-model';
import Link from 'next/link';
import { usageByRole } from '@/components/insights/usage-model';
import { InsightsStats } from '@/components/insights/InsightsStats';
import Segmented from '@/components/ui/Segmented';

interface Props {
  series: FlowSeries & { truncated: boolean };
  window: FlowWindow;
}

export function InsightsClient({ series, window }: Props) {
  const { headline } = series;
  const [measure, setMeasure] = useState<'tokens' | 'hours'>('tokens');
  const roles = usageByRole(series.usage ?? []).sort((a, b) => b[measure] - a[measure] || a.role.localeCompare(b.role));
  const maxRole = Math.max(1, ...roles.map(r => r[measure]));
  const formatTokens = (n: number) => n.toLocaleString();
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
        <Link href="/app/health/usage" data-testid="insights-cost-link" className="text-text-secondary hover:underline">Cost by billing basis is on Usage ›</Link>
      </p>

      {roles.length > 0 && (
        <section className="mt-5 card p-4" data-testid="insights-roles">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-title font-semibold">Usage by role</h2>
            <Segmented label="Usage measure" items={[{ value: 'tokens', label: 'Tokens' }, { value: 'hours', label: 'Time' }]} value={measure} onChange={setMeasure} />
          </div>
          <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto_4rem_4rem] gap-2 text-meta text-text-muted"><span>Role / tier</span><span className="text-right">{measure === 'tokens' ? 'Tokens' : 'Time'}</span><span className="text-right">Real ($)</span><span className="text-right">Plan ($)</span></div>
          <ul className="mt-2 space-y-4">
            {roles.map(r => (
              <li key={r.role} className="text-meta">
                <div className="grid grid-cols-[minmax(0,1fr)_auto_4rem_4rem] gap-2 font-semibold"><span className="break-words">{r.role}</span><span className="text-right">{measure === 'tokens' ? formatTokens(r.tokens) : formatHours(r.hours)}</span><span className="text-right">${r.realUsd.toFixed(2)}</span><span className="text-right">${r.virtualUsd.toFixed(2)}</span></div>
                <div className="mt-1 h-2 bg-surface-3" aria-hidden><span className="block h-2" style={{ width: `${r[measure] / maxRole * 100}%`, background: 'var(--flow-running)' }} /></div>
                <ul className="mt-2 space-y-1 text-text-secondary">
                  {r.tiers.map(t => <li key={t.tier} className="grid grid-cols-[minmax(0,1fr)_auto_4rem_4rem] gap-2"><span className="break-words">{t.tier}</span><span className="text-right">{measure === 'tokens' ? formatTokens(t.tokens) : formatHours(t.hours)}</span><span className="text-right">${t.realUsd.toFixed(2)}</span><span className="text-right">${t.virtualUsd.toFixed(2)}</span></li>)}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      )}
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
