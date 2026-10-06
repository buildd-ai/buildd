'use client';

import { useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { FlowSeries, FlowWindow } from '@/lib/insights-flow';
import { FLOW_WINDOWS } from '@/lib/insights-flow';
import { FlowChart } from '@/components/insights/FlowChart';
import { formatHours } from '@/components/insights/flow-chart-model';
import { usageByRole } from '@/components/insights/usage-model';
import { InsightsStats } from '@/components/insights/InsightsStats';

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
    <div className="max-w-3xl mx-auto px-4 pt-14 pb-24 md:pt-6" data-testid="insights-page">
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

      {roles.length > 0 && (
        <section className="mt-5 card p-4" data-testid="insights-roles">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-title font-semibold">Usage by role</h2>
            <div role="group" aria-label="Usage measure" className="flex">
              {(['tokens', 'hours'] as const).map(m => <button key={m} className="btn min-h-[44px] text-meta" aria-pressed={measure === m} onClick={() => setMeasure(m)}>{m === 'tokens' ? 'Tokens' : 'Time'}</button>)}
            </div>
          </div>
          <div className="mt-3 grid grid-cols-[minmax(0,1fr)_auto_4.5rem] gap-2 text-meta text-text-muted"><span>Role / tier</span><span className="text-right">{measure === 'tokens' ? 'Tokens' : 'Time'}</span><span className="text-right">Cost ($)</span></div>
          <ul className="mt-2 space-y-4">
            {roles.map(r => (
              <li key={r.role} className="text-meta">
                <div className="grid grid-cols-[minmax(0,1fr)_auto_4.5rem] gap-2 font-semibold"><span className="break-words">{r.role}</span><span className="text-right">{measure === 'tokens' ? formatTokens(r.tokens) : formatHours(r.hours)}</span><span className="text-right">${r.costUsd.toFixed(2)}</span></div>
                <div className="mt-1 h-2 bg-surface-3" aria-hidden><span className="block h-2" style={{ width: `${r[measure] / maxRole * 100}%`, background: 'var(--flow-running)' }} /></div>
                <ul className="mt-2 space-y-1 text-text-secondary">
                  {r.tiers.map(t => <li key={t.tier} className="grid grid-cols-[minmax(0,1fr)_auto_4.5rem] gap-2"><span className="break-words">{t.tier}</span><span className="text-right">{measure === 'tokens' ? formatTokens(t.tokens) : formatHours(t.hours)}</span><span className="text-right">${t.costUsd.toFixed(2)}</span></li>)}
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
  return (
    <div role="group" aria-label="Window" data-testid="insights-window-picker" className={`flex shrink-0 border-2 border-border-strong bg-surface-2 ${pending ? 'opacity-60' : ''}`}>
      {FLOW_WINDOWS.map(value => (
        <button
          key={value}
          type="button"
          aria-pressed={current === value}
          onClick={() => {
            if (value === current) return;
            const params = new URLSearchParams(searchParams.toString());
            params.set('window', value);
            startTransition(() => router.replace(`${pathname}?${params.toString()}`, { scroll: false }));
          }}
          className={`px-3 min-h-[44px] md:min-h-[28px] text-chip uppercase tracking-widest ${current === value ? 'bg-surface-3 text-text-primary' : 'text-text-muted hover:text-text-secondary'}`}
        >
          {value}
        </button>
      ))}
    </div>
  );
}
