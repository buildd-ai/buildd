'use client';

import type { NowState } from './task-activity';
import { useEffect, useRef, useState } from 'react';
import Disclosure from '@/components/ui/Disclosure';
import Lifecycle from '@/components/ui/Lifecycle';
import type { StateKey } from '@/components/ui/states';
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
 * The run's evidence read as a state on the one Build → Verify → Deliver track.
 * The phases stay the evidence (behind the disclosure); this only says which
 * step they add up to. `paused` is the waiting-on-an-answer bar.
 */
export function runLifecycleState(phases: readonly Phase[], { paused = false }: { paused?: boolean } = {}): StateKey {
  const at = (key: string) => phases.find(p => p.key === key);
  const merged = at('merged');
  const delivered = at('delivered');
  const pr = at('pr_open');
  const ci = at('ci');
  const review = at('review');
  if (merged?.state === 'done' || delivered?.state === 'done') return 'landed';
  if (pr?.state === 'failed') return 'not_landed';
  if (review?.state === 'failed') {
    return review.subState === 'escalated' ? 'needs_you' : review.subState === 'review_failed' ? 'recovering' : 'fixing';
  }
  if (ci?.state === 'failed' && ci.subState === 'failed') return 'ci_failed';
  if (review?.state === 'done') return 'landing';
  if (pr?.state === 'done') return paused ? 'needs_you' : 'review';
  return paused ? 'waiting' : 'running';
}

type MarkerKind = 'done' | 'reported' | 'current' | 'failed' | 'todo' | 'unknown';

const markerKind = (p: Phase): MarkerKind =>
  p.state === 'done' ? (isWeak(p) ? 'reported' : 'done') : p.state === 'skipped' ? 'todo' : p.state;

/**
 * One shape per kind, so the list reads without colour: solid (done), framed
 * with an inner fill (reported), haloed (live), crossed (failed, the ⊠ glyph),
 * outline (not yet), dashed (not seen). 12px cells on the 3px cell radius.
 */
const MARKER: Record<MarkerKind, string> = {
  done: 'bg-status-success',
  reported: 'ring-1 ring-inset ring-status-success',
  current: 'bg-status-running ring-[3px] ring-primary-ring animate-status-pulse motion-reduce:animate-none',
  failed: 'ring-1 ring-inset ring-status-error',
  todo: 'ring-1 ring-inset ring-[var(--faint)]',
  unknown: 'border border-dashed border-[var(--faint)]',
};

function EvidenceMarker({ kind }: { kind: MarkerKind }) {
  return (
    <span aria-hidden="true" data-testid="run-evidence-marker" data-kind={kind}
      className={`relative z-10 block justify-self-center w-3 h-3 rounded-sm bg-card ${MARKER[kind]}`}>
      {kind === 'reported' && <span className="absolute inset-[3px] bg-status-success" />}
      {kind === 'failed' && (
        <>
          <span className="absolute left-1/2 top-0.5 bottom-0.5 w-px -translate-x-1/2 rotate-45 bg-status-error" />
          <span className="absolute left-1/2 top-0.5 bottom-0.5 w-px -translate-x-1/2 -rotate-45 bg-status-error" />
        </>
      )}
    </span>
  );
}

/**
 * Where the run is: the one `Lifecycle` track, then the labelled phase list
 * with times behind a 44px disclosure (closed by default, at every width).
 * The list is a timeline: a 1px connector through one marker per phase.
 * Markers distinguish weaker reports from observed facts; a phase with no
 * evidence says "not seen". Rows are not tap targets, so they stay compact.
 */
export function RunEvidenceRail({ evidence, nowMs, paused = false, defaultOpen = false }: { evidence: NowState['evidence']; nowMs?: number; paused?: boolean; defaultOpen?: boolean }) {
  const phases = evidence.phases.filter(p => p.state !== 'skipped');
  const head = headPhase(phases);
  return (
    <div data-testid="run-evidence-rail" className="mt-3 flex flex-col gap-1">
      <Lifecycle state={runLifecycleState(phases, { paused })} />
      <Disclosure
        defaultOpen={defaultOpen}
        summary={
          <span data-testid="run-evidence-head" className="font-mono text-meta text-text-secondary truncate">
            Run evidence · {head ? (
              <><b className={`font-semibold ${phaseTone(head.phase)}`}>{head.phase.label}{head.phase.subState ? ` (${head.phase.subState.replaceAll('_', ' ')})` : ''}</b> · step {head.index + 1} of {phases.length}</>
            ) : (
              <>none yet · {phases.length} phases</>
            )}
          </span>
        }
      >
        <ol data-testid="run-evidence-list" className="mb-1">
          {phases.map((p, i) => (
            <li key={p.key} data-phase={p.key} data-state={p.state} data-source={p.source} aria-label={phaseName(p)}
              aria-current={p.state === 'current' ? 'step' : undefined}
              className={`relative grid grid-cols-[16px_minmax(0,1fr)_auto] min-h-8 items-center gap-x-2.5 py-1 font-mono text-meta ${phaseTone(p)}`}>
              <span aria-hidden="true" data-testid="run-evidence-connector"
                className={`absolute left-[7.5px] w-px bg-border-strong ${i === 0 ? 'top-1/2' : 'top-0'} ${i === phases.length - 1 ? 'bottom-1/2' : 'bottom-0'}`} />
              <EvidenceMarker kind={markerKind(p)} />
              <span className={`truncate ${p.state === 'current' ? 'font-semibold' : ''}`}>
                {p.label}
                {p.subState && <span className="font-normal text-text-secondary"> · {p.subState.replaceAll('_', ' ')}</span>}
                {isWeak(p) && <span className="text-text-muted"> · reported</span>}
              </span>
              <span className="tabular-nums text-right text-text-muted" suppressHydrationWarning>
                {p.at != null && nowMs != null ? `${ageLabel(nowMs - p.at)} ago` : p.state === 'unknown' ? 'not seen' : ''}
              </span>
            </li>
          ))}
        </ol>
      </Disclosure>
    </div>
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
        <button type="button" onClick={() => setFull(f => !f)} aria-expanded={full} data-testid="worker-now-headline-more"
          className="min-h-11 min-w-11 md:min-h-0 md:min-w-0 md:mt-1 text-left font-mono text-chip text-text-secondary hover:text-text-primary">
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
          <div className="flex items-center gap-2 font-mono text-chip font-semibold text-accent-text">
            <span className="w-[9px] h-[9px] bg-accent animate-status-pulse" aria-hidden="true" />
            Now
            {now.updatedTs != null && (
              <span className="font-normal text-text-muted" suppressHydrationWarning>
                · updated {ageLabel(nowMs - now.updatedTs)} ago
              </span>
            )}
          </div>
          <Headline text={now.headline ? collapseWorkspacePath(now.headline) : 'Waiting for the first update'} />
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
        <span className="font-mono text-chip text-text-muted whitespace-nowrap">
          Paused
        </span>
        <span className="ml-auto font-mono text-chip text-text-muted whitespace-nowrap tabular-nums">
          {elapsed && <><b className="text-text-primary font-semibold">{elapsed}</b> · </>}
          {turns} turns
          {tokens && <span className="hidden md:inline"> · {tokens} tok</span>}
        </span>
      </div>
      {evidence && <RunEvidenceRail evidence={evidence} nowMs={nowMs} paused />}
    </div>
  );
}
