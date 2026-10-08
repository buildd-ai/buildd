'use client';

import type { NowState } from './task-activity';
import { useEffect, useRef, useState } from 'react';
import Disclosure from '@/components/ui/Disclosure';
import { collapseWorkspacePath, ageLabel } from './WorkerActivityTimeline';

type Phase = NowState['evidence']['phases'][number];

const isWeak = (p: Phase) => p.source === 'reported' || p.source === 'inferred';

const phaseTone = (p: Phase) =>
  p.state === 'failed' ? 'text-status-error' : p.state === 'current' ? 'text-accent-text' : p.state === 'done' ? 'text-text-primary' : 'text-text-muted';

const phaseName = (p: Phase) =>
  `${p.label}, ${p.state}, ${isWeak(p) ? 'reported' : p.source}${p.subState ? `, ${p.subState}` : ''}`;

/** The phase the run is at: the live one, else the last failed or done one. */
export function headPhase(phases: readonly Phase[]): { phase: Phase; index: number } | null {
  let i = phases.findIndex(p => p.state === 'current');
  if (i < 0) i = phases.findLastIndex(p => p.state === 'failed');
  if (i < 0) i = phases.findLastIndex(p => p.state === 'done');
  return i < 0 ? null : { phase: phases[i], index: i };
}

/**
 * One cell per phase, told apart by fill and pattern, not colour alone (the
 * settled ghost rule: in-flight work is hatched, never a fake fill):
 * done = solid, reported/inferred done = outline + light hatch, current =
 * hatched, failed = solid with a cross, todo = outline, unknown = dashed outline.
 */
function PhaseCell({ p }: { p: Phase }) {
  const base = 'relative flex-1 min-w-2 h-3 border-2';
  const look =
    p.state === 'failed' ? 'border-status-error bg-status-error'
    : p.state === 'current' ? 'border-accent fleet-hatch-accent'
    : p.state === 'done' ? (isWeak(p) ? 'border-text-primary fleet-hatch' : 'border-text-primary bg-text-primary')
    : p.state === 'unknown' ? 'border-dashed border-border-strong'
    : 'border-border-strong';
  return (
    <span data-cell={p.key} data-state={p.state} className={`${base} ${look}`}>
      {p.state === 'failed' && (
        <span className="absolute inset-0 flex items-center justify-center font-mono text-chip leading-none text-surface-1">×</span>
      )}
    </span>
  );
}

/**
 * Lifecycle evidence. md+ is a horizontal labelled rail; below md nine labelled
 * columns cannot fit in ~290px, so it is one line (current phase, n of m), a
 * segment row and a 44px disclosure that opens the labelled list with times.
 * Evidence markers distinguish weaker reports from observed facts.
 */
export function RunEvidenceRail({ evidence, nowMs }: { evidence: NowState['evidence']; nowMs?: number }) {
  const phases = evidence.phases.filter(p => p.state !== 'skipped');
  const head = headPhase(phases);
  return (
    <>
      <div data-testid="run-evidence-compact" className="md:hidden mt-3">
        <Disclosure
          summary={
            <span className="flex flex-col gap-2">
              <span data-testid="run-evidence-head" className="font-mono text-chip uppercase tracking-[1.5px] text-text-secondary truncate">
                {head ? (
                  <><b className={`font-semibold ${phaseTone(head.phase)}`}>{head.phase.label}{head.phase.subState ? ` (${head.phase.subState.replaceAll('_', ' ')})` : ''}</b> · {head.index + 1} of {phases.length}</>
                ) : (
                  <>No evidence yet · {phases.length} phases</>
                )}
              </span>
              <span aria-hidden="true" className="flex gap-1">
                {phases.map(p => <PhaseCell key={p.key} p={p} />)}
              </span>
            </span>
          }
        >
          <ol data-testid="run-evidence-list" className="mt-1 border-l-2 border-border-default">
            {phases.map(p => (
              <li key={p.key} data-phase={p.key} data-state={p.state} data-source={p.source} aria-label={phaseName(p)}
                className={`flex min-h-11 items-center gap-3 pl-3 font-mono text-chip ${phaseTone(p)}`}>
                <span aria-hidden="true" className={`inline-block w-3 h-3 shrink-0 border-2 border-current ${p.state === 'done' && !isWeak(p) ? 'bg-current' : ''} ${p.state === 'current' ? 'animate-status-pulse' : ''}`} />
                <span className="min-w-0 flex-1 truncate">
                  {p.label}
                  {p.subState && <span className="text-text-secondary"> · {p.subState.replaceAll('_', ' ')}</span>}
                  {isWeak(p) && <span className="text-text-muted"> · reported</span>}
                </span>
                <span className="shrink-0 tabular-nums text-text-muted" suppressHydrationWarning>
                  {p.at != null && nowMs != null ? `${ageLabel(nowMs - p.at)} ago` : p.state === 'unknown' ? 'not seen' : ''}
                </span>
              </li>
            ))}
          </ol>
        </Disclosure>
      </div>
      <ol data-testid="run-evidence-rail" className="hidden md:flex flex-wrap gap-x-5 gap-y-3 mt-4">
        {phases.map(p => (
          <li data-phase={p.key} data-state={p.state} data-source={p.source} key={p.key}
            aria-label={phaseName(p)}
            className={`font-mono text-chip ${phaseTone(p)}`}>
            <span aria-hidden="true" className={`inline-block w-3 h-3 mr-2 border-2 border-current ${p.state === 'done' && !isWeak(p) ? 'bg-current' : ''} ${p.state === 'current' ? 'animate-status-pulse' : ''}`} />
            {p.label}{p.subState && <span className="block text-meta">{p.subState.replaceAll('_', ' ')}</span>}
          </li>
        ))}
      </ol>
    </>
  );
}

/** The narration headline: wraps anywhere, three lines at most until "more". */
function Headline({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [clipped, setClipped] = useState(false);
  const [full, setFull] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (el && !full) setClipped(el.scrollHeight > el.clientHeight + 1);
  }, [text, full]);
  return (
    <>
      <p ref={ref} data-testid="worker-now-headline"
        className={`mt-2 text-heading font-semibold leading-snug text-text-primary [overflow-wrap:anywhere] ${full ? '' : 'line-clamp-3'}`}>
        {text}
      </p>
      {(clipped || full) && (
        <button type="button" onClick={() => setFull(f => !f)} aria-expanded={full}
          className="min-h-11 md:min-h-0 md:mt-1 font-mono text-chip uppercase tracking-[1.5px] text-text-secondary hover:text-text-primary">
          {full ? 'less' : 'more'}
        </button>
      )}
    </>
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
          <Headline text={now.headline ? collapseWorkspacePath(now.headline) : 'Working…'} />
          {now.detail && (
            <p className="mt-1.5 font-mono text-meta text-text-secondary truncate">
              {now.detail.verb} <code className="text-text-primary">{collapseWorkspacePath(now.detail.target)}</code>
              {now.detail.recentEdits > 1 && ` · ${now.detail.recentEdits} edits in the last minute`}
            </p>
          )}
        </div>

      </div>
      <RunEvidenceRail evidence={now.evidence} nowMs={nowMs} />
    </section>
  );
}

/** Waiting-state stand-in for the Now strip: where the agent paused, dimmed. */
export function PausedBar({ evidence, elapsed, turns, tokens, nowMs }: { evidence?: NowState['evidence']; elapsed: string | null; turns: number; tokens: string | null; nowMs?: number }) {
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
      {evidence && <RunEvidenceRail evidence={evidence} nowMs={nowMs} />}
    </div>
  );
}
