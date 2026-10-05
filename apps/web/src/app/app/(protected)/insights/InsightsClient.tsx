'use client';

import { useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { FlowSeries, FlowWindow } from '@/lib/insights-flow';
import { FLOW_WINDOWS } from '@/lib/insights-flow';
import { FlowChart } from '@/components/insights/FlowChart';
import { formatDuration, formatHours, formatShare, roleHours } from '@/components/insights/flow-chart-model';

interface Props {
  series: FlowSeries & { truncated: boolean };
  window: FlowWindow;
}

export function InsightsClient({ series, window }: Props) {
  const { headline } = series;
  const roles = roleHours(series);
  const maxRole = Math.max(1e-9, ...roles.map(r => r.hours));
  const empty = series.tasks.length === 0;
  const settled = headline.shippedHours + headline.lostHours;

  return (
    <div className="max-w-3xl mx-auto px-4 pt-4 pb-24 md:pt-6" data-testid="insights-page">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <a href="/app/health" className="text-meta text-text-muted hover:text-text-secondary">← Health</a>
          <h1 className="text-heading font-bold">Insights</h1>
          <p className="mt-1 text-lede text-text-secondary">How your agents&apos; work moved to production.</p>
        </div>
        <WindowPicker window={window} />
      </div>

      {/* Headline: the one number, then the two that explain it. */}
      <section className="mt-5 card p-4" data-testid="insights-headline">
        <div className="text-eyebrow font-bold uppercase tracking-[2px] text-text-muted">Agent time that shipped</div>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-6 gap-y-2">
          <span className="text-display font-bold text-text-primary">{formatShare(headline.shippedShare)}</span>
          <span className="text-body text-text-secondary">
            {headline.shippedTasks} {headline.shippedTasks === 1 ? 'task' : 'tasks'} shipped
            {headline.releases > 0 && <> in {headline.releases} {headline.releases === 1 ? 'release' : 'releases'}</>}
            {headline.medianStartToProdMs != null && <> · median {formatDuration(headline.medianStartToProdMs)} from first agent start to production</>}
          </span>
        </div>
        <p className="mt-2 text-meta text-text-muted">
          {settled > 0
            ? `${formatHours(headline.shippedHours)} of agent time reached production; ${formatHours(headline.lostHours)} went into work that failed or was abandoned. Still in flight: ${formatHours(headline.inFlightHours)}. Research, review and planning without a PR (${formatHours(headline.otherHours)}) are left out.`
            : 'Nothing finished in this window yet, so there is no share to show.'}
        </p>
      </section>

      <section className="mt-5 card p-4">
        <h2 className="text-title font-semibold">Tasks by stage over time</h2>
        <p className="mt-0.5 text-meta text-text-muted">Tap a band to see the tasks in it. Releases are the marks along the top.</p>
        <div className="mt-3">
          {empty ? (
            <p className="py-8 text-center text-body text-text-muted" data-testid="insights-empty">No agent work in this window.</p>
          ) : (
            <FlowChart series={series} taskHref={key => `/app/tasks/${key}`} />
          )}
        </div>
        {series.truncated && (
          <p className="mt-2 text-meta text-status-warning">Busy window: only the newest work is counted, so totals are a floor.</p>
        )}
      </section>

      {roles.length > 0 && (
        <section className="mt-5 card p-4" data-testid="insights-roles">
          <h2 className="text-title font-semibold">Agent time by role</h2>
          <ul className="mt-3 space-y-2">
            {roles.map(r => (
              <li key={r.role} className="grid grid-cols-[7rem_1fr_3.5rem] items-center gap-3 text-meta">
                <span className="text-text-secondary truncate">{r.role}</span>
                <span className="h-2 bg-surface-3" aria-hidden>
                  <span className="block h-2" style={{ width: `${(r.hours / maxRole) * 100}%`, background: 'var(--flow-running)' }} />
                </span>
                <span className="text-right text-text-primary" style={{ fontVariantNumeric: 'tabular-nums' }}>{formatHours(r.hours)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="mt-5 text-meta text-text-muted">
        &ldquo;Needs input&rdquo; counts open questions now. Earlier waits show as running.
      </p>
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
