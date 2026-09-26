import type { NowState } from './task-activity';
import { collapseWorkspacePath, ageLabel } from './WorkerActivityTimeline';

const CELLS = 40;

/** The segmented progress bar: `pct` of 40 cells filled, the leading cell pulsing while live. */
export function ProgressCells({ pct, mode, className = '' }: { pct: number | null; mode: 'live' | 'paused'; className?: string }) {
  const filled = pct == null ? 0 : Math.max(0, Math.min(CELLS, Math.round((pct / 100) * CELLS)));
  return (
    <div
      data-testid="worker-progress-bar"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct ?? undefined}
      className={`grid gap-[3px] ${className}`}
      style={{ gridTemplateColumns: `repeat(${CELLS}, minmax(0, 1fr))` }}
    >
      {Array.from({ length: CELLS }, (_, i) => {
        const on = i < filled;
        const head = mode === 'live' && i === filled - 1;
        const cls = on
          ? mode === 'paused' ? 'bg-text-secondary' : `bg-accent${head ? ' animate-status-pulse' : ''}`
          : 'bg-surface-4';
        return <span key={i} className={`h-[14px] ${cls}`} />;
      })}
    </div>
  );
}

function StepRail({ steps }: { steps: NowState['steps'] }) {
  return (
    <ol data-testid="worker-step-rail" className="grid grid-cols-6 mt-4">
      {steps.map((s, i) => (
        <li
          key={s.key}
          data-state={s.state}
          className={`relative pt-[18px] font-mono text-[11px] md:text-[10px] uppercase tracking-[1.5px] font-medium ${
            s.state === 'done' ? 'text-text-primary' : s.state === 'current' ? 'text-accent-text' : 'text-text-muted'
          }`}
        >
          {i < steps.length - 1 && (
            <span
              aria-hidden="true"
              className={`absolute top-[5px] left-[14px] right-0 h-[2px] ${s.state === 'done' ? 'bg-text-primary' : 'bg-border-default'}`}
            />
          )}
          <span
            aria-hidden="true"
            className={`absolute top-0 left-0 w-3 h-3 border-2 ${
              s.state === 'done'
                ? 'bg-text-primary border-text-primary'
                : s.state === 'current'
                  ? 'bg-accent border-accent animate-status-pulse'
                  : 'bg-card border-border-strong'
            }`}
          />
          {s.label}
          <span className="block mt-0.5 font-normal tracking-normal normal-case text-[11px] text-text-muted tabular-nums">
            {s.at ?? (s.state === 'current' ? 'next' : '—')}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * The live hero: what the agent is doing right now, how far along it says it
 * is (the latest progress milestone), and where it is in the
 * started → read → edit → commit → PR → done arc.
 */
export default function NowStrip({ now, nowMs }: { now: NowState; nowMs: number }) {
  return (
    <section
      data-testid="worker-now-strip"
      className="relative bg-card border-2 border-border-strong shadow-[var(--card-shadow)] pl-5 pr-4 py-4 md:pl-8 md:pr-6 md:py-5"
    >
      <span aria-hidden="true" className="absolute left-0 top-0 bottom-0 w-[6px] bg-accent" />
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1" data-testid="worker-current-action">
          <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[2px] font-semibold text-accent-text">
            <span className="w-[9px] h-[9px] bg-accent animate-status-pulse" aria-hidden="true" />
            Now
            {now.updatedTs != null && (
              <span className="font-normal tracking-[1px] text-text-muted" suppressHydrationWarning>
                · updated {ageLabel(nowMs - now.updatedTs)} ago
              </span>
            )}
          </div>
          <p className="mt-2 text-[17px] md:text-[21px] font-semibold leading-snug text-text-primary [overflow-wrap:anywhere]">
            {now.headline ? collapseWorkspacePath(now.headline) : 'Working…'}
          </p>
          {now.detail && (
            <p className="mt-1.5 font-mono text-[12px] text-text-secondary truncate">
              {now.detail.verb} <code className="text-text-primary">{collapseWorkspacePath(now.detail.target)}</code>
              {now.detail.recentEdits > 1 && ` · ${now.detail.recentEdits} edits in the last minute`}
            </p>
          )}
        </div>
        {now.pct != null && (
          <div data-testid="worker-now-pct" className="shrink-0 font-mono font-semibold leading-none tracking-[-1px] text-[34px] md:text-[44px] tabular-nums">
            {now.pct}
            <sup className="text-[16px] md:text-[18px] text-text-muted font-medium align-top ml-0.5">%</sup>
          </div>
        )}
      </div>
      <ProgressCells pct={now.pct} mode="live" className="mt-4 md:mt-5" />
      <StepRail steps={now.steps} />
    </section>
  );
}

/** Waiting-state stand-in for the Now strip: where the agent paused, dimmed. */
export function PausedBar({ pct, elapsed, turns, tokens }: { pct: number | null; elapsed: string | null; turns: number; tokens: string | null }) {
  return (
    <div data-testid="worker-paused-bar" className="border-2 border-border-default bg-surface-2 px-4 py-3 md:px-6 md:py-4">
      <div className="flex flex-wrap md:flex-nowrap items-center gap-x-4 gap-y-3">
        <span className="font-mono text-[11px] uppercase tracking-[2px] text-text-muted whitespace-nowrap">
          Paused at <b className="text-text-primary font-semibold">{pct != null ? `${pct}%` : '—'}</b>
        </span>
        <ProgressCells pct={pct} mode="paused" className="order-last md:order-none basis-full md:basis-auto md:flex-1" />
        <span className="ml-auto font-mono text-[11px] uppercase tracking-[1.5px] text-text-muted whitespace-nowrap tabular-nums">
          {elapsed && <><b className="text-text-primary font-semibold">{elapsed}</b> · </>}
          {turns} turns
          {tokens && <span className="hidden md:inline"> · {tokens} tok</span>}
        </span>
      </div>
    </div>
  );
}
