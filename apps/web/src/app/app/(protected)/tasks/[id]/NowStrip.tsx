import type { NowState } from './task-activity';
import { collapseWorkspacePath, ageLabel } from './WorkerActivityTimeline';

/** Evidence markers distinguish weaker reports from observed facts. */
export function RunEvidenceRail({ evidence }: { evidence: NowState['evidence'] }) {
  return (
    <ol data-testid="run-evidence-rail" className="flex flex-wrap gap-x-5 gap-y-3 mt-4">
      {evidence.phases.filter(p => p.state !== 'skipped').map(p => {
        const weak = p.source === 'reported' || p.source === 'inferred';
        return (
          <li data-phase={p.key} data-state={p.state} data-source={p.source} key={p.key}
            aria-label={`${p.label}, ${p.state}, ${weak ? 'reported' : p.source}${p.subState ? `, ${p.subState}` : ''}`}
            className={`font-mono text-chip ${p.state === 'failed' ? 'text-status-error' : p.state === 'current' ? 'text-accent-text' : p.state === 'done' ? 'text-text-primary' : 'text-text-muted'}`}>
            <span aria-hidden="true" className={`inline-block w-3 h-3 mr-2 border-2 border-current ${p.state === 'done' && !weak ? 'bg-current' : ''} ${p.state === 'current' ? 'animate-status-pulse' : ''}`} />
            {p.label}{p.subState && <span className="block text-meta">{p.subState.replaceAll('_', ' ')}</span>}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The live hero: what the agent is doing right now, which lifecycle facts have been observed.
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
          <div className="flex items-center gap-2 font-mono text-chip uppercase tracking-[2px] font-semibold text-accent-text">
            <span className="w-[9px] h-[9px] bg-accent animate-status-pulse" aria-hidden="true" />
            Now
            {now.updatedTs != null && (
              <span className="font-normal tracking-[1px] text-text-muted" suppressHydrationWarning>
                · updated {ageLabel(nowMs - now.updatedTs)} ago
              </span>
            )}
          </div>
          <p className="mt-2 text-heading font-semibold leading-snug text-text-primary [overflow-wrap:anywhere]">
            {now.headline ? collapseWorkspacePath(now.headline) : 'Working…'}
          </p>
          {now.detail && (
            <p className="mt-1.5 font-mono text-meta text-text-secondary truncate">
              {now.detail.verb} <code className="text-text-primary">{collapseWorkspacePath(now.detail.target)}</code>
              {now.detail.recentEdits > 1 && ` · ${now.detail.recentEdits} edits in the last minute`}
            </p>
          )}
        </div>

      </div>
      <RunEvidenceRail evidence={now.evidence} />
    </section>
  );
}

/** Waiting-state stand-in for the Now strip: where the agent paused, dimmed. */
export function PausedBar({ evidence, elapsed, turns, tokens }: { evidence?: NowState['evidence']; elapsed: string | null; turns: number; tokens: string | null }) {
  return (
    <div data-testid="worker-paused-bar" className="border-2 border-border-default bg-surface-2 px-4 py-3 md:px-6 md:py-4">
      <div className="flex flex-wrap md:flex-nowrap items-center gap-x-4 gap-y-3">
        <span className="font-mono text-chip uppercase tracking-[2px] text-text-muted whitespace-nowrap">
          Paused
        </span>
        <span className="ml-auto font-mono text-chip uppercase tracking-[1.5px] text-text-muted whitespace-nowrap tabular-nums">
          {elapsed && <><b className="text-text-primary font-semibold">{elapsed}</b> · </>}
          {turns} turns
          {tokens && <span className="hidden md:inline"> · {tokens} tok</span>}
        </span>
      </div>
      {evidence && <RunEvidenceRail evidence={evidence} />}
    </div>
  );
}
