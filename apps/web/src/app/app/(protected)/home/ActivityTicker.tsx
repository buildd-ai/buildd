/**
 * Home's TICKER: one glyph row per event (lib/home-ticker.ts), newest first.
 * The newest row is highlighted; a folded run of identical rows shows ×N.
 */
import Link from 'next/link';
import { Fragment } from 'react';
import type { TickerEvent, TickerKind } from '@/lib/home-ticker';

const GLYPH: Record<TickerKind, { char: string; cls: string; label: string }> = {
  claim: { char: '→|', cls: 'border-border-strong text-text-secondary', label: 'claimed' },
  pr: { char: '⇅', cls: 'border-border-strong text-text-secondary', label: 'pull request' },
  merged: { char: '✓', cls: 'border-status-success text-status-success', label: 'merged' },
  question: { char: '?', cls: 'border-status-warning bg-status-warning/15 text-status-warning', label: 'question' },
  failed: { char: '✕', cls: 'border-status-error text-status-error', label: 'failed' },
  mission: { char: '✓', cls: 'border-status-success bg-status-success text-[var(--card)]', label: 'mission done' },
};

function hhmm(ms: number, tz?: string | null): string {
  return new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(tz ? { timeZone: tz } : {}) });
}

/** A quiet stretch at least this long between two rows gets a divider. */
export const TICKER_GAP_MS = 60 * 60_000;

function gapLabel(ms: number): string {
  const h = Math.round(ms / 3_600_000);
  return h < 48 ? `${h}h earlier` : `${Math.round(h / 24)}d earlier`;
}

export function ActivityTicker({ events, timeZone }: { events: readonly TickerEvent[]; timeZone?: string | null }) {
  return (
    <section data-testid="home-activity-ticker" className="mb-8">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="section-label text-text-muted">Ticker</span>
        <Link href="/app/tasks" className="inline-flex min-h-11 items-center gap-1.5 font-mono text-[12px] text-text-muted hover:text-text-secondary md:min-h-0">
          <i aria-hidden="true" className="inline-block h-2 w-2 bg-accent" /> live · all events →
        </Link>
      </div>
      {events.length === 0 ? (
        <p className="font-mono text-[13px] text-text-secondary">No activity in the last few hours.</p>
      ) : (
        <ol data-testid="home-activity" className="card p-0">
          {events.map((e, i) => {
            const g = GLYPH[e.kind];
            const row = (
              <>
                <span className="w-11 shrink-0 font-mono text-[12px] tabular-nums text-text-muted">{hhmm(e.at, timeZone)}</span>
                <span aria-label={g.label} className={`grid h-[22px] w-[22px] shrink-0 place-items-center border font-mono text-[11px] font-bold ${g.cls}`}>{g.char}</span>
                <span className="w-[86px] shrink-0 truncate font-mono text-[13px] font-semibold text-text-primary">{e.label}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-text-secondary">{e.detail}</span>
                <span className="shrink-0 font-mono text-[12px] text-text-muted">
                  {e.count > 1 && <b className="mr-1.5 font-semibold text-text-secondary">×{e.count}</b>}
                  {e.right}
                </span>
              </>
            );
            const cls = `flex min-h-11 items-center gap-3 border-b border-border-default px-3.5 last:border-b-0 md:min-h-10 ${i === 0 ? 'bg-accent/10' : ''}`;
            // During a live burst a row from hours ago reads as part of it;
            // a divider says the stretch between them was quiet.
            const gap = i > 0 ? events[i - 1].at - e.at : 0;
            return (
              <Fragment key={e.id}>
                {gap >= TICKER_GAP_MS && (
                  <li data-testid="ticker-gap" className="flex items-center gap-3 border-b border-border-default bg-surface-2 px-3.5 py-1 font-mono text-[11px] uppercase tracking-[1px] text-text-muted">
                    <span aria-hidden="true" className="h-px flex-1 bg-border-default" />
                    {gapLabel(gap)}
                    <span aria-hidden="true" className="h-px flex-1 bg-border-default" />
                  </li>
                )}
                <li data-testid="ticker-row" data-kind={e.kind}>
                  {e.href ? <Link href={e.href} className={`${cls} hover:bg-surface-3`}>{row}</Link> : <div className={cls}>{row}</div>}
                </li>
              </Fragment>
            );
          })}
        </ol>
      )}
    </section>
  );
}
